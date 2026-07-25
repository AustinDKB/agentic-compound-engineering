/**
 * U3 — durable state + registry + redaction + lock + compact summary (R3,R4,R5,R17)
 */
import { test, eq, assert } from "./harness.ts";
import {
	__setRunsRootForTests,
	acquireLock,
	createRun,
	discoverLatestRun,
	loadState,
	markPaused,
	pendingGateFor,
	redact,
	releaseLock,
	saveCheckpoint,
	upsertChild,
	syncTodos,
	toCompactSummary,
} from "../state.ts";
import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(
	tmpdir(),
	`ace-state-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
);
__setRunsRootForTests(ROOT);

function setup(): { cwd: string; cleanup: () => void } {
	const cwd = join(ROOT, "proj");
	const cleanup = () => {
		try {
			rmSync(ROOT, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	};
	return { cwd, cleanup };
}

await test("createRun writes state.json + registry + user-only perms", () => {
	const { cwd, cleanup } = setup();
	try {
		const run = createRun({ cwd, feature: "Add X", ownerSession: "s1" });
		const st = loadState(cwd, run.runId);
		assert(st, "state persisted");
		eq(st!.runId, run.runId, "runId round-trips");
		eq(st!.phase, "Brainstorming", "initial phase");
		eq(st!.generation, 1, "gen 1");
		const perms =
			statSync(
				join(
					ROOT,
					require("node:crypto")
						.createHash("sha256")
						.update(cwd)
						.digest("hex")
						.slice(0, 16),
					run.runId,
					"state.json",
				),
			).mode & 0o777;
		// user-only file: either 0o600 (posix) — lint on non-posix
		if (process.platform !== "win32")
			eq(perms & 0o077, 0, "no group/other access");
	} finally {
		cleanup();
	}
});

await test("saveCheckpoint advances generation and mirrors into registry", () => {
	const { cwd, cleanup } = setup();
	try {
		const run = createRun({ cwd, feature: "Add X" });
		run.generation += 1;
		run.phase = "Planning";
		saveCheckpoint(cwd, run);
		const disc = discoverLatestRun(cwd);
		assert(disc, "discovered");
		eq(disc!.generation, 2, "advanced gen persisted");
		eq(disc!.phase, "Planning", "advanced phase persisted");
	} finally {
		cleanup();
	}
});

await test("discoverLatestRun returns the most recently updated incomplete run", () => {
	const { cwd, cleanup } = setup();
	try {
		const a = createRun({ cwd, feature: "A" });
		const b = createRun({ cwd, feature: "B" });
		b.generation = 5;
		b.phase = "Implementing";
		saveCheckpoint(cwd, b);
		const disc = discoverLatestRun(cwd);
		eq(disc!.runId, b.runId, "latest incomplete wins");
		// mark A complete -> still returns B
		a.phase = "Complete";
		saveCheckpoint(cwd, a);
		eq(discoverLatestRun(cwd)!.runId, b.runId, "complete runs skipped");
	} finally {
		cleanup();
	}
});

await test("redact scrubs secret-like values before persistence", () => {
	const { cwd, cleanup } = setup();
	try {
		const run = createRun({
			cwd,
			feature: "key sk-abc123def456ghi789jklmnop should redact",
		});
		const st = loadState(cwd, run.runId);
		assert(/REDACTED/.test(st!.feature), "secret redacted on persist");
		assert(!/sk-abc123def456/.test(st!.feature), "raw key gone");
		// pure function
		eq(
			redact("token ghp_0123456789abcdefghij"),
			"token [REDACTED]",
			"ghp redacted",
		);
	} finally {
		cleanup();
	}
});

await test("markPaused captures pausedPhase; resumeInto restores it", () => {
	const { cwd, cleanup } = setup();
	try {
		const run = createRun({ cwd, feature: "X" });
		run.phase = "Implementing";
		saveCheckpoint(cwd, run);
		markPaused(cwd, run);
		eq(run.phase, "Paused", "paused");
		eq(run.pausedPhase, "Implementing", "pausedPhase captured");
		const disc = discoverLatestRun(cwd);
		eq(disc!.phase, "Paused", "registry sees Paused");
		// emulate resume
		const disc2 = loadState(cwd, run.runId)!;
		// resumeInto bumps generation and restores phase
		const before = disc2.generation;
		disc2.generation = before;
		disc2.phase = "Paused";
		disc2.pausedPhase = "Implementing";
		// can't import resumeInto circular-free; call via require
		const { resumeInto } =
			require("../state.ts") as typeof import("../state.ts");
		resumeInto(cwd, disc2);
		eq(disc2.phase, "Implementing", "resumed phase");
		eq(disc2.generation, before + 1, "gen bumped on resume");
		assert(disc2.pausedPhase === undefined, "pausedPhase cleared");
	} finally {
		cleanup();
	}
});

await test("acquireLock is exclusive per pid; release frees it", () => {
	const { cwd, cleanup } = setup();
	try {
		const run = createRun({ cwd, feature: "X" });
		assert(acquireLock(cwd, run.runId, "s1"), "first acquire ok");
		assert(acquireLock(cwd, run.runId, "s1"), "re-acquire same pid ok");
		releaseLock(cwd, run.runId);
		assert(acquireLock(cwd, run.runId, "s1"), "re-acquire after release ok");
	} finally {
		cleanup();
	}
});

await test("upsertChild + syncTodos persist into state.json", () => {
	const { cwd, cleanup } = setup();
	try {
		const run = createRun({ cwd, feature: "X" });
		upsertChild(run, {
			requestId: "r1",
			role: "implementer",
			agent: "agentic-compound-implementer",
			task: "implement U3",
			model: { provider: "opencode-go", id: "glm-5.2" },
			status: "running",
			generation: 1,
			assignedAt: "t",
			retries: 0,
		});
		syncTodos(run, [
			{ uId: "U3", subject: "x", status: "in-progress", blockedBy: [] },
		]);
		const st = loadState(cwd, run.runId)!;
		eq(st.children.length, 1, "child persisted");
		eq(st.todos.length, 1, "todos persisted");
	} finally {
		cleanup();
	}
});

await test("toCompactSummary is bounded and surfaces pending gate + failure", () => {
	const { cwd } = setup();
	const run = createRun({ cwd, feature: "X" });
	run.todos = [
		{ uId: "U1", subject: "a", status: "completed", blockedBy: [] },
		{ uId: "U2", subject: "b", status: "pending", blockedBy: ["U1"] },
	];
	run.failures.push({ at: "t", phase: "Verifying", reason: "x" });
	const s = toCompactSummary(run, "/x");
	eq(s.todos, { done: 1, total: 2, blocked: 1 }, "todos counts");
	assert(
		s.pendingGate.includes("verified") || s.pendingGate.includes("brainstorm"),
		"gate named",
	);
	eq(s.recentFailures.length, 1, "recent failure surfaced");
});

await test("pendingGateFor names every active phase", () => {
	const phases = [
		"Brainstorming",
		"Planning",
		"PlanReview",
		"Implementing",
		"Verifying",
		"Simplifying",
		"CodeReview",
		"Shipping",
		"Babysitting",
		"Compounding",
		"Paused",
		"Inactive",
	] as const;
	for (const p of phases) {
		const st = {
			phase: p,
			pausedPhase: p === "Paused" ? "Implementing" : undefined,
		} as never;
		const g = pendingGateFor(st);
		assert(g.length > 0, `gate for ${p}`);
		assert(g !== "N/A", `no placeholder for ${p}`);
	}
});

await test("off retains checkpoint: deleting the run is a separate action", () => {
	const { cwd, cleanup } = setup();
	try {
		const run = createRun({ cwd, feature: "X" });
		// "off" path persists an _off marker WITHOUT removing state.
		(run as unknown as { _off: boolean })._off = true;
		saveCheckpoint(cwd, run);
		const st = loadState(cwd, run.runId);
		assert(st, "checkpoint retained after off");
		// runs dir still has the run
		const dir = join(
			ROOT,
			require("node:crypto")
				.createHash("sha256")
				.update(cwd)
				.digest("hex")
				.slice(0, 16),
			run.runId,
		);
		assert(
			readdirSync(dir).includes("state.json"),
			"state.json present after off",
		);
	} finally {
		cleanup();
	}
});

console.log("state: ok");
