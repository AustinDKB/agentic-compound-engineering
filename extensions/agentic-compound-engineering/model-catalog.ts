/**
 * agentic-compound-engineering — multi-provider child model catalog (R15)
 *
 * Replaces the single-provider model-ID assumption with provider-qualified
 * entries so `gpt-5.4-mini` (under `openai-codex`) can coexist with the
 * `opencode-go` pool. `kimi-k2.7-code` is intentionally excluded in favor of
 * `kimi-k3`.
 *
 * Resolution is runtime: entries are checked against `ctx.modelRegistry` and
 * unavailable/unauthenticated entries are warned-once and skipped — mirroring
 * the MoA extension's behavior. Assignment chooses ONE model per child and
 * persists it; the dispatcher never re-randomizes on resume (R14).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CatalogModel, ModelRef } from "./types.ts";

export const CATALOG: readonly CatalogModel[] = [
	{ provider: "opencode-go", id: "glm-5.2", label: "glm-5.2", multiKey: true },
	{
		provider: "opencode-go",
		id: "deepseek-v4-pro",
		label: "deepseek-v4-pro",
		multiKey: true,
	},
	{ provider: "opencode-go", id: "kimi-k3", label: "kimi-k3", multiKey: true },
	{
		provider: "opencode-go",
		id: "grok-4.5",
		label: "grok-4.5",
		multiKey: true,
	},
	{
		provider: "openai-codex",
		id: "gpt-5.4-mini",
		label: "gpt-5.4-mini",
		multiKey: false,
	},
] as const;

/** The five catalog entries that MUST be excluded (regression guard). */
export const EXCLUDED_MODELS = ["kimi-k2.7-code"];

export function modelKey(m: ModelRef | undefined): string | undefined {
	return m ? `${m.provider}/${m.id}` : undefined;
}

/** Minimal registry surface we depend on (duck-typed for tests). */
export interface ModelRegistryLike {
	find(
		provider: string,
		id: string,
	): { provider: string; id: string } | null | undefined;
}

/** Minimal ctx surface for resolveAvailable. */
export interface ResolveCtx {
	modelRegistry: ModelRegistryLike;
}

/**
 * Return catalog entries that resolve to a registered model. Warns once
 * (via the provided warn callback) for each missing entry.
 */
export function resolveAvailable(
	ctx: ResolveCtx,
	warn: (key: string) => void,
	alreadyWarned?: Set<string>,
): CatalogModel[] {
	const seen = alreadyWarned ?? new Set<string>();
	const out: CatalogModel[] = [];
	for (const entry of CATALOG) {
		const key = modelKey(entry)!;
		const model = ctx.modelRegistry.find(entry.provider, entry.id);
		if (model) {
			out.push(entry);
		} else if (!seen.has(key)) {
			seen.add(key);
			warn(key);
		}
	}
	return out;
}

/** Deterministic PRNG (mulberry32) so tests/seeded assignments are reproducible. */
export function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Choose one available catalog entry with a fresh random pick. Accepts a
 * seeded rng for deterministic distribution in tests. Returns `undefined`
 * only if no entries are available.
 *
 * Each spawn independently selects a random model from the available catalog —
 * there is no resume/reuse preference and no persistence of a chosen model for
 * later reuse. (Provider cache locality is intentionally NOT optimized here;
 * the goal is to exercise the whole multi-provider pool across spawns.)
 */
export function pickModel(
	available: readonly CatalogModel[],
	rng: () => number,
): CatalogModel | undefined {
	if (available.length === 0) return undefined;
	const idx = Math.floor(rng() * available.length);
	return available[idx];
}

/** Build a stable list of all catalog keys (for status/verification). */
export function catalogKeys(): string[] {
	return CATALOG.map((m) => modelKey(m)!);
}

export type { CatalogModel };
