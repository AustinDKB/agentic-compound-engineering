# de-run Pipeline — Architecture Specification

> **Status:** Architecture decision record + implementation contract.
> Replaces the generic agentic-compound-engineering CE pipeline with a
> domain-specific 6-stage flow for the **Prefect / Postgres(+Alembic) / CRM**
> stack. Built **natively** on the pi SDK — **no pi-subagents dependency, no
> mixture-of-agents routing.**
>
> This document defines *what* the pipeline does. Its companion,
> `de-run-runtime-spec.md`, defines *where it runs*: the host-agnostic core, the
> web UI (primary target) and pi TUI (fallback) hosts, and the event contract
> between them.

---

## 0. Overview

`de-run` is an autonomous orchestrator driven by `/de-run '<task description>'`.
It runs a deterministic 6-stage pipeline — **scope → research → plan → execute →
review → compound** — delegating bounded work to short-lived **child agent
sessions** and keeping all judgment on the main agent (`openai-codex/gpt-5.6-sol`).

Children are **fresh `createAgentSession` sessions** (`SessionManager.inMemory()`),
each pinned to a fixed model from the catalog, with a scoped tool set and a
role-specific system prompt. Scouts, reviewers, and executors run concurrently
via a bounded worker pool. Only the **final assistant message** is inlined back
to the main agent; the streaming/thinking event stream is discarded.

### Implementation surface

Everything below lives in the host-agnostic `core/`. Host-specific surfaces
(command registration, dialog rendering, event display) are the `Host` port's
job — see `de-run-runtime-spec.md` §3.

| Concern | Mechanism |
|---|---|
| Run entry point | `core.run(task, host)` — reached via `/de-run` in the extension host, a WS `prompt` in the web host |
| Orchestration / phase advance | Custom tool `de_advance` the main agent calls (registered via `customTools`) + continuation prompts. **Core owns transitions; `de_advance` validates them.** |
| Child execution | Fresh `createAgentSession({ model, tools, sessionManager: SessionManager.inMemory(cwd), resourceLoader })` per child, run through a bounded pool (§1.7) |
| Durable run state | Runs-dir checkpoints (`state.ts` logic, kept) (§1.6) |
| Scope/research/plan/review artifacts | Repo-local markdown written by the main agent's `write` tool; JSON indexes returned as tool results |
| Human gates | `host.ui.select` / `confirm` / `input` (§1.8) |
| Lavish plan review | Rendered artifact handed to the user through the host; resume on acceptance |
| Main model pinning | `session.setModel(registry.find("openai-codex", "gpt-5.6-sol"))` at run start (§1.1) |
| Model catalog | `model-catalog.ts` reused verbatim |

---

## 1. Global Invariants

These apply across **all stages** and are non-negotiable.

### 1.1 Main agent model

The main agent stays on `openai-codex/gpt-5.6-sol` for the entire run. The
orchestrator pins it via `setModel` at run start and on resume. Never switch the
main model mid-run.

**No mixture-of-agents routing exists in this project.** There is no `moa:suspend`
/ `moa:release` token contract, no suspension bookkeeping, and no `moaPrior`
state. The `mixture-of-agents.ts` extension has been deleted from the pi install;
nothing re-routes models per turn, so the pin holds by construction.

### 1.2 Child model catalog (reuse `model-catalog.ts` verbatim)

Each child spawn independently picks **one** model from the available catalog
(fresh random pick per spawn), with one exception: §6.4 pins reviewer models for
the duration of a review loop.

| Provider | Model |
|---|---|
| opencode-go | glm-5.2 |
| opencode-go | deepseek-v4-pro |
| opencode-go | kimi-k3 |
| opencode-go | grok-4.5 |
| openai-codex | gpt-5.4-mini |

`kimi-k2.7-code` is **intentionally excluded**. Unavailable/unauthenticated
entries are warned-once and skipped (reuse `resolveAvailable`). No Anthropic
tier pinning.

**Model resolution:** `pickModel` returns a `CatalogModel` of provider/id
**strings**. `createAgentSession({ model })` requires a resolved `Model<any>`.
The spawner must call `modelRegistry.find(entry.provider, entry.id)` and pass
that object; a `find` miss at spawn time is a child failure, not a silent default.

### 1.3 Child session construction (CRITICAL, global)

Every child is built the same way:

```ts
const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  settingsManager,
  systemPromptOverride: () => LENS_PROMPTS[role],
  extensionsOverride: () => EMPTY_EXTENSIONS,   // see below
});
await loader.reload();

const { session } = await createAgentSession({
  cwd,
  model,                                        // resolved Model<any> (§1.2)
  tools: TOOLS_FOR[role],                       // §9
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(cwd),
});
```

- **System prompt.** There is no `systemPrompt` option on
  `createAgentSession`. The role lens goes through
  `DefaultResourceLoader({ systemPromptOverride })`, and each child needs its
  **own** loader instance plus `await loader.reload()`.
- **Extensions are disabled in children** via `extensionsOverride`. Without this,
  `DefaultResourceLoader` discovers `~/.pi/agent/extensions/*` and a child could
  load unrelated global extensions — or, under the extension host, de-run itself
  (nested orchestrators, duplicate commands, recursive spawns).
- **Transcript.** `SessionManager.inMemory()` is not persisted and is discarded
  on `dispose()`.

### 1.4 Child output posture (CRITICAL, global)

- The child's **streaming/thinking event stream is never read into the main
  agent's context.** This constrains the *context* channel only — forwarding that
  same stream to a UI pane is expected and is how the web host's sub-agent column
  works. See `de-run-runtime-spec.md` §5 for the two-channel rule.
- **Completion signal is `await session.prompt(task)`**, which resolves only
  after the full accepted run finishes, including auto-retries.
  **Do not use `agent_end`** — it fires per low-level agent run and pi may still
  auto-retry, auto-compact, or drain queued messages afterward, so an `agent_end`
  handler can inline a premature or partial result.
- After the prompt resolves, take the **last assistant message** from
  `session.agent.state.messages` and inline that to the main agent (returned from
  the `de_*` tool). "Final result only, not all the thinking."
- **Every child is disposed in a `finally`.** Fan-out uses
  `Promise.allSettled`, never `Promise.all` — a rejected `Promise.all` abandons
  in-flight sibling sessions.
- **Cancellation.** The orchestrator plumbs `host.signal` to every live child; on
  abort it calls `session.abort()` then `dispose()` on all of them, so Esc (TUI)
  or the stop button (web) actually stops a fan-out.

### 1.5 Child output contracts

Each role has a declared JSON output schema (§12). The spawner validates the
child's final message against it. On a schema violation the child gets **one
repair prompt** (`"return only JSON matching <schema>"`) in the same session; a
second violation is a child failure and enters the retry-once path (§1.9).

### 1.6 Durable run state

- **The runs-dir is the single source of truth** (`state.ts` logic survives,
  contrary to an earlier draft). Keyed by `runId`, holding `ownerSession`,
  `pausedPhase`, and the lock — this is what makes cross-session resume and the
  §1.10 restart guarantee possible, and it works identically under both hosts.
  Keep `redact()`.
- A session-scoped store (`pi.appendEntry`) is **not** sufficient on its own: it
  writes into the pi session file, so a run could not be resumed in a new
  session. The extension host may mirror state there for transcript visibility;
  core must not depend on it.
- **No store's contents reach the LLM by themselves.** Any JSON index the main
  agent must reason about (scope tags, plan U-IDs, review findings) is handed
  back explicitly as a tool result.

### 1.7 Concurrency budget

- **At most 3 child sessions run concurrently**, across all stages. A bounded
  worker pool feeds the queue; Stage 4's four reviewers run 3-then-1 through it.
- Every child carries an explicit `timeoutMs` (§9). "Generous budget" is not a
  number; a role without a timeout is a spec bug.
- Timeout, pool eviction, and abort all route through the same dispose path
  (§1.4).

### 1.8 Human gates require UI

All gates are mandatory and non-skippable. They are asked through
`host.ui.ask()` — the rich multi-option surface (`de-run-runtime-spec.md` §3),
rendered by the web host's question modal (§6.1 there) and degraded to
sequential `ctx.ui.select` calls in the TUI. **A host that cannot present a dialog rejects
the call, and a rejected gate BLOCKS the run** with a `human-decision`
checkpoint — it never auto-proceeds. In the web host a dialog stays pending
across a disconnect and is re-presented on reconnect
(`de-run-runtime-spec.md` §8).

### 1.9 Failure handling (uniform)

Every child failure (error, timeout, schema violation after repair) gets **one
automatic retry as a fresh spawn, which re-picks its model** — the point of the
retry is to escape a model-specific failure. A second failure BLOCKS its stage
and surfaces to the user. No silent partial results anywhere.

### 1.10 Stale-guard / generation

Every run carries a `generation` counter bumped on each phase advance. A
continuation carrying an older generation is ignored. `de_advance` validates the
requested transition against the state machine and **rejects illegal ones** —
sequencing authority lives in code, not in the main agent's discretion. Illegal
transitions, failed gates, and human-decision pauses are preserved as
`paused`/`failed` checkpoints. A restart never silently skips unfinished work.

### 1.11 Native vocabulary (what we do NOT use)

No pi-subagents delegation protocol: no `SubagentDelegationRequest`, no
`run_in_background`, no `get_subagent_result`, no `isolated:true`. No MoA. The
native primitives are: `createAgentSession`, `DefaultResourceLoader`,
`session.prompt`, `Promise.allSettled`, `session.abort()`, `session.dispose()`.

### 1.12 The drive loop (core-driven, `de_advance` confirms)

Core owns the loop. It awaits **one `session.prompt()` per stage**; the main
agent does that stage's work and calls `de_advance` to record its artifact and
request the transition. Core validates, then drives the next stage.

```ts
for (const stage of STAGES) {
  host.publish({ type: "phase.changed", phase: stage.id, status: "active" });
  const gen = state.generation;

  await session.prompt(continuationFor(stage, state));   // resolves when the run settles

  if (state.generation === gen) {
    return block(stage, "stage ended without de_advance");
  }
}
```

Properties this buys, and why this shape was chosen over an agent-driven pump:

- **The loop is testable.** A stub `Host` plus a fake session drives the whole
  pipeline with no model calls.
- **No watchdog is needed for a forgotten tool call.** `session.prompt()` already
  resolves when the run settles (§1.4); if the generation didn't move, the stage
  ended without advancing and core blocks with a precise reason rather than
  hanging.
- **Stage boundaries survive retries.** `prompt()` resolves after auto-retries
  and compaction, so an internal retry can't be mistaken for stage completion.
- Within a stage the agent is fully autonomous — it may take as many turns and
  tool calls as it needs. Core constrains only the boundaries.

**One re-prompt on a non-advancing stage.** Before blocking, core re-prompts once
with the reason ("you did not call `de_advance`; the gate for <stage> is <gate>").
A second non-advance blocks. This absorbs the common case of an agent that
narrates completion without calling the tool.

### 1.13 `de_advance` contract

```ts
defineTool({
  name: "de_advance",
  description: "Record this stage's artifact and advance the run to the next phase.",
  parameters: Type.Object({
    to:           Type.String(),                    // target phase
    artifactPath: Type.String(),                    // repo-relative; must exist on disk
    summary:      Type.String(),                    // one line, for the event stream + log
    gateMet:      Type.Boolean(),                   // false ⇒ request a block, not an advance
    blockReason:  Type.Optional(Type.String()),     // required when gateMet is false
  }),
});
```

Validation order — the first failure returns an error result to the agent and
leaves state untouched:

1. `to` is a legal successor of the current phase (table below), else reject.
2. The tool call's run generation matches the checkpoint, else reject as stale
   (§1.10).
3. `artifactPath` exists and is non-empty, else reject.
4. `gateMet === false` → record a `blocked` checkpoint with `blockReason` and
   surface to the user; do **not** advance.
5. Otherwise: write the checkpoint, bump `generation`, publish `phase.changed`,
   return success.

**Transition table.** Any edge not listed is illegal.

| From | Legal `to` |
|---|---|
| `Scope` | `Research`, `Blocked` |
| `Research` | `Plan`, `Blocked` |
| `Plan` | `Execute`, `Blocked` |
| `Execute` | `Review`, `Blocked` |
| `Review` | `Compound`, `Blocked` |
| `Compound` | `Complete`, `Blocked` |
| `Paused` | the phase recorded in `pausedPhase` only |
| `Blocked` | the phase recorded in `blockedPhase` only (after the user resolves) |
| `Complete` | — terminal |

`Paused` and `Blocked` are entered by core (user action, gate failure, blocked
child), never named by the agent as a `to` target — the agent requests a block
via `gateMet: false`, and core decides the resulting state. Re-entry from
`Paused`/`Blocked` resumes the recorded phase and bumps the generation, so any
continuation still in flight from before the pause is stale by construction.

---

## 2. Stage 0 · de-scope

**Inputs:** `$ARGUMENTS` (raw task description from `/de-run`).

**Steps:**

1. Main agent pins the main model and creates the run checkpoint (generation 0).
2. A **dedicated scope subagent** (fresh session, catalog model, scope lens,
   read-only tools) classifies `$ARGUMENTS` against the 5 fixed categories and
   may assign **multiple tags**.
3. Scope subagent returns its final classification inline.

**Categories (hardcoded to this stack):**
`pipeline-new`, `pipeline-modify`, `crm-integration`, `schema-change`, `debug`.

**Ambiguity:** multiple tags are allowed (e.g. `schema-change` AND `debug`). If
two tags tie or none match, the scope subagent flags it and the main agent
surfaces `host.ui.select` to disambiguate before writing the artifact.

**Outputs (both formats):**

- `pi.appendEntry("de-run:scope", { tags, paths, assumptions, runId, generation })`
  — the JSON index, **also returned as the `de_scope` tool result** so the main
  agent actually receives it (§1.6).
- Human-readable `.artifacts/scope/<date>-scope.md`.

**Failure handling:** per §1.9.

---

## 3. Stage 1 · de-research

**Inputs:** the Stage-0 JSON index `{ tags, paths, assumptions }`.

**Scout selection — Baseline 2 + tag-driven extras:**

- **Always run (baseline 2):** (a) prior-art scout — scans `docs/solutions/`
  for applicable past learnings; (b) repo/flow-structure scout — scans Prefect
  flows, task definitions, and entrypoints.
- **Tag-driven extras** (spawned iff the tag matched in Stage 0):
  - `schema-change` → schema scout (Postgres schemas + Alembic migrations).
  - `crm-integration` → CRM scout (CRM client + API wrappers).
  - `pipeline-new` / `pipeline-modify` → pipeline-detail scout (existing flow
    reuse points, overlap detectors).
  - `debug` → failure-path scout (error sites, logs, recent failing tests).

Count and subjects vary per task; no wasted scouts. Up to 6 scouts queue through
the 3-slot pool (§1.7).

**Execution:** read-only tools `["read", "grep", "find", "ls"]`, per-role
timeout, `Promise.allSettled`, dispose in `finally`. Each scout receives its
task **plus every input it needs inlined** — a fresh session has zero context.

**Absence-claim verification — post-collect Plan agent, BLOCKING:**
After all scouts settle, **one Plan agent** (fresh session, read-only) re-scans
the codebase to verify every "absent / not-found" claim a scout made (e.g. "no
existing migration handles X"). Each claim must be confirmed or refuted with
`file:line` evidence. **An unverifiable claim BLOCKS Stage 1** — surfaced to the
user before planning.

**Output (research dossier):**

- Full dossier at `.artifacts/research/<date>-<topic>-research.md` with
  `file:line` citations, verified claims, and **assumptions labeled**.
- Each scout's **final result is inlined** into the main agent's context — these
  are genuinely the planning inputs.

---

## 4. Stage 2 · de-plan

**Inputs:** the research dossier (inlined) + the Stage-0 tags.

**Plan-review FLOW (six sequential sub-steps):**

1. **Main agent drafts** the initial plan by working through the checklist
   (failure modes, idempotency, migrations, rate-limits, credentials) and
   sequencing U-IDs in dependency order.
2. **Lens reviewers review the draft** — fresh sessions, catalog models, one of
   the 4 domain lenses each (pipeline / schema / crm / idempotency), read-only,
   through the pool. The full plan text is inlined into each child's prompt.
   Return JSON findings.
3. **Main agent collects findings → `host.ui.select`** for which findings to apply.
4. Main agent **applies the chosen findings**.
5. **Render the plan via Lavish** and hand the artifact to the user through the
   host (web: a `artifact.written` event + modal; TUI: `pi.sendMessage`).
6. **Human nitpicks the Lavish plan.** Resume only on acceptance.

**Confirm gate:** always fires before execution, regardless of plan size or risk.
No auto-proceed threshold. Blocks if the host cannot present a dialog (§1.8).

**Unit size — one U-ID per behavior:** a coherent behavior (e.g. "add CRM retry
wrapper") that may span multiple files/migrations in one atomic commit. Not
one-per-file.

**Plan content per U-ID (full spec):**

- `gate` — pass/fail criteria.
- `rollback` — rollback strategy.
- `ownerScout` — which scout found / motivated this unit.
- `risks` — flagged risks.
- **`writeScope: string[]` — the files/globs this unit is allowed to write.**
  **Required.** This is the sole input to Stage-3 parallelism and to the
  writer-overlap guard; without it neither can run. The main agent authors it at
  plan time, and the user reviews it at the Lavish gate (§4.6) — a wrong scope is
  visible before any code is written.

**Explicit dependency-edge field: still NO.** Ordering comes from the main
agent's stated U-ID sequence; safety comes from `writeScope` overlap (§8.1).

**Storage (dual):**

- `pi.appendEntry("de-run:plan", { uIds, planHash, runId, generation })` +
  returned as a tool result.
- Human-readable `.artifacts/plan/<topic>-plan.md`.

---

## 5. Stage 3 · de-execute

**Inputs:** the plan (U-IDs in stated order, each with `writeScope`).

### 5.1 Division of labor

- **Executor children implement.** Each ready U-ID is dispatched to a fresh
  session with write tools `["read", "grep", "find", "ls", "edit", "write", "bash"]`,
  a catalog model, and an executor lens. Its prompt carries the U-ID's full spec,
  the relevant dossier excerpts, and its `writeScope`.
- **The main agent orchestrates, judges, and commits.** It never delegates gate
  judgment and it owns every git operation. Executor children are told **not to
  run any `git` command**; that is the orchestrator's exclusive surface.

### 5.2 Parallelism — up to 3 units at once, disjoint scopes

The dependency DAG is inferred from `writeScope` overlap plus the main agent's
stated U-ID order. A unit is *ready* when every earlier unit whose `writeScope`
intersects its own has passed its gate. Ready units launch concurrently up to the
3-slot pool (§1.7). All executors share **one working tree**.

**Scope enforcement is post-hoc, because pi cannot restrict a child's write
paths.** After each executor returns, core runs `git status --porcelain` and
**attributes every changed path against the union of all in-flight scopes**, not
against the returning unit's scope alone:

```
violations = changedPaths
  .filter(p => !matchesAny(p, unionOf(liveScopes ∪ committedUnitScopes)))
```

- A path matching **no** live or completed unit's scope is a violation: it is
  attributed to the unit that just returned, that unit **fails its gate
  immediately**, the offending paths are reverted (`git checkout -- <paths>`),
  and the unit enters the retry-once path.
- A path matching a **sibling's** scope is that sibling's in-progress work and is
  ignored. Comparing against the returning unit's scope alone would report every
  concurrent sibling's edits as violations and revert good work — with three
  executors live, a naive check fails on essentially every unit.
- Untracked build artifacts and ignored paths are excluded before attribution
  (`git status --porcelain --untracked-files=normal` respecting `.gitignore`).

### 5.3 Gate evaluation — main agent judges

The main agent reads the unit's diff (`git diff -- <writeScope>`) plus the U-ID's
`gate` criteria and decides pass/fail. **No verifier child.**

**Verification command vocabulary.** A gate's criteria name the commands to run,
drawn from a declared allowlist (`core/gates.ts`):

| Family | Permitted forms |
|---|---|
| tests | `pytest <selector>`, `pytest -k <expr>`, `pytest <path>` |
| migrations | `alembic check`, `alembic upgrade --sql <rev>`, `alembic history`, `alembic heads` |
| lint / types | `ruff check <path>`, `ruff format --check <path>`, `mypy <path>` |
| prefect | `prefect flow-run inspect <id>`, `prefect deployment inspect <name>` |
| read-only git | `git diff --stat`, `git log --oneline -n <k>` |

A gate naming anything outside the allowlist runs **only after an explicit
`host.ui.confirm`** showing the exact command. Declining the confirm fails the
gate. This keeps unusual verification possible while ensuring nothing unexpected
executes silently under the banner of "the gate said so".

Allowlist matching is on the **command head plus argument shape**, not a
substring match — `pytest; rm -rf /` is not a `pytest` invocation. Shell
metacharacters (`;`, `&&`, `|`, backticks, `$(`) force the confirm path
regardless of the head.

**Gate failure policy — retry the unit once, then STOP.** The retry is a fresh
executor child with a re-picked model, given the failure reason. A second failure
STOPs the run; in-flight siblings are allowed to finish and be judged, but no new
units launch and later U-IDs are not touched.

### 5.4 Commits

**An atomic commit per U-ID, made by the main agent after the gate passes**, via
`git add <writeScope>` (safe under concurrency precisely because scopes are
disjoint), with the U-ID in the commit message. Commits stay **local** during
Stage 3 — push and PR happen after Stage 4.

### 5.5 Output

`.artifacts/execute/<date>-<topic>-execute.md` — per-U-ID: model used, gate
verdict, retries, commit SHA, scope violations. This is a Stage-5 input, so it is
a required output, not optional.

### 5.6 Crash / restart recovery

Committed units are durable; the runs-dir checkpoint records which U-IDs reached
a commit. Executor child sessions are in-memory and do **not** survive a restart,
so a crash mid-Stage-3 can leave uncommitted edits from units whose child is gone.

On resume, core classifies each U-ID:

| State at crash | Recovery |
|---|---|
| committed | trusted, skipped |
| never started | queued normally |
| **orphaned** — edits present, no commit | **the user decides, per unit** |

For each orphaned unit, core presents its diff (`git diff -- <writeScope>`) and
asks via `host.ui.select`:

- **keep** — send the existing edits straight to gate judgment (§5.3), no re-run
- **re-judge after re-run** — revert the scope and dispatch a fresh executor
- **discard** — revert the scope and drop the unit from this run

Before any revert, the diff is written to
`.artifacts/execute/orphaned/<runId>-<uId>.patch` so a discard is always
recoverable by hand.

Resume **blocks** until every orphaned unit is resolved — this is a
`human-decision` checkpoint under §1.8, and a host that cannot ask cannot resume.
Note the trade this choice makes: a unit whose child died mid-edit may be kept
and can carry a syntactically broken file into gate judgment. The gate is the
backstop, so gates that only inspect a diff (rather than running tests) are
weaker here.

---

## 6. Stage 4 · de-review

**Inputs:** the local Stage-3 commits (the diff).

### 6.1 Reviewers — fixed 4, always run

`pipeline-reviewer`, `schema-reviewer`, `crm-reviewer`, `idempotency-reviewer` —
the same 4 lenses used at Stage-2 plan review, now on the actual diff. **Always
run, even on untouched domains** (deliberate coverage-over-efficiency; a persona
whose domain didn't change returns "no findings"). Fresh sessions, read-only
tools, through the 3-slot pool. The diff is inlined into each prompt.

### 6.2 Severity tiers

- **P0 = block** — must fix before ship.
- **P1–P2 = human** — surfaced to the user.
- **P3 = advisory** — logged in the report only.

### 6.3 Merge order (escalate, THEN dedup)

Order matters: deduping first destroys the evidence escalation depends on.

1. **Cluster** findings by location: same file **and** overlapping line ranges
   (±5 lines), or same symbol when a finding is symbol-scoped.
2. **Count distinct personas** per cluster.
3. **Escalate one tier** for any cluster flagged by **2+ personas**
   (P3→P2, P2→P1, P1→P0). An escalation into P0 blocks exactly like a native P0.
4. **Dedup** within each cluster for the written report.

### 6.4 Fix loop — bounded, with stable reviewers

On P0, the **main agent applies fixes directly** (no executor child for review
fixes — the fixer needs the review context), then re-dispatches the 4 reviewers
over the new diff.

- **Reviewer models are picked once per run and reused for every round of the
  loop.** This is a deliberate exception to §1.2's fresh-pick rule: a re-rolled
  reviewer population makes the blocking gate non-deterministic and lets the loop
  oscillate, with new reviewers raising new P0s on already-fixed code.
- **Maximum 3 rounds.** If P0s remain after round 3, the run STOPs and surfaces
  the surviving P0s to the user. Do not ship, do not compound.

### 6.5 Shipping — after review passes

`/ce-commit-push-pr` **does not exist** as a pi skill (`~/.pi/agent/skills/`
holds only `lavish`; the CE skills are Claude Code plugin skills). Shipping is
therefore implemented in core, split by what deserves determinism versus
judgment:

**Core does the git work** — no LLM in the loop:

1. `git checkout -b de-run/<runId>-<topic>` if not already on a run branch
2. `git push -u origin <branch>`
3. `gh pr create --title <title> --body-file <bodyPath>`
4. record `prUrl` / `prNumber` in the checkpoint; publish `artifact.written`

**The main agent authors only the PR title and body**, from the plan, the execute
log, and the review report. Required body sections: *What changed* (per U-ID),
*Why*, *Verification* (gate commands that ran and their verdicts), *Review*
(P1–P3 findings that were accepted rather than fixed), *Rollback*.

Preconditions checked before step 1, each a hard block: `gh` present and
authenticated, an `origin` remote exists, the working tree is clean apart from
`.artifacts/`. `prompts/shipping.md` survives as the body-authoring prompt, not
as a skill.

**Output:** merged/deduped report at `.artifacts/review/<date>-review.md`.

---

## 7. Stage 5 · de-compound

**Inputs:** the execute log (§5.5) + the review report.

**Compound trigger — failure-only + notable wins:**

- **Failures always compound** — write `docs/solutions/<category>/<topic>.md`
  with Symptoms / Root cause / What failed / Fix / Prevention. Gate failures,
  scope violations, and P0 clusters all count as failures.
- **Successes** compound only if the main agent flags the run as a **reusable
  novelty** (new pattern, non-obvious solution). Avoids noise.

**Solutions path — fixed compound taxonomy (independent of Stage-0 tags):**
`docs/solutions/<category>/<topic>.md` where `category ∈ { bugs, migrations,
integrations, patterns }`.

**Glossary — SKIP:** no `CONCEPTS.md`.

**DONE gate:** Complete fires once the solutions doc (if any) is written.
**The PR may still be open** — there is no babysit stage in de-run.

**Teardown runs on every exit path, in a `finally`:** dispose any live child
sessions, release the run lock, write the terminal checkpoint. This applies
equally to the STOP exits in §3, §5.3, and §6.4 — a blocked run must not leave
sessions or locks behind.

---

## 8. Cross-cutting Tensions

### 8.1 Parallel execution vs. no dependency-edge field — RESOLVED

U-IDs carry no explicit dependency edges, but they now carry **`writeScope`
(§4)**, which is the actual input the DAG inference needs. Ordering = stated U-ID
sequence; safety = scope overlap. The residual risk — a child writing outside its
declared scope — is contained by the post-hoc `git status` check in §5.2 rather
than by any pre-hoc sandbox, because pi offers no per-child write-path allowlist.

### 8.2 Main agent judges and fixes; children implement

Executors implement units in parallel; the main agent judges every gate (§5.3),
applies every P0 fix (§6.4), and owns every commit (§5.4). Consequence: **git
history may contain fix-up commits** from the main agent's own re-edits.
Acceptable — commit-per-behavior realism, and judgment stays in one place.

### 8.3 Fixed 4 reviewers run even on untouched domains

e.g. `crm-reviewer` runs on a no-CRM diff and returns "no findings." Deliberate
coverage-over-efficiency. Cost, not correctness.

### 8.4 Same-tree parallelism

Three executors share one working tree. Chosen over git worktrees for simplicity
(no per-tree Prefect/Alembic env setup, no merge step). The trade is that
containment is detection-based (§5.2), not prevention-based.

---

## 9. Child-Role Roster (fresh-session specs)

| Role | Stage | Tools | Lens / system prompt | Inlined input | Output schema | Timeout |
|---|---|---|---|---|---|---|
| scope-subagent | 0 | read,grep,find,ls | classify into 5 tags; multi-tag allowed | `$ARGUMENTS` | `ScopeResult` | 3 min |
| scout (baseline 2 + tag extras) | 1 | read,grep,find,ls | one domain; cite `file:line` | scope index + its domain brief | `ScoutResult` | 10 min |
| plan-verify-agent | 1 | read,grep,find,ls | verify absence claims; block on unverifiable | all scouts' `absenceClaims` | `VerifyResult` | 10 min |
| lens-reviewer (×4) | 2 | read,grep,find,ls | review plan draft through one lens | full plan draft + dossier | `PlanReviewResult` | 8 min |
| **executor (×N, ≤3 concurrent)** | **3** | **read,grep,find,ls,edit,write,bash** | **implement exactly one U-ID; never run git** | **U-ID spec + `writeScope` + dossier excerpts** | `ExecutorResult` | **20 min** |
| reviewer (×4) | 4 | read,grep,find,ls | review diff; one lens | full diff + plan | `DiffReviewResult` | 10 min |

Schemas are defined in §12 and are the authoritative contract — the table names
them only.

Gate evaluation, P0 fixes, and all git operations are the main agent's, with no
child role. (§8.2)

---

## 10. Reusability Map (vs. the existing extension)

| Existing file | Verdict | Notes |
|---|---|---|
| `model-catalog.ts` | **Reuse verbatim** | `CATALOG`, `EXCLUDED_MODELS`, `resolveAvailable`, `makeRng`, `pickModel`. Add the `modelRegistry.find` resolution step at the call site (§1.2). |
| `state.ts` | **Keep, trim** | Runs-dir checkpoints, locks, `redact()`, compact summary all survive — they are what makes cross-session resume possible (§1.6). Drop CE-specific fields. `moaPrior` already removed. |
| `delegation-constants.ts` | **Drop** | pi-subagents protocol; not used natively. |
| `dispatcher.ts` | **Rewrite** | Replace with `spawnChild(role, task, inputs) → Promise<Result>` over `createAgentSession`, plus the 3-slot pool, allSettled fan-out, dispose-in-finally, abort plumbing, and schema validation. Keep the writer-overlap concept, now fed by U-ID `writeScope`. |
| `types.ts` | **Refactor** | New `Phase` enum: `Scope→Research→Plan→Execute→Review→Compound→Complete` (+`Paused`). Drop CE phases. Add `writeScope` to the U-ID shape. |
| `index.ts` | **Split** | Phase-machine logic → `core/pipeline.ts` (no `pi.*`); command/tool registration → `hosts/extension.ts`. MoA plumbing already stripped. See `de-run-runtime-spec.md` §1–§2. |
| `prompts/orchestrator.md` | **Rewrite** | de-run posture prompt. |
| `prompts/shipping.md` | **Keep, repurpose** | Becomes the PR title/body authoring prompt (§6.5). It is **not** a skill — `/ce-commit-push-pr` does not exist in this pi install. |
| Child role prompts | **New** | scope lens, scout lenses, executor lens, 4 review lenses. |

**Estimate:** ~25% verbatim reuse, ~30% refactor, ~45% new.

---

## 11. Open Questions

*(Resolved and moved into the body: drive loop §1.12, `de_advance` contract and
transition table §1.13, gate vocabulary §5.3, orphan recovery §5.6, shipping
§6.5, output schemas §12, artifact templates §13. Runtime/host decisions —
project home, target repo, testing — are in `de-run-runtime-spec.md` §2, §9,
§12.)*

1. If same-tree parallelism produces scope violations often enough to be
   annoying, escalate to git worktrees per unit (§8.4) — costs a merge step.
2. If "main agent sole judge+fixer" produces noisy fix-up commits, add an
   optional squash pass in the shipping step (post-Stage-4, pre-PR).
3. If "fixed 4 reviewers always" proves too costly on small diffs, a future
   toggle could skip a persona whose domain mapping is empty — relaxes a locked
   Stage-4 decision, so it requires explicit user sign-off.
4. Concurrency is capped at 3 globally. If provider rate limits bite before that
   ceiling, the cap becomes per-provider rather than global.

---

## 12. Child Output Schemas

Authoritative contract for §1.5. Each child's final assistant message must
contain **exactly one fenced ```json block** whose content parses and validates
against its role's schema. Text outside the block is ignored (models reliably
add a sentence or two); text *inside* it that isn't the object is a violation.

**Validation policy:** required fields are strict; unknown extra fields are
tolerated and dropped. A violation triggers the single repair prompt (§1.5),
then the retry-once path (§1.9).

**Shared types**

```ts
/** "path/to/file.py:120" or "path/to/file.py:120-134". Repo-relative, never absolute. */
type Citation = string;

type Severity = "P0" | "P1" | "P2" | "P3";

type ScopeTag =
  | "pipeline-new" | "pipeline-modify" | "crm-integration"
  | "schema-change" | "debug";
```

### 12.1 `ScopeResult` — scope-subagent (Stage 0)

```ts
interface ScopeResult {
  tags: ScopeTag[];              // ≥1; multi-tag allowed (§2)
  paths: string[];               // repo-relative dirs/files the task likely touches
  assumptions: string[];         // each phrased as a falsifiable statement
  ambiguous: boolean;            // true ⇒ core fires host.ui.select before writing the artifact
  ambiguityReason?: string;      // required when ambiguous is true
}
```

### 12.2 `ScoutResult` — scouts (Stage 1)

```ts
interface ScoutResult {
  domain: string;                // which scout brief this is answering
  findings: {
    claim: string;               // one sentence, present tense
    citations: Citation[];       // ≥1 — a finding with no citation is a violation
    relevance: "high" | "medium" | "low";
  }[];
  absenceClaims: {
    claim: string;               // "no existing migration handles X"
    searched: string[];          // globs/dirs actually searched
  }[];                           // may be empty; every entry is verified in §3
  openQuestions: string[];
}
```

The `citations: ≥1` rule is what makes the dossier's `file:line` requirement
enforceable rather than aspirational.

### 12.3 `VerifyResult` — plan-verify-agent (Stage 1)

```ts
interface VerifyResult {
  verdicts: {
    claim: string;                                    // echoed verbatim from the ScoutResult
    verdict: "confirmed" | "refuted" | "unverifiable";
    evidence: Citation[];                             // required for confirmed and refuted
    note?: string;                                    // required for unverifiable
  }[];
}
```

Any `unverifiable` verdict BLOCKS Stage 1 (§3). A `confirmed`/`refuted` verdict
with an empty `evidence` array is a schema violation, not a verdict.

### 12.4 `PlanReviewResult` — lens-reviewers (Stage 2)

```ts
interface PlanReviewResult {
  lens: "pipeline" | "schema" | "crm" | "idempotency";
  findings: {
    uId: string;                 // must match a U-ID in the draft
    severity: Severity;
    issue: string;
    suggestion: string;          // concrete, applyable — not "consider revisiting"
  }[];                           // empty array is a valid result
}
```

### 12.5 `ExecutorResult` — executors (Stage 3)

```ts
interface ExecutorResult {
  uId: string;
  summary: string;               // what was implemented, 1-3 sentences
  filesTouched: string[];        // repo-relative; core cross-checks against writeScope (§5.2)
  commands: {                    // everything the child ran, for the execute log
    cmd: string;
    exitCode: number;
  }[];
  incomplete?: string;           // set when the child could not finish; fails the gate
  notes: string[];               // anything the gate judge should know
}
```

`filesTouched` is the child's self-report and is **advisory only** — the
authoritative scope check is core's `git status` attribution (§5.2). A mismatch
between the two is logged in the execute log as a signal about that model.

### 12.6 `DiffReviewResult` — reviewers (Stage 4)

```ts
interface DiffReviewResult {
  lens: "pipeline" | "schema" | "crm" | "idempotency";
  findings: {
    file: string;                // repo-relative
    lineStart: number;           // 1-indexed
    lineEnd: number;             // ≥ lineStart
    symbol?: string;             // function/class when applicable
    severity: Severity;
    issue: string;
    suggestion?: string;
  }[];                           // empty array is the expected result for an untouched domain
}
```

`file` + `lineStart`/`lineEnd` are what §6.3's clustering keys on, which is why
they are required rather than free-text locations.

---

## 13. Artifact Templates

Every stage artifact carries the same front matter, so the compound stage and
future runs can index them:

```markdown
---
runId: <runId>
stage: scope | research | plan | execute | review
task: <original $ARGUMENTS, one line>
date: <ISO date>
tags: [<ScopeTag>, …]
---
```

| Artifact | Required sections |
|---|---|
| `.artifacts/scope/<date>-scope.md` | Task · Tags (with rationale) · Likely paths · Assumptions · Ambiguities resolved |
| `.artifacts/research/<date>-<topic>-research.md` | Per-scout findings (with `file:line`) · Verified absence claims · Refuted claims · Assumptions (labeled) · Open questions |
| `.artifacts/plan/<topic>-plan.md` | Summary · U-ID table (id, behavior, writeScope, gate, rollback, ownerScout, risks) · Sequencing rationale · Lens findings applied / declined |
| `.artifacts/execute/<date>-<topic>-execute.md` | Per U-ID: model, gate verdict, retries, commit SHA, scope violations, commands run · Orphan recoveries (§5.6) |
| `.artifacts/review/<date>-review.md` | P0 (and resolution) · P1–P2 (user-surfaced) · P3 (advisory) · Escalations (which clusters, which personas) · Rounds used |
| `docs/solutions/<category>/<topic>.md` | Symptoms · Root cause · What failed · Fix · Prevention |
