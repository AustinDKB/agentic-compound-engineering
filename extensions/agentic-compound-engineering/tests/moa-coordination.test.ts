/**
 * U2 — MoA suspension-token + child-isolation coordination (R2, R14, R17)
 *
 * Loads the real MoA extension factory against a stub pi surface and asserts
 * the cross-extension suspension contract and child-process isolation.
 */
import {
	test,
	eq,
	assert,
	makeCtx,
	StubPi,
	type StubModelRegistry,
} from "./harness.ts";
// This pi session may itself run as a delegated child, setting
// PI_SUBAGENT_PARENT_SESSION in the tool-call env. That would make MoA's
// child-isolation guard suppress ALL routing and break these tests. Use a
// clean baseline (no child env) for every test, restoring ambient at the end.
const AMBIENT_PARENT_SESSION = process.env.PI_SUBAGENT_PARENT_SESSION;
delete process.env.PI_SUBAGENT_PARENT_SESSION;
import moaFactory, {
	MOA_SUSPEND_EVENT,
	MOA_RELEASE_EVENT,
} from "../../mixture-of-agents.ts";

const OWNER = "agentic-compound-engineering";

// MoA pool is built from MODEL_IDS under opencode-go.
const MOA_MODELS = [
	{ provider: "opencode-go", id: "glm-5.2", name: "glm-5.2" },
	{ provider: "opencode-go", id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
	{ provider: "opencode-go", id: "kimi-k2.7-code", name: "kimi-k2.7-code" },
];

function setup(): { pi: StubPi; ctx: ReturnType<typeof makeCtx> } {
	const pi = new StubPi();
	const ctx = makeCtx({
		registry: MOA_MODELS,
		cwd: "/home/austin",
		model: MOA_MODELS[0],
	});
	(ctx.modelRegistry as unknown as StubModelRegistry).markAllAvailable();
	// OPENCODE_API_KEYS unset -> single-key path (no cloned providers).
	moaFactory(pi as unknown as Parameters<typeof moaFactory>[0]);
	return { pi, ctx };
}

await test("characterization: without suspension, turn_start switches model", async () => {
	const { pi, ctx } = setup();
	await pi.fire("session_start", ctx);
	const before = pi.modelSetCalls.length;
	await pi.fire("turn_start", ctx);
	// pick may equal current model (skip), so at most one new set; but across a
	// few turns a switch should occur given >1 pool model.
	for (let i = 0; i < 6; i++) await pi.fire("turn_start", ctx);
	assert(pi.modelSetCalls.length >= 1, "MoA routed at least once unsuspended");
});

await test("suspension token suppresses per-turn routing", async () => {
	const { pi, ctx } = setup();
	await pi.fire("session_start", ctx);
	pi.modelSetCalls.length = 0;
	pi.events.emit(MOA_SUSPEND_EVENT, OWNER);
	await pi.fire("turn_start", ctx);
	for (let i = 0; i < 6; i++) await pi.fire("turn_start", ctx);
	eq(pi.modelSetCalls.length, 0, "no routing while suspended");
});

await test("releasing the token restores routing when MoA manually enabled", async () => {
	const { pi, ctx } = setup();
	await pi.fire("session_start", ctx);
	pi.events.emit(MOA_SUSPEND_EVENT, OWNER);
	await pi.fire("turn_start", ctx);
	pi.events.emit(MOA_RELEASE_EVENT, OWNER);
	pi.modelSetCalls.length = 0;
	for (let i = 0; i < 6; i++) await pi.fire("turn_start", ctx);
	assert(pi.modelSetCalls.length >= 1, "routing resumed after release");
});

await test("manually disabling MoA while suspended stays disabled after release", async () => {
	const { pi, ctx } = setup();
	await pi.fire("session_start", ctx);
	pi.events.emit(MOA_SUSPEND_EVENT, OWNER);
	// User toggles MoA off via /moa while suspended.
	await pi.commands.get("moa")!.handler("", ctx);
	pi.events.emit(MOA_RELEASE_EVENT, OWNER);
	pi.modelSetCalls.length = 0;
	for (let i = 0; i < 6; i++) await pi.fire("turn_start", ctx);
	eq(pi.modelSetCalls.length, 0, "manual disable persists past release");
});

await test("multiple suspension tokens require ALL owners to release", async () => {
	const { pi, ctx } = setup();
	await pi.fire("session_start", ctx);
	pi.events.emit(MOA_SUSPEND_EVENT, OWNER);
	pi.events.emit(MOA_SUSPEND_EVENT, "other-owner");
	pi.modelSetCalls.length = 0;
	for (let i = 0; i < 4; i++) await pi.fire("turn_start", ctx);
	eq(pi.modelSetCalls.length, 0, "still suppressed with one token held");
	pi.events.emit(MOA_RELEASE_EVENT, OWNER);
	for (let i = 0; i < 4; i++) await pi.fire("turn_start", ctx);
	eq(pi.modelSetCalls.length, 0, "still suppressed until all tokens released");
	pi.events.emit(MOA_RELEASE_EVENT, "other-owner");
	for (let i = 0; i < 6; i++) await pi.fire("turn_start", ctx);
	assert(pi.modelSetCalls.length >= 1, "resumes only after final release");
});

await test("child isolation: PI_SUBAGENT_PARENT_SESSION suppresses routing even when enabled", async () => {
	const { pi, ctx } = setup();
	await pi.fire("session_start", ctx);
	process.env.PI_SUBAGENT_PARENT_SESSION = "test-session-123";
	pi.modelSetCalls.length = 0;
	try {
		for (let i = 0; i < 6; i++) await pi.fire("turn_start", ctx);
		eq(pi.modelSetCalls.length, 0, "child never reroutes");
	} finally {
		delete process.env.PI_SUBAGENT_PARENT_SESSION; // back to the clean baseline
	}
	// sanity: after env cleared, routing resumes
	for (let i = 0; i < 6; i++) await pi.fire("turn_start", ctx);
	assert(
		pi.modelSetCalls.length >= 1,
		"routing resumes once child env cleared",
	);
});

await test("status line reports suspended state", async () => {
	const { pi, ctx } = setup();
	await pi.fire("session_start", ctx);
	pi.events.emit(MOA_SUSPEND_EVENT, OWNER);
	await pi.fire("model_select", ctx);
	const status = ctx.statuses.get("moa") ?? "";
	assert(status.includes("(suspended)"), `status shows suspended: ${status}`);
});

console.log("moa-coordination: ok");

// Restore the ambient parent-session env for the rest of the process.
if (AMBIENT_PARENT_SESSION !== undefined)
	process.env.PI_SUBAGENT_PARENT_SESSION = AMBIENT_PARENT_SESSION;
