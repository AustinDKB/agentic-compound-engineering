/**
 * U2 — model-catalog tests (R15)
 */
import {
	test,
	eq,
	assert,
	makeCtx,
	type StubModelRegistry,
} from "./harness.ts";
import {
	CATALOG,
	EXCLUDED_MODELS,
	catalogKeys,
	resolveAvailable,
	pickModel,
	makeRng,
} from "../model-catalog.ts";

await test("catalog has exactly five provider-qualified entries", () => {
	eq(CATALOG.length, 5, "five catalog entries");
	eq(
		catalogKeys(),
		[
			"opencode-go/glm-5.2",
			"opencode-go/deepseek-v4-pro",
			"opencode-go/kimi-k3",
			"opencode-go/grok-4.5",
			"openai-codex/gpt-5.4-mini",
		],
		"catalog contents",
	);
});

await test("catalog excludes kimi-k2.7-code", () => {
	assert(
		!catalogKeys().some((k) => k.includes("kimi-k2.7-code")),
		"kimi-k2.7-code absent",
	);
	assert(
		EXCLUDED_MODELS.includes("kimi-k2.7-code"),
		"excluded list records it",
	);
});

await test("catalog is multi-provider (opencode-go + openai-codex)", () => {
	const providers = new Set(CATALOG.map((m) => m.provider));
	assert(providers.has("opencode-go"), "opencode-go present");
	assert(providers.has("openai-codex"), "openai-codex present");
	eq(providers.size, 2, "two providers");
});

await test("resolveAvailable warns once + skips unavailable entries", () => {
	const ctx = makeCtx({
		registry: CATALOG.map((m) => ({
			provider: m.provider,
			id: m.id,
			name: m.label,
		})),
	});
	// Only three available.
	const reg = ctx.modelRegistry as unknown as StubModelRegistry;
	reg.markAllAvailable();
	reg.markAvailable("opencode-go", "kimi-k3", false);
	reg.markAvailable("opencode-go", "grok-4.5", false);
	const warned: string[] = [];
	const seen = new Set<string>();
	const avail = resolveAvailable(
		ctx,
		(k) => {
			warned.push(k);
		},
		seen,
	);
	eq(avail.length, 3, "three available after skipping two");
	assert(
		avail.every((m) => m.id !== "kimi-k3" && m.id !== "grok-4.5"),
		"skipped absent ids",
	);
	eq(warned.length, 2, "warned exactly once per missing");
});

await test("resolveAvailable is idempotent for repeated missing entries (warn-once)", () => {
	const ctx = makeCtx({
		registry: CATALOG.map((m) => ({ provider: m.provider, id: m.id })),
	});
	const reg = ctx.modelRegistry as unknown as StubModelRegistry;
	reg.markAvailable("opencode-go", "glm-5.2");
	reg.markAvailable("openai-codex", "gpt-5.4-mini");
	const seen = new Set<string>();
	const warned: string[] = [];
	resolveAvailable(ctx, (k) => warned.push(k), seen);
	resolveAvailable(ctx, (k) => warned.push(k), seen);
	// 3 missing × 1 warn each = 3 total across both calls
	eq(warned.length, 3, "warn-once dedupes across calls");
});

await test("pickModel returns undefined when none available", () => {
	assert(pickModel([], makeRng(1)) === undefined, "empty -> undefined");
});

await test("pickModel distribution exercises every eligible entry (seeded)", () => {
	const avail = CATALOG.slice(); // all 5
	const counts = new Map<string, number>();
	const rng = makeRng(12345);
	for (let i = 0; i < 2000; i++) {
		const m = pickModel(avail, rng)!;
		counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
	}
	const ids = [...counts.keys()];
	eq(ids.length, 5, "all five selected at least once");
	for (const [, n] of counts) assert(n > 0, "non-zero count");
});

await test("pickModel never re-randomizes on resume when prefer resolves (R14 cache reuse)", () => {
	const avail = CATALOG.slice();
	const rng = makeRng(7);
	const first = pickModel(avail, rng)!;
	// Resume with the same model: must return identical assignment.
	const resumed = pickModel(avail, makeRng(999), first)!;
	eq(
		`${resumed.provider}/${resumed.id}`,
		`${first.provider}/${first.id}`,
		"resume keeps model",
	);
});

await test("pickModel falls through to rng when prefer no longer available", () => {
	const avail = CATALOG.slice(0, 2); // glm-5.2, deepseek-v4-pro
	const gone = { provider: "opencode-go", id: "kimi-k3" };
	const pick = pickModel(avail, makeRng(3), gone)!;
	assert(
		avail.some((m) => m.id === pick.id),
		"fell through to an available model",
	);
});

console.log("model-catalog: ok");
