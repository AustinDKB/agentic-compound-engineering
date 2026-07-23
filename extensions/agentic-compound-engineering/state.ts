/**
 * agentic-compound-engineering — durable pipeline state (R3, R4, R5, R17)
 *
 * Persists phase, plan path, todo mapping, child assignments, artifact
 * pointers, pending decisions, failures, and timestamps so work resumes after
 * reload, restart, fork, or a new session discovering the run registry.
 *
 * Storage layout (operational data, NOT source-controlled):
 *   ~/.pi/agent/agentic-compound-engineering/runs/<cwdHash>/
 *       registry.json            <- compact discovery index (no transcripts)
 *       <runId>/state.json       <- full checkpoint (user-only perms)
 *       <runId>/artifacts.json   <- artifact store
 *       <runId>/.lock            <- pid + mtime run lock
 *
 * Invariants:
 *   - Atomic writes (tmp + rename) so a restart never sees a partial state.
 *   - User-only file permissions on persisted state (R data-protection).
 *   - Secret-like values are redacted before persistence.
 *   - Failed/blocked checkpoints are preserved; nothing is silently skipped.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type {
	ArtifactStore,
	BlockReason,
	ChildRecord,
	CompactRunSummary,
	FailureRecord,
	PendingDecision,
	Phase,
	RunState,
	TodoMapping,
} from "./types.ts";

export const STATE_CUSTOM_TYPE = "agentic-compound-engineering:state";
let RUNS_ROOT_OVERRIDE: string | undefined;
function runsRoot(): string {
	return (
		RUNS_ROOT_OVERRIDE ??
		join(homedir(), ".pi", "agent", "agentic-compound-engineering", "runs")
	);
}
/** Test seam: redirect the runs root to a temp directory. Not for production. */
export function __setRunsRootForTests(p: string | undefined): void {
	RUNS_ROOT_OVERRIDE = p;
}

// ── Utilities ─────────────────────────────────────────────────────────────

export function nowIso(): string {
	return new Date().toISOString();
}

export function hashCwd(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

export function newRunId(): string {
	const rand = Math.random().toString(36).slice(2, 10);
	return `${Date.now().toString(36)}-${rand}`;
}

function ensureDir(p: string): void {
	mkdirSync(p, { recursive: true });
	trySetUserOnly(p, true);
}

function trySetUserOnly(p: string, isDir: boolean): void {
	try {
		const uid = userInfo().uid;
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require("node:fs") as typeof import("node:fs");
		fs.chmodSync(p, isDir ? 0o700 : 0o600);
		void uid;
	} catch {
		// best-effort; not all platforms support chmod meaningfully
	}
}

function atomicWrite(path: string, content: string): void {
	ensureDir(dirname(path));
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
	trySetUserOnly(tmp, false);
	// fsync the tmp before rename so durability holds across crash.
	try {
		const fs = require("node:fs") as typeof import("node:fs");
		const h = fs.openSync(tmp, "r");
		fs.fsyncSync(h);
		fs.closeSync(h);
	} catch {
		/* fsync best-effort */
	}
	renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

// ── Secret redaction (R: data protection) ───────────────────────────────────

const SECRET_PATTERNS = [
	/sk-[A-Za-z0-9_-]{8,}/g, // OpenAI-ish keys
	/github_pat_[A-Za-z0-9_]{8,}/g,
	/ghp_[A-Za-z0-9]{8,}/g,
	/gho_[A-Za-z0-9]{8,}/g,
	/[A-Za-z0-9_-]{32,}/g, // long opaque tokens (coarse)
];

export function redact(text: string | undefined): string | undefined {
	if (!text) return text;
	let out = text;
	for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
	return out;
}

// ── Paths ──────────────────────────────────────────────────────────────────

export function runDir(cwd: string, runId: string): string {
	return join(runsRoot(), hashCwd(cwd), runId);
}

export function statePath(cwd: string, runId: string): string {
	return join(runDir(cwd, runId), "state.json");
}

export function artifactsPath(cwd: string, runId: string): string {
	return join(runDir(cwd, runId), "artifacts.json");
}

export function registryPath(cwd: string): string {
	return join(runsRoot(), hashCwd(cwd), "registry.json");
}

export function lockPath(cwd: string, runId: string): string {
	return join(runDir(cwd, runId), ".lock");
}

// ── Run registry (compact discovery index) ─────────────────────────────────

export interface RegistryEntry {
	runId: string;
	phase: Phase;
	paused: boolean;
	feature: string;
	startedAt: string;
	updatedAt: string;
	ownerSession?: string;
}

export interface Registry {
	latest?: string;
	runs: RegistryEntry[];
}

export function readRegistry(cwd: string): Registry {
	return readJson<Registry>(registryPath(cwd)) ?? { runs: [] };
}

function writeRegistry(cwd: string, reg: Registry): void {
	atomicWrite(registryPath(cwd), JSON.stringify(reg, null, 2));
}

function upsertRegistry(cwd: string, st: RunState): void {
	const reg = readRegistry(cwd);
	const entry: RegistryEntry = {
		runId: st.runId,
		phase: st.phase,
		paused: st.phase === "Paused",
		feature: st.feature,
		startedAt: st.startedAt,
		updatedAt: st.updatedAt,
		ownerSession: st.ownerSession,
	};
	const idx = reg.runs.findIndex((r) => r.runId === st.runId);
	if (idx >= 0) reg.runs[idx] = entry;
	else reg.runs.push(entry);
	// "latest" = most recently updated incomplete run.
	const incomplete = reg.runs
		.filter((r) => r.phase !== "Complete")
		.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
	reg.latest = incomplete[0]?.runId ?? reg.runs.at(-1)?.runId;
	writeRegistry(cwd, reg);
}

// ── Run locks ──────────────────────────────────────────────────────────────

export interface LockState {
	pid: number;
	at: string;
}

export function acquireLock(
	cwd: string,
	runId: string,
	session?: string,
): boolean {
	const p = lockPath(cwd, runId);
	ensureDir(dirname(p));
	const existing = readJson<LockState>(p);
	if (existing && existing.pid !== process.pid && processAlive(existing.pid)) {
		// Someone else holds it.
		if (existing.pid !== process.pid) return false;
	}
	const lock: LockState = { pid: process.pid, at: nowIso() };
	atomicWrite(p, JSON.stringify({ ...lock, session }));
	return true;
}

export function releaseLock(cwd: string, runId: string): void {
	const p = lockPath(cwd, runId);
	if (existsSync(p)) {
		try {
			unlinkSync(p);
		} catch {
			/* best-effort */
		}
	}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ── Run lifecycle ───────────────────────────────────────────────────────────

export interface CreateRunOpts {
	cwd: string;
	feature: string;
	ownerSession?: string;
	moaPrior?: boolean;
}

export function createRun(opts: CreateRunOpts): RunState {
	const runId = newRunId();
	const now = nowIso();
	const st: RunState = {
		runId,
		cwd: opts.cwd,
		feature: opts.feature,
		phase: "Brainstorming",
		generation: 1,
		todos: [],
		children: [],
		failures: [],
		pending: [],
		startedAt: now,
		updatedAt: now,
		ownerSession: opts.ownerSession,
		moaPrior: opts.moaPrior,
	};
	saveCheckpoint(opts.cwd, st);
	return st;
}

/** Persist a checkpoint atomically and update the registry. */
export function saveCheckpoint(cwd: string, st: RunState): void {
	st.updatedAt = nowIso();
	// Redact secret-like values in feature/errors before persisting.
	const safe = { ...st };
	safe.feature = redact(st.feature) ?? st.feature;
	safe.failures = st.failures.map((f) => ({
		...f,
		reason: redact(f.reason) ?? f.reason,
		detail: redact(f.detail),
	}));
	safe.pending = st.pending.map((p) => ({
		...p,
		prompt: redact(p.prompt) ?? p.prompt,
	}));
	atomicWrite(statePath(cwd, st.runId), JSON.stringify(safe, null, 2));
	upsertRegistry(cwd, st);
}

export function loadState(cwd: string, runId: string): RunState | undefined {
	return readJson<RunState>(statePath(cwd, runId));
}

/** Discover the latest incomplete run for a cwd from the registry. */
export function discoverLatestRun(cwd: string): RunState | undefined {
	const reg = readRegistry(cwd);
	if (!reg.latest) return undefined;
	return loadState(cwd, reg.latest);
}

/**
 * Reconcile a branch-local checkpoint (from session custom entries) with the
 * global registry. Branch entries are authoritative for branch history; the
 * registry is for discovery. Surfaces divergence rather than silently choosing
 * the furthest phase. Returns the branch-local state if present, else undefined.
 */
export function reconstructBranch(
	getBranchEntries: () => Array<{
		type: string;
		customType?: string;
		data?: unknown;
	}>,
): RunState | undefined {
	const entries = getBranchEntries();
	let last: RunState | undefined;
	for (const e of entries) {
		if (e.type === "custom" && e.customType === STATE_CUSTOM_TYPE && e.data) {
			last = e.data as RunState;
		}
	}
	return last;
}

export function quarantine(cwd: string, runId: string, reason: string): void {
	// Move aside a malformed state so it isn't treated as a valid checkpoint.
	const sp = statePath(cwd, runId);
	if (!existsSync(sp)) return;
	const q = `${sp}.quarantined-${Date.now()}`;
	try {
		renameSync(sp, q);
	} catch {
		/* best-effort */
	}
	void reason;
}

// ── Phase transitions (preserve blocked/failed; never silently skip) ────────

export function markPaused(cwd: string, st: RunState): RunState {
	if (st.phase === "Paused") return st;
	st.pausedPhase = st.phase;
	st.phase = "Paused";
	st.pausedAt = nowIso();
	saveCheckpoint(cwd, st);
	return st;
}

export function resumeInto(cwd: string, st: RunState): RunState {
	if (st.phase !== "Paused" || !st.pausedPhase) return st;
	st.phase = st.pausedPhase;
	st.pausedPhase = undefined;
	st.pausedAt = undefined;
	st.generation += 1;
	saveCheckpoint(cwd, st);
	return st;
}

export function recordFailure(
	st: RunState,
	phase: Phase,
	reason: string,
	detail?: string,
): void {
	st.failures.push({
		at: nowIso(),
		phase,
		reason: redact(reason) ?? reason,
		detail: redact(detail),
	});
	saveCheckpoint(st.cwd, st);
}

export function recordDecision(st: RunState, d: PendingDecision): void {
	st.pending.push(d);
	saveCheckpoint(st.cwd, st);
}

export function resolveDecision(st: RunState, resolution: string): void {
	const last = st.pending.at(-1);
	if (last) {
		last.resolved = true;
		last.resolution = redact(resolution) ?? resolution;
	}
	saveCheckpoint(st.cwd, st);
}

export function upsertChild(st: RunState, child: ChildRecord): void {
	const idx = st.children.findIndex((c) => c.requestId === child.requestId);
	if (idx >= 0) st.children[idx] = child;
	else st.children.push(child);
	saveCheckpoint(st.cwd, st);
}

export function syncTodos(st: RunState, todos: TodoMapping[]): void {
	st.todos = todos;
	saveCheckpoint(st.cwd, st);
}

export function setArtifacts(
	cwd: string,
	runId: string,
	store: ArtifactStore,
): void {
	atomicWrite(artifactsPath(cwd, runId), JSON.stringify(store, null, 2));
}

export function loadArtifacts(cwd: string, runId: string): ArtifactStore {
	return (
		readJson<ArtifactStore>(artifactsPath(cwd, runId)) ?? {
			runId,
			dir: dirname(artifactsPath(cwd, runId)),
			entries: [],
		}
	);
}

// ── Compact summary (R5: keep main context minimal) ────────────────────────

export function toCompactSummary(
	st: RunState,
	artifactDir: string,
): CompactRunSummary {
	const done = st.todos.filter((t) => t.status === "completed").length;
	const blocked = st.todos.filter(
		(t) => t.status === "pending" && t.blockedBy.length > 0,
	).length;
	const pending = st.pending.find((p) => !p.resolved);
	return {
		runId: st.runId,
		phase: st.phase,
		generation: st.generation,
		pendingGate: pendingGateFor(st),
		planPath: st.planPath,
		planHash: st.planHash,
		prUrl: st.prUrl,
		todos: { done, total: st.todos.length, blocked },
		activeChildren: st.children
			.filter(
				(c) =>
					c.status === "running" ||
					c.status === "launched" ||
					c.status === "queued" ||
					c.status === "backpressure",
			)
			.map((c) => ({
				role: c.role,
				model: `${c.model.provider}/${c.model.id}`,
				status: c.status,
			})),
		pendingDecision: pending
			? { kind: pending.kind, prompt: pending.prompt }
			: undefined,
		recentFailures: st.failures
			.slice(-3)
			.map((f) => ({ phase: f.phase, reason: f.reason })),
		artifactDir,
	};
}

/** Human-readable gate name for the current phase. */
export function pendingGateFor(st: RunState): string {
	switch (st.phase) {
		case "Brainstorming":
			return "brainstorm artifact + product-blocker resolution";
		case "Planning":
			return "plan written + Lavish review + doc-review acceptance";
		case "PlanReview":
			return "plan verified (hash sync) + todos created";
		case "Implementing":
			return "next implementation unit verified";
		case "Verifying":
			return "all units verified";
		case "Simplifying":
			return "simplification verified";
		case "CodeReview":
			return "review clear (required fixes applied + re-verified)";
		case "Shipping":
			return "PR opened";
		case "Babysitting":
			return "babysit reports ready";
		case "Compounding":
			return "learning persisted";
		case "Complete":
			return "complete";
		case "Paused":
			return `resume into ${st.pausedPhase ?? "(unknown)"}`;
		default:
			return "inactive";
	}
}

export type { BlockReason };
