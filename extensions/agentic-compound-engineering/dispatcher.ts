/**
 * agentic-compound-engineering — per-spawn random-model delegation dispatcher (R5,R6-R8,R10-R12,R15)
 *
 * Uses the typed pi-subagents delegation v1 request/response events. For each
 * child run:
 *   1. Resolve an available catalog model with a FRESH random pick per spawn
 *      (every dispatch independently selects — no resume/reuse preference).
 *   2. Emit a SubagentDelegationRequest on the shared `pi.events` bus.
 *   3. Await the correlated SubagentDelegationResponse (by requestId).
 *   4. Persist the full result as a file-only artifact; return concise metadata.
 *   5. Backpressure: "unavailable_context" keeps the request queued and retries
 *      when a slot frees (the backpressure retry is itself a fresh spawn, so it
 *      re-picks randomly like any other dispatch).
 *
 * Children never inherit per-turn MoA routing: they are launched with an
 * explicit `model` and the MoA extension suppresses routing in child
 * processes via PI_SUBAGENT_PARENT_SESSION.
 */

// Load delegation protocol constants + types from the local shim so this
// extension resolves under jiti without a node_modules path from a global
// extension file (see ./delegation-constants.ts).
import {
	SUBAGENT_DELEGATION_REQUEST_EVENT,
	SUBAGENT_DELEGATION_RESPONSE_EVENT,
	type SubagentDelegationRequest,
	type SubagentDelegationStatus,
} from "./delegation-constants.ts";
import {
	CATALOG,
	makeRng,
	pickModel,
	resolveAvailable,
	modelKey,
	type CatalogModel,
} from "./model-catalog.ts";
import { setArtifacts, upsertChild, loadArtifacts } from "./state.ts";
import type {
	ChildRecord,
	ChildRole,
	ChildStatus,
	ModelRef,
	RunState,
} from "./types.ts";

const WRITER_ROLES: ChildRole[] = ["implementer", "simplifier"];

export interface DispatchInputs {
	role: ChildRole;
	agent: string;
	task: string;
	cwd: string;
	feature: string;
	/** Round-robin/seeded rng for model assignment distribution. */
	rng?: () => number;
	/** Resume a previously assigned model (cache reuse). */
	prefer?: ModelRef;
	/** Files this writer is allowed to mutate (overlap guard). */
	writeScope?: string[];
	/** Skill(s) to enable for the child. */
	skill?: string | string[];
	/** Output artifact path (file-only mode). */
	outputPath: string;
	timeoutMs?: number;
	/** Hard tool budgets are NEVER imposed on writers (could strand partials). */
	toolBudgetHard?: number;
	/** Soft tool budget ok for read-only reviewers. */
	toolBudgetSoft?: number;
}

export interface DispatchOutcome {
	requestId: string;
	status: ChildStatus;
	model: ModelRef;
	ok: boolean;
	artifactPath?: string;
	sessionFile?: string;
	error?: string;
	/** Was the result a backpressure signal (caller should re-queue, not fail). */
	backpressure: boolean;
}

/** Minimal event-bus surface the dispatcher depends on. */
export interface EventBus {
	on(event: string, handler: (data: unknown) => void): void;
	off?(event: string, handler: (data: unknown) => void): void;
	emit(event: string, data: unknown): void;
}

/** Minimal registry surface. */
export interface RegistryLike {
	find(
		provider: string,
		id: string,
	): { provider: string; id: string } | null | undefined;
}

export interface DispatchDeps {
	events: EventBus;
	registry: RegistryLike;
	state: RunState;
	warn: (key: string) => void;
}

let reqCounter = 0;
function newRequestId(role: ChildRole): string {
	reqCounter += 1;
	const r = Math.random().toString(36).slice(2, 8);
	return `ace-${role}-${Date.now().toString(36)}-${reqCounter}-${r}`;
}

function statusToChild(s: SubagentDelegationStatus): ChildStatus {
	switch (s) {
		case "completed":
			return "completed";
		case "cancelled":
			return "cancelled";
		case "acceptance_failed":
			return "acceptance-failed";
		case "unavailable_context":
			return "backpressure";
		default:
			return "failed";
	}
}

/**
 * Choose an available catalog model for a child with a fresh random pick.
 * Every spawn independently selects — there is no resume/reuse preference.
 */
export function selectModelFor(
	registry: RegistryLike,
	warn: (k: string) => void,
	rng: () => number = makeRng(Date.now() >>> 0),
): CatalogModel | undefined {
	const available = resolveAvailable({ modelRegistry: registry }, warn);
	return pickModel(available, rng);
}

/**
 * Reject overlapping active writers for the same run/files unless the caller
 * proves disjoint scope (R10 mutation safety).
 */
export function detectWriterConflict(
	state: RunState,
	role: ChildRole,
	writeScope?: string[],
): string[] {
	if (!writeScope || writeScope.length === 0) return [];
	if (!WRITER_ROLES.includes(role)) return [];
	const conflicts: string[] = [];
	for (const c of state.children) {
		if (!WRITER_ROLES.includes(c.role)) continue;
		if (
			c.status !== "running" &&
			c.status !== "launched" &&
			c.status !== "queued"
		)
			continue;
		const overlap = (c.writeScope ?? []).filter((f) => writeScope.includes(f));
		if (overlap.length > 0)
			conflicts.push(`${c.role}(${c.requestId}) owns ${overlap.join(",")}`);
	}
	return conflicts;
}

/**
 * Dispatch one child. Resolves with a concise outcome; the full transcript is
 * stored as a file-only artifact (outputMode "file-only") and only metadata +
 * paths return to orchestration state (R5).
 */
export function dispatchChild(
	deps: DispatchDeps,
	input: DispatchInputs,
): Promise<DispatchOutcome> {
	const { events, registry, state, warn } = deps;
	const rng =
		input.rng ?? makeRng((Date.now() ^ (reqCounter * 2654435761)) >>> 0);
	const model = selectModelFor(registry, warn, rng);

	if (!model) {
		return Promise.resolve({
			requestId: "(no-model)",
			status: "failed",
			model: { provider: "", id: "" },
			ok: false,
			error: "agentic catalog: no available model to assign",
			backpressure: false,
		});
	}

	// Mutation safety.
	const conflicts = detectWriterConflict(state, input.role, input.writeScope);
	if (conflicts.length > 0) {
		return Promise.resolve({
			requestId: "(conflict)",
			status: "failed",
			model: { provider: model.provider, id: model.id },
			ok: false,
			error: `overlapping writers: ${conflicts.join("; ")}`,
			backpressure: false,
		});
	}

	const requestId = newRequestId(input.role);
	const modelStr = modelKey(model)!;
	const children = loadChildBeginnings({
		state,
		requestId,
		role: input.role,
		agent: input.agent,
		task: input.task,
		model,
		writeScope: input.writeScope,
	});

	// Persist the model assignment BEFORE launch for audit/visibility; the
	// chosen model is a fresh random pick for this spawn and is NOT reused on
	// resume (every dispatch re-selects randomly).
	upsertChild(deps.state, children.before);
	deps.warn; // keep warn referenced for tests

	const request: SubagentDelegationRequest = {
		version: 1 as const,
		requestId,
		agent: input.agent,
		task: input.task,
		context: "fresh",
		cwd: input.cwd,
		model: modelStr,
		output: input.outputPath,
		outputMode: "file-only",
		artifacts: true,
		...(input.skill ? { skill: input.skill } : {}),
		...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
		...(input.toolBudgetHard && !WRITER_ROLES.includes(input.role)
			? {
					toolBudget: {
						soft: input.toolBudgetSoft,
						hard: input.toolBudgetHard,
					},
				}
			: input.toolBudgetSoft && !WRITER_ROLES.includes(input.role)
				? { toolBudget: { soft: input.toolBudgetSoft, hard: 9999 } }
				: {}),
	};

	return runOne(deps, input, model, requestId, request);
}

function loadChildBeginnings(args: {
	state: RunState;
	requestId: string;
	role: ChildRole;
	agent: string;
	task: string;
	model: CatalogModel;
	writeScope?: string[];
}): { before: ChildRecord } {
	const before: ChildRecord = {
		requestId: args.requestId,
		role: args.role,
		agent: args.agent,
		task: args.task,
		model: { provider: args.model.provider, id: args.model.id },
		status: "queued",
		generation: args.state.generation,
		assignedAt: new Date().toISOString(),
		retries: 0,
		writeScope: args.writeScope,
	};
	return { before };
}

function runOne(
	deps: DispatchDeps,
	input: DispatchInputs,
	model: CatalogModel,
	requestId: string,
	request: SubagentDelegationRequest,
): Promise<DispatchOutcome> {
	return new Promise((resolve) => {
		const onResp = (data: unknown) => {
			const resp = data as {
				requestId: string;
				status: SubagentDelegationStatus;
				error?: string;
				outputPath?: string;
				output?: string;
				sessionFile?: string;
			};
			if (resp.requestId !== requestId) return;
			deps.events.off?.(SUBAGENT_DELEGATION_RESPONSE_EVENT, onResp);

			const childStatus = statusToChild(resp.status);
			const backpressure = childStatus === "backpressure";

			const record: ChildRecord = {
				requestId,
				role: input.role,
				agent: input.agent,
				task: input.task,
				model: { provider: model.provider, id: model.id },
				status: "running",
				generation: deps.state.generation,
				assignedAt: new Date().toISOString(),
				retries: backpressure ? 1 : 0,
				writeScope: input.writeScope,
			};

			if (backpressure) {
				// Keep queued with the SAME model; surface to caller as backpressure,
				// NOT task failure. Caller re-dispatches when a slot frees.
				upsertChild(deps.state, { ...record, status: "backpressure" });
				resolve({
					requestId,
					status: "backpressure",
					model: { provider: model.provider, id: model.id },
					ok: false,
					backpressure: true,
				});
				return;
			}

			record.status = childStatus;
			record.finishedAt = new Date().toISOString();
			if (resp.error) record.statusDetail = resp.error;
			upsertChild(deps.state, record);

			// Persist artifact metadata (full output lives at outputPath).
			const store = loadArtifacts(deps.state.cwd, deps.state.runId);
			const artifactPath = resp.outputPath ?? input.outputPath;
			if (artifactPath) {
				store.entries.push({
					requestId,
					role: input.role,
					path: artifactPath,
					createdAt: new Date().toISOString(),
					bytes: 0,
				});
				setArtifacts(deps.state.cwd, deps.state.runId, store);
			}

			resolve({
				requestId,
				status: childStatus,
				model: { provider: model.provider, id: model.id },
				ok: childStatus === "completed",
				artifactPath,
				sessionFile: resp.sessionFile,
				error: resp.error,
				backpressure: false,
			});
		};

		deps.events.on(
			SUBAGENT_DELEGATION_RESPONSE_EVENT,
			onResp as (d: unknown) => void,
		);
		// Mark the persisted child as launched, then emit the request on the shared bus.
		upsertChild(deps.state, {
			requestId,
			role: input.role,
			agent: input.agent,
			task: input.task,
			model: { provider: model.provider, id: model.id },
			status: "launched",
			generation: deps.state.generation,
			assignedAt: new Date().toISOString(),
			retries: 0,
			writeScope: input.writeScope,
		});
		deps.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
	});
}

/** Catalog surface exported for tests/README. */
export { CATALOG, resolveAvailable };
