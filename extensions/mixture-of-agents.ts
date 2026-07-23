/**
 * Mixture of Agents (MoA) Extension — multi-API-key edition
 *
 * Each turn, randomly route the LLM call to one model from a configurable
 * pool. The pool is defined below as { provider, id, label } entries — the
 * models must already be configured (via ~/.pi/agent/models.json, another
 * extension, or a built-in provider). This extension only does the routing.
 *
 * Behavior:
 * - On `turn_start` (fires before each LLM call), pick a random model from
 *   the pool and `pi.setModel()` it. If the pick equals the current model,
 *   the switch is skipped (no redundant notification).
 * - Footer status line shows the active MoA model: "MoA: <label>".
 * - A brief notification fires on each actual switch.
 * - `/moa` toggles the mixture on/off and reports state + pool.
 * - `--no-moa` flag starts the session with MoA disabled.
 *
 * ── Multiple OpenCode Go API keys ──────────────────────────────────────────
 *
 * OpenCode Zen Go normally accepts a single API key (auth.json "opencode-go" or
 * $OPENCODE_API_KEY). To rotate across several keys — for rate-limit / quota
 * distribution — this extension registers a *separate cloned provider* per key
 * (`opencode-go-key1`, `opencode-go-key2`, …), each carrying the same model
 * definitions but a different `apiKey`. The MoA pool is then built from the
 * cross-product of {keys} × {model ids}, so every rotation also rotates the
 * underlying API key.
 *
 * Configure the keys via EITHER:
 *   - env var (preferred, keeps secrets out of the file):
 *       export OPENCODE_API_KEYS="sk-aaa,sk-bbb,sk-ccc"
 *   - the OPENCODE_KEYS array below (rare; don't commit secrets).
 *
 * When no keys are configured, the extension falls back to the single built-in
 * `opencode-go` provider (original behavior).
 *
 * Model definitions are cloned at runtime from the built-in `opencode-go`
 * provider via `ctx.modelRegistry.find(...)`, so cost / contextWindow / compat
 * / thinkingLevelMap stay in sync with pi releases automatically.
 *
 * Usage:
 *   pi                                # MoA on by default, single key
 *   OPENCODE_API_KEYS="sk-a,sk-b" pi  # MoA rotating across multiple keys
 *   pi --no-moa                       # start disabled
 *   /moa                              # toggle / show state
 *
 * Place at ~/.pi/agent/extensions/mixture-of-agents.ts (global) or
 * .pi/extensions/mixture-of-agents.ts (project-local) for auto-discovery.
 * Hot-reload with /reload.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

// ───────────────────────────────────────────────────────────────────────────
// Pool configuration — edit MODEL_IDS to match the models you want mixed.
// Each entry is a model id under the built-in `opencode-go` provider.
// ───────────────────────────────────────────────────────────────────────────
const MODEL_IDS = ["glm-5.2", "deepseek-v4-pro", "kimi-k2.7-code"] as const;

// ───────────────────────────────────────────────────────────────────────────
// API keys — populate ONE of:
//   - env var OPENCODE_API_KEYS (comma-separated, preferred)
//   - the array below (rare; avoid committing secrets)
// When empty, the extension uses the built-in `opencode-go` provider only.
// ───────────────────────────────────────────────────────────────────────────
const OPENCODE_KEYS: string[] = (process.env.OPENCODE_API_KEYS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);

const BUILTIN_PROVIDER = "opencode-go";
const STATUS_KEY = "moa";

interface MoaEntry {
	provider: string;
	id: string;
	label: string;
}

// Module-scoped state (rebound on session_start; reset on reload).
let enabled = true;
let warnedMissing = new Set<string>();
let lastPickedKey: string | undefined;
let moaPool: MoaEntry[] = [];

// Suspension-token contract (R2): while any owner holds a token, per-turn
// routing is suppressed without mutating the user's manual `enabled`
// preference. Releasing the last token restores routing ONLY when MoA was
// manually enabled — manual-disable-stays-disabled is preserved automatically
// because suspension never touches `enabled`. Consumed by
// agentic-compound-engineering via the shared `pi.events` bus.
let suspensionTokens = new Set<string>();

// Event names for the cross-extension suspension contract. Exported as plain
// string constants so an importer can stay in sync without a hard dependency.
export const MOA_SUSPEND_EVENT = "moa:suspend";
export const MOA_RELEASE_EVENT = "moa:release";

function modelKey(
	m: { provider: string; id: string } | undefined,
): string | undefined {
	return m ? `${m.provider}/${m.id}` : undefined;
}

function pickRandom<T>(arr: readonly T[]): T {
	return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Convert a registered Model into the ProviderModelConfig shape accepted by
 * pi.registerProvider. Clones cost / contextWindow / maxTokens / thinkingLevelMap
 * / compat so the per-key provider behaves identically to the built-in one.
 */
function modelToProviderConfig(m: Model<Api>) {
	return {
		id: m.id,
		name: m.name,
		api: m.api,
		baseUrl: m.baseUrl,
		reasoning: m.reasoning,
		thinkingLevelMap: m.thinkingLevelMap,
		input: m.input,
		cost: m.cost,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		compat: m.compat as Record<string, unknown> | undefined,
	};
}

/** Update the footer status to reflect the active model + MoA state. */
function updateStatus(ctx: ExtensionContext) {
	const cur = ctx.model;
	const label =
		moaPool.find((e) => e.provider === cur?.provider && e.id === cur?.id)
			?.label ??
		cur?.id ??
		"no model";
	const keysInfo =
		OPENCODE_KEYS.length > 0 ? ` · ${OPENCODE_KEYS.length} keys` : "";
	const sus = suspensionTokens.size > 0 ? " (suspended)" : "";
	ctx.ui.setStatus(
		STATUS_KEY,
		enabled ? `MoA: ${label}${keysInfo}${sus}` : `MoA: off (${label})`,
	);
}

/**
 * Register one cloned provider per configured API key and build the MoA pool
 * as the cross-product of {keys} × {model ids}. With no keys configured, the
 * pool references the built-in `opencode-go` provider directly.
 *
 * Called from session_start (after the runner has bound its context, so
 * pi.registerProvider takes effect immediately).
 */
function buildPool(pi: ExtensionAPI, ctx: ExtensionContext): void {
	// Resolve the built-in base models we clone from.
	const baseModels: Model<Api>[] = [];
	for (const id of MODEL_IDS) {
		const m = ctx.modelRegistry.find(BUILTIN_PROVIDER, id);
		if (m) {
			baseModels.push(m);
		} else {
			const key = `${BUILTIN_PROVIDER}/${id}`;
			if (!warnedMissing.has(key)) {
				warnedMissing.add(key);
				ctx.ui.notify(
					`MoA: ${key} not found in registry — skipping it. ` +
						`Make sure it exists under the built-in ${BUILTIN_PROVIDER} provider.`,
					"warning",
				);
			}
		}
	}

	if (baseModels.length === 0) {
		moaPool = [];
		return;
	}

	// Single-key path: use the built-in provider as-is.
	if (OPENCODE_KEYS.length === 0) {
		moaPool = baseModels.map((m) => ({
			provider: BUILTIN_PROVIDER,
			id: m.id,
			label: m.name,
		}));
		return;
	}

	// Multi-key path: clone a provider per key, each with its own apiKey.
	// Re-registering an existing provider name upserts, so this is safe across
	// /reload and across session_start (new/resume/fork).
	const first = baseModels[0];
	const pool: MoaEntry[] = [];
	for (let i = 0; i < OPENCODE_KEYS.length; i++) {
		const providerName = `opencode-go-key${i + 1}`;
		const short = `key${i + 1}`;

		pi.registerProvider(providerName, {
			name: `OpenCode Zen Go (${short})`,
			baseUrl: first.baseUrl,
			api: first.api,
			apiKey: OPENCODE_KEYS[i],
			models: baseModels.map(modelToProviderConfig),
		});

		for (const m of baseModels) {
			pool.push({
				provider: providerName,
				id: m.id,
				label: `${m.name} [${short}]`,
			});
		}
	}
	moaPool = pool;
}

export default function (pi: ExtensionAPI) {
	// --no-moa flag: start disabled
	pi.registerFlag("no-moa", {
		description: "Start with the Mixture-of-Agents extension disabled",
		type: "boolean",
		default: false,
	});

	pi.on("session_start", async (_event, ctx) => {
		// Re-init per session instance.
		enabled = !pi.getFlag("no-moa");
		warnedMissing = new Set();
		lastPickedKey = undefined;
		suspensionTokens = new Set();
		buildPool(pi, ctx);
		updateStatus(ctx);
	});

	// ── Suspension-token contract (consumed by agentic-compound-engineering) ──
	// Other extensions emit these on the shared `pi.events` bus to suppress or
	// restore per-turn routing. Owners are string tokens; multiple owners require
	// ALL to release before routing resumes. Never mutates `enabled`.
	pi.events.on(MOA_SUSPEND_EVENT, (owner: unknown) => {
		if (typeof owner === "string" && owner) suspensionTokens.add(owner);
	});
	pi.events.on(MOA_RELEASE_EVENT, (owner: unknown) => {
		if (typeof owner === "string" && owner) suspensionTokens.delete(owner);
	});

	/**
	 * Core hook: fires before each LLM call. Choose a random model and switch
	 * to it before the provider request is built.
	 */
	pi.on("turn_start", async (_event, ctx) => {
		// Child isolation (R14): delegated subagents are pinned to their
		// delegation model; never reroute them even if the parent had MoA enabled.
		if (process.env.PI_SUBAGENT_PARENT_SESSION) return;
		// Suspension tokens suppress routing while preserving the manual pref.
		if (suspensionTokens.size > 0) return;
		if (!enabled) return;
		if (moaPool.length === 0) return;

		// Build the list of actually-registered models for this turn.
		const available: { entry: MoaEntry; model: Model<any> }[] = [];
		for (const entry of moaPool) {
			const model = ctx.modelRegistry.find(entry.provider, entry.id);
			if (model) {
				available.push({ entry, model });
			} else {
				const key = modelKey(entry);
				if (key && !warnedMissing.has(key)) {
					warnedMissing.add(key);
					ctx.ui.notify(
						`MoA: ${key} not found in registry — will be skipped this turn.`,
						"warning",
					);
				}
			}
		}

		if (available.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, "MoA: no configured models");
			return;
		}

		// Pick randomly. Prefer switching away from the current model when the
		// pool has more than one option (keeps the mixture mixing).
		let pick = pickRandom(available);
		if (available.length > 1 && modelKey(ctx.model) === modelKey(pick.model)) {
			const others = available.filter(
				(a) =>
					!(
						a.entry.provider === pick.entry.provider &&
						a.entry.id === pick.entry.id
					),
			);
			pick = pickRandom(others);
		}

		const pickKey = modelKey(pick.model)!;

		// Already active? Nothing to do.
		if (modelKey(ctx.model) === pickKey) {
			lastPickedKey = pickKey;
			updateStatus(ctx);
			return;
		}

		const success = await pi.setModel(pick.model);
		if (!success) {
			ctx.ui.notify(
				`MoA: no API key for ${pickKey} — staying on ${modelKey(ctx.model) ?? "current"}.`,
				"warning",
			);
			updateStatus(ctx);
			return;
		}

		lastPickedKey = pickKey;
		ctx.ui.notify(`MoA → ${pick.entry.label}`, "info");
		// updateStatus will be refreshed by the model_select handler below too.
	});

	// Keep the footer in sync when the model changes for any reason
	// (MoA switch, /model, Ctrl+P, restore).
	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	// /moa command: toggle / report state.
	pi.registerCommand("moa", {
		description:
			"Toggle Mixture-of-Agents on/off and show the pool + active model",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			const cur = ctx.model;
			const label =
				moaPool.find((e) => e.provider === cur?.provider && e.id === cur?.id)
					?.label ??
				cur?.id ??
				"none";
			const keyInfo =
				OPENCODE_KEYS.length > 0
					? `\nKeys: ${OPENCODE_KEYS.length} (rotating)`
					: "";
			ctx.ui.notify(
				`MoA ${enabled ? "ON" : "OFF"} — active: ${label}\n` +
					`Pool (${moaPool.length}): ${moaPool.map((e) => e.label).join(", ")}` +
					keyInfo,
				enabled ? "info" : "warning",
			);
			updateStatus(ctx);
		},
	});
}
