/**
 * U6 — shipping / babysitting / compounding gate ordering (R13, R17).
 */
import { test, eq, assert } from "./harness.ts";
import {
	__setRunsRootForTests,
	createRun,
	recordDecision,
	saveCheckpoint,
	upsertChild,
} from "../state.ts";
import {
	advancePhase,
	applyToolResult,
	buildPrompt,
	extractPrUrl,
	isBabysitReady,
	nextAction,
} from "../index.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

const ROOT = join(
	tmpdir(),
	`ace-ship-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
);
__setRunsRootForTests(ROOT);
const fakeCtx = {} as never;

await test("extractPrUrl + isBabysitReady", () => {
	const pr = extractPrUrl(
		"Opened https://github.com/earendil-works/pi/pull/42 ✓",
	);
	eq(pr?.url, "https://github.com/earendil-works/pi/pull/42", "url");
	eq(pr?.number, 42, "number");
	assert(extractPrUrl("no pr here") === undefined, "no match -> undefined");
	assert(isBabysitReady("babysit: ready, PR is merge-ready"), "ready detected");
	assert(!isBabysitReady("waiting on CI"), "not ready");
});

await test("Shipping captures PR URL then advances to Babysitting", () => {
	const st = createRun({ cwd: "/s1", feature: "f" });
	st.phase = "Shipping";
	saveCheckpoint(st.cwd, st);
	applyToolResult(
		{
			toolName: "bash",
			details: { output: "PR https://github.com/o/r/pull/7 opened" },
		},
		st,
		fakeCtx,
	);
	eq(st.prUrl, "https://github.com/o/r/pull/7", "prUrl set");
	eq(st.prNumber, 7, "prNumber set");
	const a = nextAction(st);
	assert(
		a.kind === "advance" && a.to === "Babysitting",
		"advance to Babysitting",
	);
});

await test("Babysitting pauses on a human decision and does not merge automatically", () => {
	const st = createRun({ cwd: "/s2", feature: "f" });
	st.phase = "Babysitting";
	st.prUrl = "https://github.com/o/r/pull/1";
	saveCheckpoint(st.cwd, st);
	applyToolResult(
		{
			toolName: "bash",
			details: { output: "requires human decision: merge approval needed" },
		},
		st,
		fakeCtx,
	);
	assert(
		st.pending.some((p) => p.kind === "pr-decision" && !p.resolved),
		"pr-decision recorded",
	);
	const a = nextAction(st);
	assert(a.kind === "wait", "blocks on human decision");
});

await test("Babysitting advances to Compounding only when merge-ready AND prUrl set", () => {
	const st = createRun({ cwd: "/s3", feature: "f" });
	st.phase = "Babysitting";
	st.prUrl = "https://github.com/o/r/pull/2";
	saveCheckpoint(st.cwd, st);
	// Without ready signal -> advance blocked
	assert(!advancePhase(st, "Compounding"), "blocked without merge-ready");
	st.babysitReady = true;
	saveCheckpoint(st.cwd, st);
	assert(advancePhase(st, "Compounding"), "advances once ready");
	eq(st.phase, "Compounding", "compounding");
	// And nextAction in Compounding queues ce-compound (not babysit)
	const a = nextAction(st);
	assert(
		a.kind === "queue" && /ce-compound/.test(a.text),
		"queues ce-compound",
	);
});

await test("Compounding captures learning artifact then advances to Complete once", () => {
	const proj = join(ROOT, "s4");
	mkdirSync(proj, { recursive: true });
	const st = createRun({ cwd: "/s4", feature: "f" });
	st.phase = "Compounding";
	st.prUrl = "https://github.com/o/r/pull/3";
	st.babysitReady = true;
	saveCheckpoint(st.cwd, st);
	assert(!advancePhase(st, "Complete"), "blocked without learning artifact");
	const learn = join(proj, "docs", "solutions", "feat-x-2026.md");
	mkdirSync(join(proj, "docs", "solutions"), { recursive: true });
	writeFileSync(learn, "# learning");
	applyToolResult({ toolName: "write", input: { path: learn } }, st, fakeCtx);
	eq(st.learningArtifact, learn, "learningArtifact set");
	assert(advancePhase(st, "Complete"), "advances to Complete");
	eq(st.phase, "Complete", "complete");
	assert(st.completedAt, "completedAt set");
	// cannot compound twice / advance again
	assert(!advancePhase(st, "Complete"), "second complete blocked");
	assert(!advancePhase(st, "Compounding"), "completed run can't move back");
});

await test("buildPrompt emits the right skill at each post-review phase", () => {
	const st = createRun({ cwd: "/s5", feature: "f" });
	st.phase = "Shipping";
	assert(
		/ce-commit-push-pr/.test(buildPrompt(st, fakeCtx)),
		"shipping queues ce-commit-push-pr",
	);
	st.prUrl = "https://github.com/o/r/pull/4";
	st.phase = "Babysitting";
	assert(
		/ce-babysit-pr/.test(buildPrompt(st, fakeCtx)),
		"babysitting queues ce-babysit-pr",
	);
	st.babysitReady = true;
	st.phase = "Compounding";
	assert(
		/ce-compound/.test(buildPrompt(st, fakeCtx)),
		"compounding queues ce-compound",
	);
});

await test("ci-failure feedback routes back through debug (state preserves run identity)", () => {
	const st = createRun({ cwd: "/s6", feature: "f" });
	st.phase = "Babysitting";
	st.prUrl = "https://github.com/o/r/pull/5";
	saveCheckpoint(st.cwd, st);
	const runId = st.runId;
	// A CI failure during babysit is a return-to-fix signal; the run keeps its identity.
	applyToolResult(
		{ toolName: "bash", details: { output: "CI failed: run tests" } },
		st,
		fakeCtx,
	);
	eq(st.runId, runId, "run identity preserved");
	// No automatic merge/compound happens on CI failure
	assert(!st.babysitReady, "not marked ready on CI failure");
});

console.log("shipping: ok");
