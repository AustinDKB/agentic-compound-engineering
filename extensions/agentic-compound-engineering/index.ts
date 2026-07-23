/**
 * agentic-compound-engineering — global Pi extension (R1, R3, R4, R5, R17)
 *
 * Keeps the main agent on openai-codex/gpt-5.6-sol, persists a resumable
 * Compound Engineering pipeline, and delegates bounded work to one-model-per-run
 * subagents. The extension owns state, commands, dispatch plumbing, and model
 * assignment; the main agent owns judgment (phase transitions are driven by the
 * injected runtime → user-message continuation prompts).
 *
 * Command surface: /agentic-compound-engineering [start|status|pause|resume|off]
 *   start  — create a run (preflight checks), suspend MoA, repin gpt-5.6-sol,
 *            queue the brainstorm continuation.
 *   status — print the compact run summary.
 *   pause  — checkpoint Paused; keep state; release MoA token; suppress prompts.
 *   resume — reacquire MoA token, repin gpt-5.6-sol, continue at pending gate.
 *   off    — suppress prompts + release MoA token, BUT retain the checkpoint
 *            (deleting a run is a separate explicit maintenance action).
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	STATE_CUSTOM_TYPE,
	acquireLock,
	createRun,
	discoverLatestRun,
	loadArtifacts,
	loadState,
	markPaused,
	recordDecision,
	recordFailure,
	releaseLock,
	resumeInto,
	runDir,
	saveCheckpoint,
	setArtifacts,
	syncTodos,
	toCompactSummary,
	upsertChild,
} from "./state.ts";
import { MOA_RELEASE_EVENT, MOA_SUSPEND_EVENT } from "../mixture-of-agents.ts";
import { dispatchChild } from "./dispatcher.ts";
import type {
	ChildRecord,
	ChildRole,
	ChildStatus,
	CompactRunSummary,
	Phase,
	RunState,
	TodoMapping,
} from "./types.ts";

export const CMD = "agentic-compound-engineering";
export const MAIN_MODEL = {
	provider: "openai-codex",
	id: "gpt-5.6-sol",
} as const;
const OWNER_TOKEN = "agentic-compound-engineering";
const STATUS_KEY = "ace";
const OFF_FLAG = "ace-off"; // per-cwd "off" marker persisted in run state

// ── Orchestrator seam (filled by runtime.ts in U5/U6) ──────────────────────
export interface OrchestratorHooks {
	/** Build the bounded continuation prompt for the active phase, or "" if off. */
	buildPrompt(st: RunState, ctx: ExtensionContext): string;
	/** React to a tool_result; may mutate children/todos/state. */
	onToolResult?(
		event: { toolName?: string; details?: unknown },
		st: RunState,
		ctx: ExtensionContext,
	): void;
	/** Whether the runtime can handle the current phase (false => no injection). */
	canDrive(st: RunState): boolean;
}

let runtime: OrchestratorHooks | undefined;

/** Injected by runtime.ts once it exists (U5). No-op default keeps U3 green. */
export function setRuntime(h: OrchestratorHooks): void {
	runtime = h;
}

const noopHooks: OrchestratorHooks = {
	buildPrompt: () => "",
	canDrive: () => false,
};

function hooks(): OrchestratorHooks {
	return runtime ?? noopHooks;
}

// ── Module state (per extension instance) ─────────────────────────────────
let current: RunState | undefined;
let off: boolean = false;
const requireModel = MAIN_MODEL;
let queuedGen = -1; // idempotency guard: last generation we queued a continuation for

function footer(ctx: ExtensionContext): void {
	const st = current;
	if (!st) {
		ctx.ui.setStatus(STATUS_KEY, off ? "ACE: off" : "ACE: inactive");
		return;
	}
	const sus = off ? " off" : "";
	ctx.ui.setStatus(STATUS_KEY, `ACE: ${st.phase}${sus}`);
}

function getOffMarker(st: RunState | undefined): boolean {
	return Boolean(st && (st as unknown as { _off?: boolean })._off);
}

function setOff(v: boolean): void {
	off = v;
	queuedGen = -1;
}

// ── Preflight (R4: fail without advancing when a prerequisite is missing) ──

export interface PreflightResult {
	ok: boolean;
	blockers: string[];
}

export async function preflight(st: {
	ctx: ExtensionContext;
	pi: ExtensionAPI;
}): Promise<PreflightResult> {
	const blockers: string[] = [];
	const { ctx, pi } = st;
	const model = ctx.modelRegistry.find(MAIN_MODEL.provider, MAIN_MODEL.id);
	if (!model)
		blockers.push(
			`main model ${MAIN_MODEL.provider}/${MAIN_MODEL.id} not found in registry`,
		);
	else {
		const auth = await ctx.modelRegistry.getProviderAuth?.(MAIN_MODEL.provider);
		if (!auth || (!auth.auth.apiKey && !auth.auth.headers)) {
			blockers.push(`${MAIN_MODEL.provider} authentication not resolved`);
		}
	}
	// Delegation tool surface.
	const commands = pi.getCommands?.() ?? [];
	const hasSubagent = commands.some((c) =>
		typeof c === "string"
			? c === "subagent"
			: (c as { name?: string }).name === "subagent",
	);
	if (!hasSubagent)
		blockers.push(
			"pi-subagents `subagent` tool not discovered — run `pi install npm:pi-subagents`",
		);
	// Required CE skills on disk.
	const babysit = `${process.env.HOME ?? ""}/.pi/agent/skills/ce-babysit-pr/SKILL.md`;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("node:fs") as typeof import("node:fs");
		if (!fs.existsSync?.(babysit))
			blockers.push("ce-babysit-pr skill bundle missing");
	} catch {
		/* ignore fs probe failures; not fatal */
	}
	return { ok: blockers.length === 0, blockers };
}

// ── MoA coordination (R2) ──────────────────────────────────────────────────

function activateMainModel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): Promise<boolean> {
	const model = ctx.modelRegistry.find(MAIN_MODEL.provider, MAIN_MODEL.id);
	if (!model) return Promise.resolve(false);
	return pi.setModel(model);
}

function suspendMoa(events: { emit: (e: string, d: unknown) => void }): void {
	events.emit(MOA_SUSPEND_EVENT, OWNER_TOKEN);
}

function releaseMoa(events: { emit: (e: string, d: unknown) => void }): void {
	events.emit(MOA_RELEASE_EVENT, OWNER_TOKEN);
}

// ── Continuation queueing (R5: inject ONLY active phase; nothing while off) ──

function queueContinuation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	st: RunState,
): void {
	if (off) return;
	if (!hooks().canDrive(st)) return;
	if (st.generation === queuedGen) return; // already queued
	const prompt = hooks().buildPrompt(st, ctx);
	if (!prompt) return;
	queuedGen = st.generation;
	// Deliver when idle; if streaming, followUp so it runs after current tools.
	pi.sendUserMessage(
		prompt,
		ctx.hasPendingMessages?.() ? { deliverAs: "followUp" } : undefined,
	);
}

/**
 * Drive the next gate action(s) when idle. Advances legal transitions, fires
 * delegated children, and queues a user-message continuation only for
 * main-agent-run phases. Stops on `wait` (in flight) or `queue` (handed to the
 * main agent). Re-pumps when a delegation resolves.
 */
export async function pumpEngine(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	st: RunState,
): Promise<void> {
	if (off || !canDrivePhase(st)) return;
	let guard = 0;
	let action = nextAction(st);
	while (guard++ < 50) {
		if (action.kind === "advance") {
			if (!advancePhase(st, action.to)) return;
			pi.appendEntry(STATE_CUSTOM_TYPE, st);
			footer(ctx);
			if (st.phase === "Complete") {
				releaseMoa(pi.events);
				ctx.ui.notify(`ACE: run ${st.runId} complete`, "info");
			}
			action = nextAction(st);
			continue;
		}
		if (action.kind === "wait") return;
		if (action.kind === "queue") {
			const text = buildPrompt(st, ctx);
			if (text)
				pi.sendUserMessage(
					text,
					ctx.hasPendingMessages?.() ? { deliverAs: "followUp" } : undefined,
				);
			return;
		}
		if (action.kind === "dispatch") {
			const outputPath = `${runDir(st.cwd, st.runId)}/${action.outputPath}`;
			void dispatchChild(
				{
					events: pi.events,
					registry: ctx.modelRegistry as unknown as {
						find(
							p: string,
							i: string,
						): { provider: string; id: string } | null | undefined;
					},
					state: st,
					warn: (k) =>
						ctx.ui.notify(`ACE model ${k} unavailable — skipped`, "warning"),
				},
				{
					role: action.role,
					agent: action.agent,
					task: action.task,
					cwd: st.cwd,
					feature: st.feature,
					outputPath,
					skill: action.skill,
					writeScope: action.writeScope,
				},
			).then((outcome) => {
				if (outcome.backpressure) {
					// Re-pump shortly; capacity may free.
					setTimeout(() => {
						void pumpEngine(pi, ctx, st);
					}, 5_000);
				} else if (outcome.ok) {
					pi.appendEntry(STATE_CUSTOM_TYPE, st);
					void pumpEngine(pi, ctx, st);
				}
			});
			return;
		}
		return;
	}
}

// ── Command handler ─────────────────────────────────────────────────────────

function parseSub(args: string): string {
	return (args ?? "").trim().split(/\s+/)[0] ?? "";
}

async function handleCommand(
	args: string,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<void> {
	const sub = parseSub(args) || "status";
	switch (sub) {
		case "start":
			await cmdStart(ctx, pi);
			break;
		case "status":
			cmdStatus(ctx);
			break;
		case "pause":
			cmdPause(ctx);
			break;
		case "resume":
			cmdResume(ctx, pi);
			break;
		case "off":
			cmdOff(ctx, pi);
			break;
		default:
			ctx.ui.notify(
				`Usage: /${CMD} <start|status|pause|resume|off>`,
				"warning",
			);
			break;
	}
}

function cmdStatus(ctx: ExtensionContext): void {
	if (!current) {
		ctx.ui.notify("ACE: no active run", "info");
		return;
	}
	const summary = toCompactSummary(current, stateDirOf(current));
	ctx.ui.notify(formatSummary(summary), "info");
}

async function cmdStart(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<void> {
	const pf = await preflight({ ctx, pi });
	if (!pf.ok) {
		ctx.ui.notify(`ACE start blocked: ${pf.blockers.join("; ")}`, "error");
		return;
	}
	if (current) {
		ctx.ui.notify(
			`ACE: run ${current.runId} already active (${current.phase})`,
			"warning",
		);
		return;
	}
	const run = createRun({
		cwd: ctx.cwd,
		feature: "Agentic Compound Engineering pipeline",
		ownerSession: ownerOf(ctx),
		moaPrior: undefined, // captured heuristically; restored by release contract
	});
	if (!acquireLock(ctx.cwd, run.runId, ownerOf(ctx))) {
		ctx.ui.notify(
			"ACE: run lock contention — another session owns this run",
			"error",
		);
		return;
	}
	current = run;
	setOff(false);
	suspendMoa(pi.events);
	activateMainModel(pi, ctx);
	saveCheckpoint(ctx.cwd, run);
	pi.appendEntry(STATE_CUSTOM_TYPE, run);
	footer(ctx);
	ctx.ui.notify(`ACE: run ${run.runId} started → ${run.phase}`, "info");
	queueContinuation(pi, ctx, run);
}

function cmdPause(ctx: ExtensionContext): void {
	if (!current) {
		ctx.ui.notify("ACE: no run to pause", "warning");
		return;
	}
	markPaused(ctx.cwd, current);
	releaseMoa(eventsRef);
	ctx.ui.notify(`ACE: paused at ${current.pausedPhase}`, "info");
	footer(ctx);
}

function cmdResume(ctx: ExtensionContext, pi: ExtensionAPI): void {
	if (!current) {
		const found = discoverLatestRun(ctx.cwd);
		if (!found) {
			ctx.ui.notify("ACE: no unfinished run to resume", "warning");
			return;
		}
		current = found;
	}
	if (current.phase !== "Paused" && current.phase !== "Inactive") {
		ctx.ui.notify(`ACE: run already active (${current.phase})`, "info");
		return;
	}
	resumeInto(ctx.cwd, current);
	setOff(false);
	suspendMoa(pi.events);
	activateMainModel(pi, ctx);
	ctx.ui.notify(`ACE: resumed → ${current.phase}`, "info");
	footer(ctx);
	queueContinuation(pi, ctx, current);
}

function cmdOff(ctx: ExtensionContext, pi: ExtensionAPI): void {
	setOff(true);
	if (current) {
		(current as unknown as { _off?: boolean })._off = true;
		saveCheckpoint(ctx.cwd, current);
	}
	releaseMoa(pi.events);
	ctx.ui.notify("ACE: off — prompts suppressed, checkpoint retained", "info");
	footer(ctx);
}

// helpers --------------------------------------------------------------
let eventsRef: { emit: (e: string, d: unknown) => void } = { emit: () => {} };
let piRef: ExtensionAPI;
let ctxRef: ExtensionContext;

function ownerOf(ctx: ExtensionContext): string {
	return (
		(ctx as unknown as { sessionId?: string }).sessionId ??
		process.env.PI_SUBAGENT_PARENT_SESSION ??
		"session"
	);
}

function stateDirOf(st: RunState): string {
	return `${st.cwd}|${st.runId}`;
}

function formatSummary(s: CompactRunSummary): string {
	const lines = [
		`ACE ${s.runId} — phase: ${s.phase} (gen ${s.generation})`,
		`gate: ${s.pendingGate}`,
		s.planPath
			? `plan: ${s.planPath} (${s.planHash?.slice(0, 8) ?? "?"})`
			: "plan: —",
		s.prUrl ? `PR: ${s.prUrl}` : "",
		`todos: ${s.todos.done}/${s.todos.total} done (${s.todos.blocked} blocked)`,
		s.activeChildren.length
			? `children: ${s.activeChildren.map((c) => `${c.role}=${c.model}`).join(", ")}`
			: "",
		s.pendingDecision
			? `PENDING: [${s.pendingDecision.kind}] ${s.pendingDecision.prompt}`
			: "",
		`artifacts: ${s.artifactDir}`,
	];
	return lines.filter(Boolean).join("\n");
}

// ── Orchestration engine (U5) ─────────────────────────────────────────────
// The main agent owns judgment; this pure engine proposes the next micro-step
// and advances legal gated transitions. Child-driven gates auto-advance when the
// child succeeds; main-agent-run phases (writing the plan, opening the PR)
// advance when their side effect is detected in a later tool_result.

/** The agent definition each pipeline child role maps to. */
const CHILD_AGENT: Record<ChildRole, string> = {
	brainstormer: "agentic-compound-brainstormer",
	"research-repo": "ce-repo-research-analyst",
	"research-learnings": "ce-learnings-researcher",
	"research-framework": "ce-framework-docs-researcher",
	"research-best-practices": "ce-best-practices-researcher",
	"research-flow": "ce-spec-flow-analyzer",
	"doc-reviewer": "agentic-compound-doc-reviewer",
	implementer: "agentic-compound-implementer",
	verifier: "agentic-compound-verifier",
	simplifier: "agentic-compound-simplifier",
	"code-reviewer": "agentic-compound-code-reviewer",
};

export type Action =
	| {
			kind: "dispatch";
			role: ChildRole;
			agent: string;
			task: string;
			outputPath: string;
			writeScope?: string[];
			skill?: string | string[];
	  }
	| { kind: "queue"; text: string }
	| { kind: "advance"; to: Phase }
	| { kind: "wait"; reason: string };

const RESEARCH_ROLES: ChildRole[] = [
	"research-repo",
	"research-learnings",
	"research-framework",
	"research-best-practices",
	"research-flow",
];
// Research roles reuse existing CE research AGENTS (no separate skill needed).
const RESEARCH_SKILL: Partial<Record<ChildRole, string>> = {};
const RESEARCH_TASK: Partial<Record<ChildRole, string>> = {
	"research-repo":
		"Repo research: architecture, conventions, patterns relevant to the feature.",
	"research-learnings":
		"Learnings research: relevant docs/solutions/* patterns and pitfalls.",
	"research-framework":
		"Framework research: authoritative docs for frameworks the feature touches.",
	"research-best-practices":
		"Best-practices research: established conventions that apply.",
	"research-flow":
		"Flow/spec analysis: how the feature fits the existing system flow.",
};

/** Phases the engine drives autonomously vs. via queued skill messages. */
const CHILD_DRIVEN = new Set<Phase>([
	"Brainstorming",
	"PlanReview",
	"Verifying",
	"Simplifying",
	"CodeReview",
]);
const MAIN_AGENT_SKILL: Partial<Record<Phase, string>> = {
	Planning: "ce-plan",
	Implementing: "implement",
	Shipping: "ce-commit-push-pr",
	Babysitting: "ce-babysit-pr",
	Compounding: "ce-compound",
};

export function canDrivePhase(st: RunState): boolean {
	return (
		st.phase !== "Inactive" && st.phase !== "Paused" && st.phase !== "Complete"
	);
}

/** Legal-gate map: which phase may advance to which. Anything else blocks. */
const ALLOWED_TRANSITIONS: Record<Phase, Phase[]> = {
	Inactive: ["Brainstorming"],
	Brainstorming: ["Planning", "Paused"],
	Planning: ["PlanReview", "Paused"],
	PlanReview: ["Implementing", "Paused"],
	Implementing: ["Verifying", "Paused"],
	Verifying: ["Implementing", "Simplifying", "Paused"],
	Simplifying: ["CodeReview", "Paused"],
	CodeReview: ["Simplifying", "Shipping", "Paused"],
	Shipping: ["Babysitting", "Paused"],
	Babysitting: ["Shipping", "Compounding", "Paused"],
	Compounding: ["Complete", "Paused"],
	Complete: [],
	Paused: [],
};

/** Advance a phase, enforcing the gate contract; never silently skip. */
export function advancePhase(st: RunState, to: Phase): boolean {
	const allowed = ALLOWED_TRANSITIONS[st.phase] ?? [];
	if (!allowed.includes(to)) {
		recordFailure(
			st,
			st.phase,
			"illegal-transition",
			`attempted ${st.phase} → ${to}`,
		);
		return false;
	}
	if (to === "Implementing" && st.phase === "PlanReview") {
		// Plan gate: todos must exist before implementation can start (R9).
		if (st.todos.length === 0 || !st.planPath) {
			recordFailure(
				st,
				st.phase,
				"plan-not-verified",
				"plan hash not verified + todos not created",
			);
			return false;
		}
	}
	if (to === "Simplifying" && st.phase === "Verifying") {
		if (
			!st.todos.every((t) => t.status === "completed" || t.status === "deleted")
		) {
			recordFailure(st, st.phase, "unverified-units", "not all todos verified");
			return false;
		}
	}
	if (to === "Compounding" && st.phase === "Babysitting") {
		// R13: ce-compound cannot run before the PR-ready gate.
		if (!st.prUrl || !st.babysitReady) {
			recordFailure(st, st.phase, "non-converging", "babysit not merge-ready");
			return false;
		}
	}
	if (to === "Complete" && st.phase === "Compounding") {
		if (!st.learningArtifact) {
			recordFailure(
				st,
				st.phase,
				"non-converging",
				"learning artifact not persisted",
			);
			return false;
		}
		// R13: ce-compound cannot run twice for the same completed run.
		if (st.completedAt) {
			recordFailure(st, st.phase, "non-converging", "run already completed");
			return false;
		}
		st.completedAt = new Date().toISOString();
	}
	st.phase = to;
	st.generation += 1;
	saveCheckpoint(st.cwd, st);
	return true;
}

/** Parse plan Implementation Unit IDs (### U1 ...) + simple dependencies. */
export function parsePlanUIds(planText: string): TodoMapping[] {
	const re = /^###\s*(U\d+)\s*[:——-]?\s*(.+)$/gm;
	const out: TodoMapping[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(planText)) !== null) {
		const uId = m[1];
		const subject = m[2].trim();
		const sec = sliceSection(planText, m.index);
		const deps = [...sec.matchAll(/\b(U\d+)\b/g)]
			.map((x) => x[1])
			.filter((x) => x !== uId);
		out.push({
			uId,
			subject,
			status: "pending",
			blockedBy: [...new Set(deps)],
		});
	}
	return out;
}

function sliceSection(text: string, start: number): string {
	const after = text.slice(start);
	const lines = after.split("\n");
	const out: string[] = [lines[0] ?? ""];
	for (let i = 1; i < lines.length; i++) {
		if (/^#{1,3}\s/.test(lines[i])) break;
		out.push(lines[i]);
	}
	return out.join("\n");
}

/** Create the todo mapping from a verified plan (R9). */
export function todosFromPlan(
	st: RunState,
	planPath: string,
	planHash: string,
): TodoMapping[] {
	const text = (() => {
		try {
			return readFileSyncSafe(planPath);
		} catch {
			return "";
		}
	})();
	const todos = parsePlanUIds(text).map((t) => ({ ...t, planHash }));
	syncTodos(st, todos);
	return todos;
}

function readFileSyncSafe(p: string): string {
	const fs = require("node:fs") as typeof import("node:fs");
	return fs.readFileSync(p, "utf8");
}

/** Hash a plan file's contents for gate sync (R: doc-review against post-Lavish state). */
export function hashPlanFile(planPath: string): string | undefined {
	const fs = require("node:fs") as typeof import("node:fs");
	const crypto = require("node:crypto") as typeof import("node:crypto");
	if (!fs.existsSync?.(planPath)) return undefined;
	return crypto
		.createHash("sha256")
		.update(fs.readFileSync(planPath, "utf8"))
		.digest("hex")
		.slice(0, 16);
}

/** Decide the next micro-step for the active run. Pure + testable (R5). */
export function nextAction(st: RunState): Action {
	switch (st.phase) {
		case "Brainstorming": {
			const done = st.children.some(
				(c) => c.role === "brainstormer" && c.status === "completed",
			);
			if (done) return { kind: "advance", to: "Planning" };
			if (
				st.children.some(
					(c) =>
						c.role === "brainstormer" &&
						(c.status === "running" ||
							c.status === "launched" ||
							c.status === "queued" ||
							c.status === "backpressure"),
				)
			)
				return { kind: "wait", reason: "brainstorm child in flight" };
			return dispatch(
				"brainstormer",
				"Brainstorm the feature; write a requirements digest + unresolved blockers.",
				"brain.md",
				{ skill: "ce-brainstorm" },
			);
		}
		case "Planning": {
			// Research gate (R7): fan out read-only research branches first; they
			// may run concurrently but ALL must settle before the plan gate advances.
			for (const role of RESEARCH_ROLES) {
				if (!st.children.some((c) => c.role === role))
					return dispatch(
						role,
						RESEARCH_TASK[role] ?? `Research: ${role}.`,
						`${role}.md`,
						{
							skill: RESEARCH_SKILL[role],
						},
					);
			}
			const inflight = st.children.filter(
				(c) =>
					RESEARCH_ROLES.includes(c.role) &&
					(c.status === "running" ||
						c.status === "launched" ||
						c.status === "queued" ||
						c.status === "backpressure"),
			);
			if (inflight.length > 0)
				return { kind: "wait", reason: "research branches in flight" };
			if (!st.planPath)
				return queueSkill(
					"ce-plan",
					"Run /ce-plan in pipeline posture (no handoff menu) for the feature, then render via Lavish for review.",
				);
			return { kind: "advance", to: "PlanReview" };
		}
		case "PlanReview": {
			const reviewed = st.children.some(
				(c) => c.role === "doc-reviewer" && c.status === "completed",
			);
			if (reviewed) return { kind: "advance", to: "Implementing" };
			if (!st.planPath) return { kind: "wait", reason: "plan not yet written" };
			if (
				st.children.some(
					(c) =>
						c.role === "doc-reviewer" &&
						(c.status === "running" || c.status === "launched"),
				)
			)
				return { kind: "wait", reason: "doc-review child in flight" };
			return dispatch(
				"doc-reviewer",
				`Review plan ${st.planPath} (hash ${st.planHash ?? "?"}); return accepted findings.`,
				"doc-review.md",
				{ skill: "ce-doc-review" },
			);
		}
		case "Implementing": {
			const nextTodo = st.todos.find(
				(t) =>
					t.status === "pending" &&
					(t.blockedBy.length === 0 ||
						t.blockedBy.every(
							(b) => st.todos.find((x) => x.uId === b)?.status === "completed",
						)),
			);
			if (!nextTodo) return { kind: "advance", to: "Verifying" };
			if (
				st.children.some(
					(c) =>
						c.role === "implementer" &&
						(c.status === "running" || c.status === "launched") &&
						c.task.includes(nextTodo.uId),
				)
			)
				return {
					kind: "wait",
					reason: `implementer for ${nextTodo.uId} in flight`,
				};
			return dispatch(
				"implementer",
				`Implement ${nextTodo.uId}: ${nextTodo.subject}. Read the plan unit's Goal/Files/Approach/Verification.`,
				`${nextTodo.uId}.md`,
				{ skill: "ce-work" },
			);
		}
		case "Verifying": {
			const ip = st.todos.find((t) => t.status === "in-progress");
			if (!ip) {
				// nothing mid-verify: either all done, or none started yet.
				if (
					st.todos.every(
						(t) => t.status === "completed" || t.status === "deleted",
					)
				)
					return { kind: "advance", to: "Simplifying" };
				return { kind: "advance", to: "Implementing" };
			}
			if (
				st.children.some(
					(c) =>
						c.role === "verifier" &&
						(c.status === "running" || c.status === "launched") &&
						c.task.includes(ip.uId),
				)
			)
				return { kind: "wait", reason: `verifier for ${ip.uId} in flight` };
			if (
				st.children.some(
					(c) =>
						c.role === "verifier" &&
						c.status === "failed" &&
						c.task.includes(ip.uId),
				)
			)
				return { kind: "advance", to: "Implementing" }; // reject → retry the unit
			return dispatch(
				"verifier",
				`Verify ${ip.uId}: ${ip.subject}. Requirements/tests/diagnostics/diff. APPROVE or REJECT.`,
				`${ip.uId}-verify.md`,
				{ skill: "ce-code-review" },
			);
		}
		case "Simplifying": {
			if (
				st.children.some(
					(c) =>
						c.role === "simplifier" &&
						(c.status === "running" || c.status === "launched"),
				)
			)
				return { kind: "wait", reason: "simplifier in flight" };
			if (
				st.children.some(
					(c) => c.role === "simplifier" && c.status === "completed",
				)
			)
				return { kind: "advance", to: "CodeReview" };
			return dispatch(
				"simplifier",
				"Simplify recently verified files; preserve behavior.",
				"simplify.md",
				{ skill: "ce-simplify-code" },
			);
		}
		case "CodeReview": {
			const clear = st.children.some(
				(c) => c.role === "code-reviewer" && c.status === "completed",
			);
			if (clear) return { kind: "advance", to: "Shipping" };
			if (
				st.children.some(
					(c) =>
						c.role === "code-reviewer" &&
						(c.status === "running" || c.status === "launched"),
				)
			)
				return { kind: "wait", reason: "code-review child in flight" };
			return dispatch(
				"code-reviewer",
				"Run /ce-code-review over the verified+simplified diff; return required fixes.",
				"code-review.md",
				{ skill: "ce-code-review" },
			);
		}
		case "Shipping": {
			if (st.prUrl) return { kind: "advance", to: "Babysitting" };
			return queueSkill(
				"ce-commit-push-pr",
				"Run /ce-commit-push-pr; open the PR; report the PR URL.",
			);
		}
		case "Babysitting": {
			// Pause on any unresolved human-decision / PR-decision — never merge automatically.
			const pendingHuman = st.pending.find(
				(p) =>
					!p.resolved &&
					(p.kind === "human-decision" || p.kind === "pr-decision"),
			);
			if (pendingHuman)
				return {
					kind: "wait",
					reason: `human decision pending: ${pendingHuman.kind}`,
				};
			if (st.babysitReady) return { kind: "advance", to: "Compounding" };
			return queueSkill(
				"ce-babysit-pr",
				st.prUrl
					? `Run /ce-babysit-pr watch ${st.prUrl}; pause on human decisions.`
					: "Run /ce-babysit-pr watch; pause on human decisions.",
			);
		}
		case "Compounding": {
			if (st.learningArtifact) return { kind: "advance", to: "Complete" };
			return queueSkill(
				"ce-compound",
				"Run /ce-compound to persist the learning; report the artifact path.",
			);
		}
		default:
			return { kind: "wait", reason: `no action for ${st.phase}` };
	}
}

function dispatch(
	role: ChildRole,
	task: string,
	outFile: string,
	opts: { skill?: string | string[]; writeScope?: string[] } = {},
): Action {
	return {
		kind: "dispatch",
		role,
		agent: CHILD_AGENT[role],
		task,
		outputPath: `artifacts/${outFile}`,
		skill: opts.skill,
		writeScope: opts.writeScope,
	};
}

function queueSkill(_skill: string, instruction: string): Action {
	return {
		kind: "queue",
		text: `ACE gate: ${instruction}`,
	};
}

/** Build the bounded continuation prompt for the active phase (R5). Empty if off. */
export function buildPrompt(st: RunState, _ctx: ExtensionContext): string {
	if (!canDrivePhase(st)) return "";
	const a = nextAction(st);
	const head = `ACE ${st.runId} gen=${st.generation} phase=${st.phase} gate:"${gateLabel(st)}"`;
	if (a.kind === "queue") return `${head}\n${a.text}`;
	if (a.kind === "wait") return ""; // wait => do not spam the agent
	if (a.kind === "advance") return ""; // advance handled by engine, no prompt needed
	// dispatch: instruct the main agent to invoke the subagent tool with the role + model pointer
	return `${head}\nDispatch child role=${a.role} agent=${a.agent}. Output mode: file-only (${a.outputPath}). ${a.skill ? `Skill: ${a.skill}. ` : ""}Model is pre-assigned by the catalog — pass it explicitly; do not switch. Then await the child.
Expected artifact: ${a.outputPath}`;
}

function gateLabel(st: RunState): string {
	switch (st.phase) {
		case "Brainstorming":
			return "brainstorm artifact + product-blocker resolution";
		case "Planning":
			return "plan written + Lavish review accepted";
		case "PlanReview":
			return "doc-review accepted + todos created from plan U-IDs";
		case "Implementing":
			return `next unit (${st.todos.filter((t) => t.status === "pending").length} pending)`;
		case "Verifying":
			return "all units verified";
		case "Simplifying":
			return "simplification + targeted re-verify";
		case "CodeReview":
			return "review clear";
		case "Shipping":
			return "PR opened";
		case "Babysitting":
			return "babysit ready (pause on human decision)";
		case "Compounding":
			return "learning persisted";
		default:
			return "idle";
	}
}

/**
 * react to a tool_result: sync the built-in todo tool into state, record child
 * completions from `subagent` results, and auto-advance child-driven gates.
 */
export function applyToolResult(
	event: { toolName?: string; details?: unknown; input?: unknown },
	st: RunState,
	ctx: ExtensionContext,
): void {
	const toolName = event.toolName;
	if (toolName === "todo") {
		const tasks = (
			event.details as
				| {
						tasks?: Array<{
							id: number;
							subject: string;
							status: string;
							blockedBy?: number[];
						}>;
				  }
				| undefined
		)?.tasks;
		if (tasks) mirrorTodos(st, tasks);
		return;
	}
	if (toolName === "subagent") {
		recordSubagentResult(event, st);
		pumpChildGates(st, ctx);
		return;
	}
	// Plan-file detection in the Planning phase (advances to PlanReview).
	if (
		st.phase === "Planning" &&
		(toolName === "write" || toolName === "edit")
	) {
		const path = (event.input as { path?: string } | undefined)?.path ?? "";
		if (/\.md$/.test(path) && fileLooksLikePlan(path)) {
			st.planPath = path;
			st.planHash = hashPlanFile(path) ?? st.planHash;
			saveCheckpoint(st.cwd, st);
		}
		return;
	}
	// Shipping: capture the PR URL/number once created (R13).
	if (st.phase === "Shipping") {
		const txt = toolResultText(event);
		const pr = extractPrUrl(txt);
		if (pr) {
			st.prUrl = pr.url;
			st.prNumber = pr.number;
			saveCheckpoint(st.cwd, st);
		}
		return;
	}
	// Babysitting: detect merge-ready (advance) vs human-decision (pause) (R13).
	if (st.phase === "Babysitting") {
		const txt = toolResultText(event);
		if (
			/human[-_ ]?decision|requires human|authentication failed|gh auth/i.test(
				txt,
			)
		) {
			recordDecision(st, {
				at: new Date().toISOString(),
				kind: "pr-decision",
				prompt:
					"babysit requires a human decision (review/auth/terminal state)",
			});
			return;
		}
		if (isBabysitReady(txt)) {
			st.babysitReady = true;
			saveCheckpoint(st.cwd, st);
		}
		return;
	}
	// Compounding: capture the persisted learning artifact (R13).
	if (
		st.phase === "Compounding" &&
		(toolName === "write" || toolName === "edit")
	) {
		const path = (event.input as { path?: string } | undefined)?.path ?? "";
		if (/docs\/solutions\/.+\.md$/.test(path)) {
			st.learningArtifact = path;
			saveCheckpoint(st.cwd, st);
		}
		return;
	}
}

/** Pull textual content out of a tool_result for signal detection (best-effort). */
function toolResultText(event: { details?: unknown; input?: unknown }): string {
	const d = event.details as
		| { output?: string; stdout?: string; content?: unknown; result?: unknown }
		| undefined;
	const parts: string[] = [];
	if (typeof d?.output === "string") parts.push(d.output);
	if (typeof d?.stdout === "string") parts.push(d.stdout);
	if (typeof d?.result === "string") parts.push(d.result);
	if (Array.isArray(d?.content)) {
		for (const p of d.content as Array<{ text?: string } | string>)
			parts.push(typeof p === "string" ? p : (p?.text ?? ""));
	}
	return parts.join("\n");
}

function mirrorTodos(
	st: RunState,
	tasks: Array<{
		id: number;
		subject: string;
		status: string;
		blockedBy?: number[];
	}>,
): void {
	// The built-in todo tool owns ids; we keep our uId↔todoId mapping in sync.
	const bySubject = new Map(st.todos.map((t) => [t.subject, t]));
	for (const tk of tasks) {
		const match = bySubject.get(tk.subject);
		if (match) {
			match.todoId = tk.id;
			match.status =
				tk.status === "in_progress"
					? "in-progress"
					: ((tk.status as TodoMapping["status"]) ?? match.status);
			if (tk.blockedBy) match.blockedBy = tk.blockedBy.map(String);
		}
	}
	syncTodos(st, st.todos);
}

function recordSubagentResult(
	event: { details?: unknown },
	st: RunState,
): void {
	const d = event.details as
		| {
				runId?: string;
				results?: Array<{
					agent?: string;
					model?: string;
					savedOutputPath?: string;
					sessionFile?: string;
					isError?: boolean;
					exitCode?: number;
					interrupted?: boolean;
					timedOut?: boolean;
				}>;
		  }
		| undefined;
	const result = d?.results?.[0];
	if (!result) return;
	const requestId = d?.runId ?? "";
	const child =
		st.children.find((c) => c.requestId === requestId) ??
		st.children.find((c) => c.role === roleFromAgent(result.agent));
	if (!child) return;
	const ok =
		!result.isError &&
		!result.interrupted &&
		!result.timedOut &&
		(result.exitCode ?? 0) === 0;
	child.status = ok ? "completed" : "failed";
	child.finishedAt = new Date().toISOString();
	if (result.savedOutputPath) {
		const store = loadArtifacts(st.cwd, st.runId);
		store.entries.push({
			requestId: child.requestId,
			role: child.role,
			path: result.savedOutputPath,
			createdAt: new Date().toISOString(),
			bytes: 0,
		});
		setArtifacts(st.cwd, st.runId, store);
		child.artifactPath = result.savedOutputPath;
	}
	if (result.sessionFile) child.sessionFile = result.sessionFile;
	upsertChild(st, child);
	// Map child completion to todo state (R9/R11).
	const uId = uIdOfTask(child.task);
	if (uId) {
		const todo = st.todos.find((t) => t.uId === uId);
		if (todo) {
			if (child.role === "implementer" && ok) todo.status = "in-progress";
			else if (child.role === "verifier" && ok) todo.status = "completed";
			else if (child.role === "verifier" && !ok) todo.status = "pending"; // reject → retry
			syncTodos(st, st.todos);
		}
	}
}

function roleFromAgent(agent?: string): ChildRole | undefined {
	if (!agent) return undefined;
	for (const [role, name] of Object.entries(CHILD_AGENT))
		if (name === agent) return role as ChildRole;
	return undefined;
}

/** Extract the first U\d+ mentioned in a task string. */
export function uIdOfTask(task: string): string | undefined {
	const m = /\b(U\d+)\b/.exec(task);
	return m ? m[1] : undefined;
}

/** Auto-advance child-driven gates when their child succeeded (verifier approve etc.). */
function pumpChildGates(st: RunState, _ctx: ExtensionContext): void {
	if (st.phase === "Verifying") return; // verifier approve handled by todo completion
}

function fileLooksLikePlan(path: string): boolean {
	try {
		const fs = require("node:fs") as typeof import("node:fs");
		const txt = fs.readFileSync?.(path, "utf8") ?? "";
		return (
			/##\s*(Implementation Units|Work Breakdown|Requirements)/.test(txt) ||
			/^###\s*U\d+/m.test(txt)
		);
	} catch {
		return false;
	}
}

/** Pull a GitHub PR URL/number out of a tool result's textual output. */
export function extractPrUrl(
	text: string,
): { url: string; number: number } | undefined {
	const m = text.match(/https?:\/\/github\.com\/[^\s)]+\/pull\/(\d+)/);
	if (!m) return undefined;
	return { url: m[0], number: parseInt(m[1], 10) };
}

/** Detect a babysit merge-ready signal in textual output. */
export function isBabysitReady(text: string): boolean {
	return /merge[-_ ]?ready|babysit[:, ]+ready|PR is ready/i.test(text);
}

// Wire the runtime hooks used by the factory's queue/tool_result handlers.
setRuntime({
	buildPrompt,
	canDrive: canDrivePhase,
	onToolResult: applyToolResult,
});

// ── Factory ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	piRef = pi;

	pi.registerCommand(CMD, {
		description:
			"Drive the agentic Compound Engineering pipeline (start|status|pause|resume|off)",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["start", "status", "pause", "resume", "off"];
			const items = subs.map((s) => ({ value: s, label: s }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			eventsRef = pi.events;
			ctxRef = ctx;
			await handleCommand(args, ctx, pi);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		eventsRef = pi.events;
		ctxRef = ctx;
		off = false;
		queuedGen = -1;
		// Reconstruct from branch first (authoritative), else registry discovery.
		const branch = discoverLatestRun(ctx.cwd);
		current = branch;
		if (current) {
			setOff(getOffMarker(current));
			if (!off && acquireLock(ctx.cwd, current.runId, ownerOf(ctx))) {
				suspendMoa(pi.events);
				activateMainModel(pi, ctx);
			} else if (off) {
				// off => no MoA token, no prompt.
			}
		}
		footer(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (current) releaseLock(current.cwd, current.runId);
		releaseMoa(pi.events);
	});

	// Idle points where the engine pumps the next gate action.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!current || off) return;
		if (!ctx.isIdle?.()) return;
		await pumpEngine(pi, ctx, current);
	});
	pi.on("turn_end", async (_event, ctx) => {
		if (!current || off) return;
		if (ctx.hasPendingMessages?.()) return;
		await pumpEngine(pi, ctx, current);
	});

	// Tool results sync back into state (todos + delegated child responses).
	pi.on("tool_result", async (event, ctx) => {
		if (!current) return;
		hooks().onToolResult?.(event, current, ctx);
		const e = event as { toolName?: string };
		if (e?.toolName === "todo") {
			// todo tool owns task state; mirror into our todo mapping via runtime.
			hooks().onToolResult?.(
				{
					toolName: "todo-sync",
					details: (event as { details?: unknown }).details,
				},
				current,
				ctx,
			);
		}
	});
}
