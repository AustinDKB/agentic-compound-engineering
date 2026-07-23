/**
 * agentic-compound-engineering — shared types
 *
 * Core state shapes for the durable Compound Engineering pipeline.
 * Code guarantees persistence & ordering; the main agent owns judgment.
 */

// ─── Pipeline phases ──────────────────────────────────────────────────────

export type Phase =
	| "Inactive"
	| "Brainstorming"
	| "Planning"
	| "PlanReview"
	| "Implementing"
	| "Verifying"
	| "Simplifying"
	| "CodeReview"
	| "Shipping"
	| "Babysitting"
	| "Compounding"
	| "Complete"
	| "Paused";

/** Phases that perform real work (not control states). */
export const ACTIVE_PHASES: Phase[] = [
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
];

export function isActivePhase(p: Phase): boolean {
	return ACTIVE_PHASES.includes(p);
}

/** All terminal/blocked signals beyond "completed". */
export type BlockReason =
	| "preflight"
	| "missing-tool"
	| "missing-skill"
	| "missing-auth"
	| "product-blocker"
	| "plan-not-verified"
	| "human-decision"
	| "child-failure"
	| "stale-state"
	| "concurrency-limit"
	| "pr-terminal"
	| "non-converging";

// ─── Model assignment (per child, persisted once) ─────────────────────────

export interface CatalogModel {
	provider: string;
	id: string;
	/** Human label, e.g. "glm-5.2". */
	label: string;
	/** True for opencode-go models that participate in key cloning. */
	multiKey: boolean;
}

export type ModelRef = { provider: string; id: string };

// ─── Child runs (delegated subagents) ─────────────────────────────────────

export type ChildRole =
	| "brainstormer"
	| "research-repo"
	| "research-learnings"
	| "research-framework"
	| "research-best-practices"
	| "research-flow"
	| "doc-reviewer"
	| "implementer"
	| "verifier"
	| "simplifier"
	| "code-reviewer";

export type ChildStatus =
	| "queued"
	| "backpressure"
	| "launched"
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "acceptance-failed";

export interface ChildRecord {
	/** Matches SubagentDelegationRequest.requestId. */
	requestId: string;
	role: ChildRole;
	agent: string;
	task: string;
	/** Chosen once and persisted; never re-randomized on resume. */
	model: ModelRef;
	status: ChildStatus;
	statusDetail?: string;
	artifactPath?: string;
	sessionFile?: string;
	/** Run generation when this child was created (stale-guard). */
	generation: number;
	/** Monotonic within a run; tracks assignment order. */
	assignedAt: string;
	finishedAt?: string;
	retries: number;
	/** TODO U-IDs this child is allowed to mutate (writer overlap guard). */
	writeScope?: string[];
}

// ─── Todo mapping (plan U-ID → built-in todo) ──────────────────────────────

export interface TodoMapping {
	/** Stable plan U-ID (e.g. "U3"). */
	uId: string;
	/** Built-in todo task id, populated after the todo tool creates it. */
	todoId?: number;
	subject: string;
	status: "pending" | "in-progress" | "completed" | "deleted";
	blockedBy: string[];
	/** Plan content hash present when this todo was created. */
	planHash?: string;
}

// ─── Pipeline run state ───────────────────────────────────────────────────

export interface FailureRecord {
	at: string;
	phase: Phase;
	child?: string;
	reason: string;
	detail?: string;
}

export interface PendingDecision {
	at: string;
	kind: "product-blocker" | "lavish-review" | "human-decision" | "pr-decision";
	prompt: string;
	/** Artifact/plan pointer the decision relates to. */
	artifactPath?: string;
	resolved?: boolean;
	resolution?: string;
}

export interface RunState {
	runId: string;
	cwd: string;
	feature: string;
	phase: Phase;
	/** Phase captured at pause; resume returns here. */
	pausedPhase?: Phase;
	/** Increments on every phase transition; gates stale queued messages. */
	generation: number;
	planPath?: string;
	planHash?: string;
	/** PR created by the shipping phase. */
	prUrl?: string;
	prNumber?: number;
	/** Learning artifact produced by ce-compound. */
	learningArtifact?: string;
	/** Set when ce-babysit-pr reports the PR merge-ready; advances to Compounding. */
	babysitReady?: boolean;
	todos: TodoMapping[];
	children: ChildRecord[];
	failures: FailureRecord[];
	pending: PendingDecision[];
	/** Timestamps. */
	startedAt: string;
	updatedAt: string;
	pausedAt?: string;
	completedAt?: string;
	/** Prior MoA manual preference captured at activation (for restore). */
	moaPrior?: boolean;
	/** Owner session id (the session that created/owns this run). */
	ownerSession?: string;
}

/** Compact projection injected into the main context (R5). */
export interface CompactRunSummary {
	runId: string;
	phase: Phase;
	generation: number;
	pendingGate: string;
	planPath?: string;
	planHash?: string;
	prUrl?: string;
	todos: { done: number; total: number; blocked: number };
	activeChildren: { role: ChildRole; model: string; status: ChildStatus }[];
	pendingDecision?: { kind: string; prompt: string };
	recentFailures: { phase: Phase; reason: string }[];
	artifactDir: string;
}

// ─── Artifact store ──────────────────────────────────────────────────────

export interface ArtifactEntry {
	requestId: string;
	role: ChildRole;
	/** Absolute path to the stored full child output. */
	path: string;
	createdAt: string;
	bytes: number;
}

export interface ArtifactStore {
	runId: string;
	dir: string;
	entries: ArtifactEntry[];
}

// ─── Commands ─────────────────────────────────────────────────────────────

export type Subcommand = "start" | "status" | "pause" | "resume" | "off";

export interface CommandResult {
	ok: boolean;
	message: string;
	summary?: CompactRunSummary;
}
