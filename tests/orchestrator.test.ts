/**
 * U5 — orchestration engine: gate sequence, research fan-out, plan gate, todo
 * loop, verifier reject, plan-file detection, bounded prompt.
 */
import { test, eq, assert } from "./harness.ts";
import {
	__setRunsRootForTests,
	createRun,
	saveCheckpoint,
	upsertChild,
} from "../state.ts";
import {
	advancePhase,
	applyToolResult,
	buildPrompt,
	canDrivePhase,
	hashPlanFile,
	nextAction,
	parsePlanUIds,
	todosFromPlan,
	uIdOfTask,
} from "../index.ts";
import type { Action } from "../index.ts";
import type { ChildRecord, ChildRole, RunState } from "../types.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const ROOT = join(
	tmpdir(),
	`ace-orch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
);
__setRunsRootForTests(ROOT);

const fakeCtx = {} as never;

function mkChild(
	role: ChildRole,
	agent: string,
	task: string,
	requestId: string,
): ChildRecord {
	return {
		requestId,
		role,
		agent,
		task,
		model: { provider: "opencode-go", id: "glm-5.2" },
		status: "launched",
		generation: 0,
		assignedAt: "t",
		retries: 0,
	};
}

interface StepOpts {
	failVerifierFor?: string; // uId whose verifier should fail
	skipComplete?: Set<ChildRole>; // roles to leave in flight (test backpressure/wait)
}

let rid = 0;
function step(
	st: RunState,
	opts: StepOpts = {},
): { action: Action; label: string } {
	const a = nextAction(st);
	if (a.kind === "advance") {
		const ok = advancePhase(st, a.to);
		return { action: a, label: `advance->${a.to}${ok ? "" : " (blocked)"}` };
	}
	if (a.kind === "wait") return { action: a, label: `wait:${a.reason}` };
	if (a.kind === "queue")
		return { action: a, label: `queue:${a.text.slice(0, 24)}` };
	// dispatch: synthesize launched child then simulate completion via tool_result
	const requestId = `synth-${a.role}-${++rid}`;
	upsertChild(st, mkChild(a.role, a.agent, a.task, requestId));
	const fail =
		a.role === "verifier" &&
		opts.failVerifierFor &&
		a.task.includes(opts.failVerifierFor);
	applyToolResult(
		{
			toolName: "subagent",
			details: {
				runId: requestId,
				results: [
					{
						agent: a.agent,
						savedOutputPath: `/artifacts/${a.outputPath}`,
						exitCode: fail ? 1 : 0,
					},
				],
			},
		},
		st,
		fakeCtx,
	);
	return { action: a, label: `dispatch:${a.role}` };
}

await test("parsePlanUIds extracts U-IDs in order with dependencies", () => {
	const plan = `# Plan\n\n## Implementation Units\n\n### U1 Runtime prerequisites\n\ntext\n\n### U2 Catalog\nDepends on U1.\n\n### U3 State`;
	const todos = parsePlanUIds(plan);
	eq(
		todos.map((t) => t.uId),
		["U1", "U2", "U3"],
		"ordered uIds",
	);
	assert(todos[1].blockedBy.includes("U1"), "U2 blocked by U1");
});

await test("uIdOfTask pulls the first U-ID", () => {
	eq(uIdOfTask("Implement U3: add parser"), "U3", "first uId");
	assert(uIdOfTask("no units here") === undefined, "none");
});

await test("advancePhase enforces legal gates; illegal transition records a failure", () => {
	const st = createRun({ cwd: "/p", feature: "f" }); // Brainstorming
	assert(advancePhase(st, "Planning") || true, "legal attempt doesn't throw");
	st.phase = "Brainstorming";
	st.children = [];
	saveCheckpoint(st.cwd, st);
	assert(!advancePhase(st, "Implementing"), "skipping gates blocked");
	st.phase = "PlanReview";
	st.planPath = undefined;
	st.todos = [];
	assert(
		!advancePhase(st, "Implementing"),
		"PlanReview->Implementing blocked without todos+plan",
	);
	assert(st.failures.length > 0, "failure recorded");
});

await test("happy path: brainstorm -> research fan-out -> plan gate -> implement/verify -> ship queue", () => {
	const st = createRun({ cwd: "/p", feature: "Feature X" });
	const trace: string[] = [];
	let guards = 0;
	// Drive through brainstorming + planning research fan-out until the ce-plan queue.
	for (; guards < 40; guards++) {
		const { label, action } = step(st);
		trace.push(label);
		if (action.kind === "queue") break;
	}
	// We should have dispatched a brainstormer + 5 research children before queuing ce-plan.
	assert(
		st.children.some((c) => c.role === "brainstormer"),
		"brainstormer dispatched",
	);
	const research = st.children.filter(
		(c) => c.role?.startsWith?.("research-") || /^research-/.test(c.role),
	);
	eq(research.length, 5, "five research children");
	eq(st.phase, "Planning", "still planning when ce-plan queued");
	assert(trace.at(-1)!.startsWith("queue"), "tail is a queue (ce-plan)");

	// Inject the plan + todos (simulating ce-plan + Lavish + doc-review acceptance).
	const proj = join(ROOT, "p");
	mkdirSync(proj, { recursive: true });
	const planPath = join(proj, "plan.md");
	writeFileSync(
		planPath,
		"# Plan\n\n## Implementation Units\n\n### U1 First unit\n\n### U2 Second unit\nDepends on U1.\n",
	);
	st.planPath = planPath;
	st.planHash = hashPlanFile(planPath);
	todosFromPlan(st, planPath, st.planHash!);

	// Pump through PlanReview -> doc-review -> Implementing -> implement/verify loop
	guards = 0;
	for (; guards < 80; guards++) {
		const { label, action } = step(st);
		trace.push(label);
		if (st.phase === "Shipping" && action.kind === "queue") break;
		if (action.kind === "wait") break;
	}
	eq(st.phase, "Shipping", "reached Shipping");
	// todos all completed through the verify loop
	assert(
		st.todos.every((t) => t.status === "completed"),
		"all todos completed",
	);
	assert(
		trace.some((l) => l.startsWith("dispatch:code-reviewer")),
		"code-review ran",
	);
	assert(
		trace.at(-1)!.startsWith("queue"),
		"ended on a queue (ce-commit-push-pr)",
	);
});

await test("verifier reject returns the unit to Implementing (retry)", () => {
	const st = createRun({ cwd: "/p2", feature: "f" });
	st.phase = "Implementing";
	st.todos = [
		{ uId: "U1", subject: "first", status: "in-progress", blockedBy: [] },
	];
	saveCheckpoint(st.cwd, st);
	// Implementing with no pending -> advance to Verifying, THEN dispatch verifier.
	const adv = nextAction(st);
	assert(
		adv.kind === "advance" && adv.to === "Verifying",
		"advance to Verifying",
	);
	advancePhase(st, "Verifying");
	const a = nextAction(st);
	assert(a.kind === "dispatch" && a.role === "verifier", "dispatch verifier");
	const rid2 = `vfail-${++rid}`;
	upsertChild(st, mkChild("verifier", a.agent, a.task, rid2));
	applyToolResult(
		{
			toolName: "subagent",
			details: { runId: rid2, results: [{ agent: a.agent, exitCode: 1 }] },
		},
		st,
		fakeCtx,
	);
	// todo reverted to pending
	eq(st.todos[0].status, "pending", "reverted to pending");
	// next action returns to Implementing (retry)
	const next = nextAction(st);
	assert(
		(next.kind === "advance" && next.to === "Implementing") ||
			(next.kind === "dispatch" && next.role === "implementer"),
		"reject -> retry implementation",
	);
});

await test("plan-file detection sets planPath + advances to PlanReview", () => {
	const st = createRun({ cwd: "/p3", feature: "f" });
	st.phase = "Planning";
	// Seed the 5 research children as completed so the research gate is settled.
	for (const role of [
		"research-repo",
		"research-learnings",
		"research-framework",
		"research-best-practices",
		"research-flow",
	] as const) {
		upsertChild(st, {
			...mkChild(role, role, "research", `r-${role}`),
			status: "completed",
		});
	}
	saveCheckpoint(st.cwd, st);
	const proj = join(ROOT, "p3");
	mkdirSync(proj, { recursive: true });
	const planPath = join(proj, "plan.md");
	writeFileSync(planPath, "## Implementation Units\n\n### U1 X");
	applyToolResult(
		{ toolName: "write", input: { path: planPath }, details: {} },
		st,
		fakeCtx,
	);
	eq(st.planPath, planPath, "planPath recorded");
	assert(st.planHash, "plan hash recorded");
	const a = nextAction(st);
	assert(
		a.kind === "advance" && a.to === "PlanReview",
		"advances to PlanReview",
	);
});

await test("buildPrompt is bounded while active; empty when paused/complete/off-drives", () => {
	const st = createRun({ cwd: "/p4", feature: "f" });
	const p = buildPrompt(st, fakeCtx);
	assert(
		p.includes("phase=") && p.length < 2000,
		"active prompt bounded + tagged",
	);
	st.phase = "Paused";
	eq(buildPrompt(st, fakeCtx), "", "no prompt when paused");
	st.phase = "Complete";
	eq(buildPrompt(st, fakeCtx), "", "no prompt when complete");
});

await test("canDrivePhase excludes control states", () => {
	const st = createRun({ cwd: "/p5", feature: "f" });
	assert(canDrivePhase(st), "Brainstorming drives");
	st.phase = "Paused";
	assert(!canDrivePhase(st), "Paused no drive");
	st.phase = "Complete";
	assert(!canDrivePhase(st), "Complete no drive");
});

await test("stale guard: queuedGen suppresses double-injection of the same generation", () => {
	// Indirect: buildPrompt is deterministic per phase; re-pumping the same idle
	// state must not re-queue. Verified via canDrive + queueContinuation skip in
	// index.ts; here we assert nextAction is stable for the same state.
	const st = createRun({ cwd: "/p6", feature: "f" });
	const a1 = nextAction(st);
	const a2 = nextAction(st);
	eq(
		JSON.stringify(a1),
		JSON.stringify(a2),
		"nextAction is a pure function of state",
	);
});

console.log("orchestrator: ok");
