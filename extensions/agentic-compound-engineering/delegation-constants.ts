/**
 * Local runtime constants + minimal types for the pi-subagents delegation v1
 * protocol.
 *
 * Why local? Pi loads extensions via jiti, and the `pi-subagents` package is
 * installed under ~/.pi/agent/npm/node_modules — not resolvable from a global
 * extension file via a bare `import "pi-subagents/delegation"`. This shim
 * duplicates only the STABLE protocol string constants + the request/response
 * shapes the dispatcher actually uses, so the extension loads without a
 * resolved node_modules path at runtime. The authoritative source remains
 * `pi-subagents/src/api/delegation.ts`; these values are part of its public
 * contract and must not change without a protocol version bump.
 *
 * Type-only imports elsewhere (`type SubagentDelegationRequest` etc.) resolve
 * under `tsc` via this same module so editor/LSP type-checking stays accurate.
 */

export const SUBAGENT_DELEGATION_PROTOCOL_VERSION = 1 as const;

export const SUBAGENT_DELEGATION_REQUEST_EVENT =
	"prompt-template:subagent:request";
export const SUBAGENT_DELEGATION_STARTED_EVENT =
	"prompt-template:subagent:started";
export const SUBAGENT_DELEGATION_UPDATE_EVENT =
	"prompt-template:subagent:update";
export const SUBAGENT_DELEGATION_RESPONSE_EVENT =
	"prompt-template:subagent:response";
export const SUBAGENT_DELEGATION_CANCEL_EVENT =
	"prompt-template:subagent:cancel";

export type SubagentDelegationContext = "fresh" | "fork";

export interface SubagentDelegationTurnBudget {
	maxTurns: number;
	graceTurns?: number;
}

export interface SubagentDelegationToolBudget {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export interface SubagentDelegationRequest {
	version: typeof SUBAGENT_DELEGATION_PROTOCOL_VERSION;
	requestId: string;
	agent: string;
	task: string;
	context: SubagentDelegationContext;
	cwd: string;
	model?: string;
	timeoutMs?: number;
	turnBudget?: SubagentDelegationTurnBudget;
	toolBudget?: SubagentDelegationToolBudget;
	skill?: string | string[] | boolean;
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	acceptance?: unknown;
	artifacts?: boolean;
}

export type SubagentDelegationStatus =
	| "completed"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "interrupted"
	| "turn_budget_exhausted"
	| "tool_budget_exhausted"
	| "acceptance_failed"
	| "invalid_request"
	| "unavailable_context";

export interface SubagentDelegationResponse {
	requestId: string;
	status: SubagentDelegationStatus;
	error?: string;
	outputPath?: string;
	output?: string;
	sessionFile?: string;
	model?: string;
}
