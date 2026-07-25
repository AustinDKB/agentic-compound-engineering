/**
 * U4 — dispatcher: fixed-model delegation, backpressure, writer overlap,
 * artifact isolation, per-spawn random model (R5,R10,R11,R12,R15).
 */
import { test, eq, assert, StubEvents, StubModelRegistry } from "./harness.ts";
import {
	dispatchChild,
	selectModelFor,
	detectWriterConflict,
} from "../dispatcher.ts";
import {
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
} from "../delegation-constants.ts";
import {
	__setRunsRootForTests,
	createRun,
	loadState,
	upsertChild,
	loadArtifacts,
} from "../state.ts";
import { CATALOG } from "../model-catalog.ts";
import type { RunState } from "../types.ts";
import { makeRng } from "../model-catalog.ts";

import { tmpdir } from "node:os";
import { join } from "node:path";
const ROOT = join(
	tmpdir(),
	`ace-disp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
);
__setRunsRootForTests(ROOT);

function makeRegistry(): StubModelRegistry {
	const reg = new StubModelRegistry(
		CATALOG.map((m) => ({ provider: m.provider, id: m.id })),
	);
	reg.markAllAvailable();
	return reg;
}

function freshRun(cwd: string): RunState {
	return createRun({ cwd, feature: "f" });
}

interface Captured {
	requestId: string;
	agent: string;
	task: string;
	model: string;
	outputMode?: string;
	cwd: string;
}

await test("happy path: dispatch selects one catalog model and persists it before launch", async () => {
	const events = new StubEvents();
	const reg = makeRegistry();
	const st = freshRun("/proj");
	// capture the request synchronously as it's emitted
	let captured: Captured | undefined;
	events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (d: unknown) => {
		const r = d as Captured & { requestId: string };
		captured = {
			requestId: r.requestId,
			agent: r.agent,
			task: r.task,
			model: r.model,
			outputMode: (d as { outputMode?: string }).outputMode,
			cwd: r.cwd,
		};
	});
	const promise = dispatchChild(
		{ events, registry: reg as unknown as never, state: st, warn: () => {} },
		{
			role: "brainstormer",
			agent: "agentic-compound-brainstormer",
			task: "brainstorm X",
			cwd: "/proj",
			feature: "f",
			outputPath: "/out/brain.md",
			skill: "ce-brainstorm",
		} as never,
	);
	// Before response: child record persisted with its freshly-picked model.
	const queued = st.children.at(-1);
	assert(queued, "child persisted before response");
	assert(
		CATALOG.some(
			(m) => m.provider === queued!.model.provider && m.id === queued!.model.id,
		),
		"model from catalog",
	);
	// emit completed response
	assert(captured, "request emitted");
	eq(captured!.outputMode, "file-only", "file-only output");
	events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
		requestId: captured!.requestId,
		status: "completed",
		outputPath: "/out/brain.md",
	});
	const outcome = await promise;
	assert(outcome.ok, "completed ok");
	eq(outcome.status, "completed", "status completed");
	eq(
		`${outcome.model.provider}/${outcome.model.id}`,
		captured!.model,
		"outcome model matches request",
	);
});

await test("artifact store records the child output path; full transcript stays off-context", async () => {
	const events = new StubEvents();
	const reg = makeRegistry();
	const st = freshRun("/proj");
	let reqId = "";
	events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (d: unknown) => {
		reqId = (d as { requestId: string }).requestId;
	});
	const p = dispatchChild(
		{ events, registry: reg as unknown as never, state: st, warn: () => {} },
		{
			role: "verifier",
			agent: "agentic-compound-verifier",
			task: "verify U3",
			cwd: "/proj",
			feature: "f",
			outputPath: "/out/v.md",
		} as never,
	);
	events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
		requestId: reqId,
		status: "completed",
		outputPath: "/out/v.md",
	});
	const out = await p;
	eq(out.artifactPath, "/out/v.md", "artifact path returned");
	const arts = loadArtifacts(st.cwd, st.runId);
	assert(
		arts.entries.some((e) => e.requestId === reqId),
		"artifact entry persisted",
	);
});

await test("backpressure (unavailable_context) is NOT task failure; same model preserved", async () => {
	const events = new StubEvents();
	const reg = makeRegistry();
	const st = freshRun("/proj");
	let reqId = "";
	events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (d: unknown) => {
		reqId = (d as { requestId: string }).requestId;
	});
	const p = dispatchChild(
		{ events, registry: reg as unknown as never, state: st, warn: () => {} },
		{
			role: "research-repo",
			agent: "ce-repo-research-analyst",
			task: "scan repo",
			cwd: "/proj",
			feature: "f",
			outputPath: "/out/r.md",
		} as never,
	);
	events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
		requestId: reqId,
		status: "unavailable_context",
	});
	const out = await p;
	eq(out.backpressure, true, "backpressure flagged");
	assert(!out.ok, "not ok");
	eq(out.status, "backpressure", "child status backpressure");
	const child = st.children.find((c) => c.requestId === reqId);
	eq(child!.status, "backpressure", "persisted backpressure");
});

await test("detectWriterConflict rejects parallel writers on overlapping files", () => {
	const st = freshRun("/proj");
	upsertChild(st, {
		requestId: "r-running",
		role: "implementer",
		agent: "agentic-compound-implementer",
		task: "U1",
		model: { provider: "opencode-go", id: "glm-5.2" },
		status: "running",
		generation: 1,
		assignedAt: "t",
		retries: 0,
		writeScope: ["src/a.ts", "src/b.ts"],
	} as never);
	const conflicts = detectWriterConflict(st, "implementer", [
		"src/b.ts",
		"src/c.ts",
	]);
	eq(conflicts.length, 1, "overlap detected on src/b.ts");
	const none = detectWriterConflict(st, "implementer", [
		"src/c.ts",
		"src/d.ts",
	]);
	eq(none.length, 0, "disjoint ok");
	// read-only roles never conflict
	eq(
		detectWriterConflict(st, "verifier", ["src/a.ts"]).length,
		0,
		"verifier never conflicts",
	);
});

await test("writer overlap blocks dispatch (failed outcome, not launched)", async () => {
	const events = new StubEvents();
	const reg = makeRegistry();
	const st = freshRun("/proj");
	upsertChild(st, {
		requestId: "r-running",
		role: "implementer",
		agent: "agentic-compound-implementer",
		task: "U1",
		model: { provider: "opencode-go", id: "glm-5.2" },
		status: "running",
		generation: 1,
		assignedAt: "t",
		retries: 0,
		writeScope: ["src/a.ts"],
	} as never);
	const out = await dispatchChild(
		{ events, registry: reg as unknown as never, state: st, warn: () => {} },
		{
			role: "implementer",
			agent: "agentic-compound-implementer",
			task: "U2",
			cwd: "/proj",
			feature: "f",
			writeScope: ["src/a.ts"],
			outputPath: "/out/u2.md",
		} as never,
	);
	assert(!out.ok, "conflict dispatch not ok");
	eq(out.status, "failed", "failed");
	assert(
		(out.error ?? "").includes("overlapping writers"),
		"conflict error surfaced",
	);
});

await test("selectModelFor picks a fresh random model per spawn (no prefer/reuse)", () => {
	const reg = makeRegistry();
	const seen = new Set<string>();
	for (let i = 0; i < 40; i++) {
		const m = selectModelFor(reg as unknown as never, () => {}, makeRng(i + 1))!;
		assert(CATALOG.some((c) => c.id === m.id), "picked a catalog model");
		seen.add(m.id);
	}
	// 40 independent spawns from a 5-model pool must hit more than one model.
	assert(seen.size > 1, `saw ${seen.size} distinct models across 40 spawns (expected >1)`);
});

await test("child isolation: request carries an explicit model string (no per-turn routing)", async () => {
	const events = new StubEvents();
	const reg = makeRegistry();
	const st = freshRun("/proj");
	let modelStr = "";
	events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (d: unknown) => {
		modelStr = (d as { model: string }).model;
	});
	const p = dispatchChild(
		{ events, registry: reg as unknown as never, state: st, warn: () => {} },
		{
			role: "simplifier",
			agent: "agentic-compound-simplifier",
			task: "simplify",
			cwd: "/proj",
			feature: "f",
			outputPath: "/out/s.md",
		} as never,
	);
	events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
		requestId: (st.children.at(-1) as { requestId: string }).requestId,
		status: "completed",
	});
	await p;
	assert(
		/^[a-z]+-[a-z]+\//.test(modelStr),
		`provider-qualified model: ${modelStr}`,
	);
});

await test("no available model yields a failed outcome without emitting a request", async () => {
	const events = new StubEvents();
	const reg = new StubModelRegistry(
		CATALOG.map((m) => ({ provider: m.provider, id: m.id })),
	); // nothing available
	const st = freshRun("/proj");
	let emitted = false;
	events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => {
		emitted = true;
	});
	const out = await dispatchChild(
		{ events, registry: reg as unknown as never, state: st, warn: () => {} },
		{
			role: "brainstormer",
			agent: "agentic-compound-brainstormer",
			task: "x",
			cwd: "/proj",
			feature: "f",
			outputPath: "/o",
		} as never,
	);
	assert(!emitted, "no request emitted when model missing");
	assert(!out.ok && !out.backpressure, "plain failure");
	assert((out.error ?? "").includes("no available model"), "informative error");
});

console.log("dispatcher: ok");
