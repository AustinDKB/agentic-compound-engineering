# de-run Pipeline — Architecture Specification

> **Status:** Architecture decision record + implementation contract.
> Replaces the generic agentic-compound-engineering CE pipeline with a
> domain-specific 6-stage flow for the **Prefect / Postgres(+Alembic) / CRM**
> stack. Built **natively** on the pi extension API — **no pi-subagents
> dependency**.

---

## 0. Overview

`de-run` is an autonomous orchestrator driven by `/de-run '<task description>'`.
It runs a deterministic 6-stage pipeline — **scope → research → plan → execute →
review → compound** — delegating bounded work to short-lived **child agent
sessions** and keeping judgment on the main agent (`openai-codex/gpt-5.6-sol`).

Children are **fresh `createAgentSession` sessions** (`SessionManager.inMemory()`),
each pinned to a fixed model from the catalog, with a scoped read-only tool set
and a role-specific system-prompt override. Scouts/reviews run concurrently via
`Promise.all` (true async). Only the **final assistant message** is inlined back
to the main agent; the streaming/thinking event stream is discarded.

### Implementation surface (native pi)

| Concern | Native mechanism |
|---|---|
| Run command | `pi.registerCommand("de-run", …)` |
| Orchestration / phase advance | Custom tool `de_advance` the main agent calls + `pi.sendMessage` continuations |
| Child execution | Fresh `createAgentSession({ model, tools, sessionManager: SessionManager.inMemory(), resourceLoader })` per child; `Promise.all` for parallel children |
| Durable run state | `pi.appendEntry("de-run:state", …)` + `sessionManager` (replaces custom `state.ts` runs-dir) |
| Scope/research/plan/review artifacts | `pi.appendEntry` for the index + repo-local markdown writers (the main agent's `write` tool) |
| Human gates | `ctx.ui.select` / `ctx.ui.confirm` / `ctx.ui.input` (native `ask_user` equivalent — no external extension required) |
| Lavish plan review | `pi.sendMessage` to hand the rendered plan to the user; resume on acceptance |
| MoA coordination | `pi.events.emit("moa:suspend", { token: "de-run" })` on run start; `pi.events.emit("moa:release", …)` on DONE |
| Model catalog | `model-catalog.ts` reused verbatim |

---

## 1. Global Invariants

These apply across **all stages** and are non-negotiable.

### 1.1 Main agent model

The main agent stays on `openai-codex/gpt-5.6-sol` for the entire run. Never
switch the main model. Never invoke Mixture-of-Agents routing for the main loop.

### 1.2 Child model catalog (reuse `model-catalog.ts` verbatim)

Each child spawn independently picks **one** model from the available catalog
(fresh random pick per spawn; no resume/reuse preference):

| Provider | Model |
|---|---|
| opencode-go | glm-5.2 |
| opencode-go | deepseek-v4-pro |
| opencode-go | kimi-k3 |
| opencode-go | grok-4.5 |
| openai-codex | gpt-5.4-mini |

`kimi-k2.7-code` is **intentionally excluded**. Unavailable/unauthenticated
entries are warned-once and skipped (reuse `resolveAvailable`). **No Anthropic
`sonnet`/`haiku` pinning** (the old `.mmd` wrongly pinned reviewers to Claude
tiers — corrected here). Because each child is created with an explicit `model`,
per-turn MoA routing is moot inside the child even if the MoA extension loads.

### 1.3 Child output posture (CRITICAL, global)

- `createAgentSession` is created with `SessionManager.inMemory()` — its
  transcript is **not persisted** and is discarded on `dispose()`.
- The child's **streaming/thinking event stream is never read into the main
  agent's context.** Only subscribe for completion detection / lifecycle.
- On `agent_end`, the **final assistant message** is extracted from
  `session.agent.state.messages` and inlined back to the main agent (returned
  from the tool / emitted via `pi.sendMessage` with `customType: "de-run:child-result"`).
- "Final result only, not all the thinking."

### 1.4 MoA coordination

On run start: `pi.events.emit("moa:suspend", { token: "de-run" })`.
On DONE (Stage 5 complete): `pi.events.emit("moa:release", { token: "de-run" })`.
Suppresses per-turn MoA routing **without mutating the user's manual MoA
preference.** A manual `/moa` toggle while suspended stays after release.

### 1.5 Stale-guard / generation

Every run carries a `generation` counter bumped on each phase advance. A
continuation carrying an older generation is ignored — never act on stale state.
A restart never silently skips unfinished work: illegal transitions, failed
gates, and human-decision pauses are preserved as `paused`/`failed` checkpoints
(via `pi.appendEntry`).

### 1.6 Native vocabulary (what we do NOT use)

We do **not** use the pi-subagents delegation protocol. There is no
`SubagentDelegationRequest`, no `run_in_background` flag, no
`get_subagent_result`, no `isolated:true` (these were fictional in the old
`.mmd`). The native primitives are: `createAgentSession`, `Promise.all`,
`session.prompt`, `agent_end`, `session.dispose()`.

---

## 2. Stage 0 · de-scope

**Inputs:** `$ARGUMENTS` (raw task description from `/de-run`).

**Steps:**

1. Main agent emits `moa:suspend` and creates the run checkpoint (generation 0).
2. A **dedicated scope subagent** — a fresh `createAgentSession` with an explicit
   catalog-picked model and a scope-lens system-prompt override — classifies
   `$ARGUMENTS` against the 5 fixed categories and May assign **multiple tags**.
3. Scope subagent returns its final classification inline.

**Categories (hardcoded to this stack):**
`pipeline-new`, `pipeline-modify`, `crm-integration`, `schema-change`, `debug`.

**Ambiguity:** multiple tags are allowed (e.g. `schema-change` AND `debug`). If
two tags tie or none match, the scope subagent flags it; the main agent surfaces
via `ctx.ui.select` (`ask_user`) to disambiguate before writing the artifact.

**Outputs (both formats):**

- `pi.appendEntry("de-run:scope", { tags, paths, assumptions, runId, generation })`
  — the **JSON index** consumed programmatically by Stage 1.
- Human-readable `.artifacts/scope/<date>-scope.md` (written by the main agent's
  `write` tool).

**Failure handling:** scope subagent gets **one retry** (fresh dispatch) on
error/timeout; a second failure BLOCKS and surfaces to the user.

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

Count and subjects vary per task; no wasted scouts.

**Execution — background async, generous budget:**
All selected scouts are created as fresh `createAgentSession`
(`SessionManager.inMemory()`, explicit catalog model, **read-only tools**
`["read", "grep", "find", "ls"]`, generous thinking budget) and **run
concurrently via `Promise.all`**. The main turn awaits all of them.

**Absence-claim verification — post-collect Plan agent, BLOCKING:**
After all scouts settle, **one Plan agent** (fresh session, read-only) re-scans
the codebase to verify every "absent / not-found" claim a scout made (e.g. "no
existing migration handles X"). Each claim must be confirmed or refuted with
`file:line` evidence. **An unverifiable claim BLOCKS Stage 1** — surfaced to the
user before proceeding to planning.

**Output (research dossier):**

- Full dossier written to `.artifacts/research/<date>-<topic>-research.md`
  with `file:line` citations, verified claims, and **assumptions labeled**.
- Each scout's **final result is inlined** into the main agent's context (global
  posture §1.3) — these are genuinely the planning inputs.

**Failure handling — retry once, then block:**
Each failed/timed-out scout gets a **single automatic retry** (fresh
`createAgentSession` dispatch). A second failure BLOCKS and surfaces to the
user. No silent partial research.

---

## 4. Stage 2 · de-plan

**Inputs:** the research dossier (inlined) + the Stage-0 tags.

**Plan-review FLOW (six sequential sub-steps):**

1. **Main agent drafts** the initial plan by working through the checklist
   (failure modes, idempotency, migrations, rate-limits, credentials) and
   sequencing U-IDs in dependency order.
2. **Reviewer subagents review the initial draft through lenses** — fresh
   sessions, each pinned to a catalog model, each given one of the 4 domain
   lenses (pipeline / schema / crm / idempotency). Run concurrently via
   `Promise.all`. Return JSON findings inline.
3. **Main agent collects findings → `ask_user` (native `ctx.ui.select` /
   `ctx.ui.confirm`) which findings to apply** to the primary plan.
4. Main agent **applies the chosen findings** to the plan.
5. **Render the plan via Lavish** — the main agent produces the Lavish artifact
   and hands it to the user via `pi.sendMessage`.
6. **Human interacts with the Lavish plan to nitpick** before execution. Resume
   only on acceptance.

**Confirm gate:** `ask_user` **always** fires before execution, regardless of
plan size or risk. No auto-proceed threshold.

**Unit size — one U-ID per behavior:** a U-ID is a coherent behavior (e.g. "add
CRM retry wrapper") that may span multiple files/migrations in one atomic
commit. Not one-per-file.

**Plan content per U-ID (full spec):**

- `gate` — pass/fail criteria.
- `rollback` — rollback strategy.
- `ownerScout` — which scout found / motivated this unit.
- `risks` — flagged risks.

**Explicit dependency-edge field: NO.** (See tension §8.1.)

**Storage (dual):**

- `pi.appendEntry("de-run:plan", { uIds, planHash, runId, generation })` — JSON
  index.
- Human-readable `.artifacts/plan/<topic>-plan.md`.

---

## 5. Stage 3 · de-execute

**Inputs:** the plan (U-IDs in stated order) + the Stage-0 tags.

**Execution concurrency — parallel where deps allow:**
The dependency DAG is **inferred** from `writeScope` overlap (the existing
writer-overlap concept) plus the main agent's stated U-ID order. Independent
subtrees may run concurrently. (See tension §8.1.)

**Gate evaluation — main agent judges:**
The main agent reads each executed diff + the U-ID's `gate` criteria and decides
pass/fail. **No dedicated verifier child.** (Tension §8.2.)

**Gate failure policy — retry the unit once, then STOP:**
A failed unit gets a **single retry** (the main agent re-implements / re-runs).
A second failure **STOPs** and surfaces to the user; later U-IDs are not touched.

**Commits:** an **atomic commit per U-ID**, with the U-ID referenced in the
commit message, **kept local** during Stage 3. (No push yet — see §6.)

**Shipping — lightweight step, but fires AFTER Stage 4:**
A lightweight shipping step reuses the existing `/ce-commit-push-pr` skill, but
it fires only **after Stage 4 is P0-clean**. So Stage 3 produces local commits;
push + PR happen post-review.

**Concurrency guard (writer overlap):** two units whose `writeScope` overlap
MUST NOT run concurrently — the inferred DAG blocks the second until the first's
gate passes.

---

## 6. Stage 4 · de-review

**Inputs:** the local Stage-3 commits (the diff).

**Reviewers — fixed 4, always run:**
`pipeline-reviewer`, `schema-reviewer`, `crm-reviewer`, `idempotency-reviewer`
— the same 4 lenses used at Stage-2 plan review, now run on the actual diff.
**Always run, even on untouched domains** (deliberate coverage-over-efficiency;
a persona whose domain didn't change simply returns "no findings"). (Tension §8.3.)

Each reviewer is a fresh `createAgentSession` (read-only tools, catalog model,
single-lens system-prompt override); all four run concurrently via `Promise.all`.

**Severity & escalation — .mmd tiers:**

- **P0 = block** — must fix before ship.
- **P1–P2 = human** — surfaced to the user.
- **P3 = advisory** — logged in the report only.
- **Escalate one tier** when **2+ personas flag the same location.**

**Fix loop — main agent edits + re-runs review:**
On P0, the **main agent applies fixes directly** (no executor child for review
fixes), then **re-dispatches the 4 reviewers** over the new diff. Loop until no
P0s. (Tension §8.2.)

**Shipping order — ship after review passes:**
Once P0-clean, the lightweight shipping step fires: push + PR via `/ce-commit-push-pr`.
The PR contains reviewed code.

**Output:** each reviewer inlines its JSON findings array; the merged/deduped
review report is written to `.artifacts/review/<date>-review.md`.

---

## 7. Stage 5 · de-compound

**Inputs:** the execute log + the review report.

**Compound trigger — failure-only + notable wins:**

- **Failures always compound** — write `docs/solutions/<category>/<topic>.md`
  with Symptoms / Root cause / What failed / Fix / Prevention.
- **Successes** only compound if the main agent flags the run as a **reusable
  novelty** (new pattern, non-obvious solution). Avoids noise.

**Solutions path — fixed compound taxonomy (independent of Stage-0 tags):**
`docs/solutions/<category>/<topic>.md` where `category ∈ { bugs, migrations,
integrations, patterns }`. (Not the Stage-0 classification tags — a separate,
prose-oriented taxonomy.)

**Glossary — SKIP:** no `CONCEPTS.md`. (The old `.mmd` mentioned it; dropped.)

**DONE gate — compound doc written + token released:**
Complete fires once the solutions doc (if any) is written. The extension then
emits `pi.events.emit("moa:release", { token: "de-run" })` and restores the
user's MoA preference. **The PR may still be open** — there is **no babysit
stage** in de-run; babysitting is out of scope.

---

## 8. Cross-cutting Tensions (recorded, not resolved)

### 8.1 Parallel execution (Stage 3) vs. no dependency-edge field (Stage 2)

U-IDs carry gate/rollback/owner-scout/risks but **no explicit dependency-edge
field**, yet execution may parallelize.
**Resolution candidate:** infer the dependency DAG from `writeScope` overlap
(reuse the existing writer-overlap guard logic) + the main agent's stated U-ID
order. No new manual field to author. Must be specified in the executor
implementation.

### 8.2 Main agent is the sole judge + sole fixer

The main agent judges every U-ID gate (Stage 3) AND applies every P0 fix
(Stage 4). No executor/verifier children in these loops. Consequence: **git
history may contain fix-up commits** from the main agent's own re-edits.
Acceptable (commit-per-behavior realism); just intentional.

### 8.3 Fixed 4 reviewers run even on untouched domains

e.g. `crm-reviewer` runs on a no-CRM diff and returns "no findings." Deliberate
coverage-over-efficiency. Cost, not correctness.

---

## 9. Child-Role Roster (fresh-session specs)

| Role | Stage | Tools | System-prompt lens | Concurrency |
|---|---|---|---|---|
| scope-subagent | 0 | read,grep,find,ls | classify into 5 tags; multi-tag allowed | single |
| scout (baseline 2 + tag extras) | 1 | read,grep,find,ls | one domain; cite file:line | `Promise.all` |
| plan-verify-agent | 1 | read,grep,find,ls | verify absence claims; block on unverifiable | single (post-collect) |
| lens-reviewer (×4) | 2 | read,grep,find,ls | review initial plan draft through one lens | `Promise.all` |
| reviewer (×4: pipeline/schema/crm/idempotency) | 4 | read,grep,find,ls | review diff; return JSON findings | `Promise.all` |

**Executor (Stage 3) and gate-evaluation/fix (Stage 3+4) are done by the main
agent directly — no child role for those.** (Tension §8.2.)

---

## 10. Reusability Map (vs. the existing extension)

| Existing file | Verdict | Notes |
|---|---|---|
| `model-catalog.ts` | **Reuse verbatim** | `CATALOG`, `EXCLUDED_MODELS`, `resolveAvailable`, `makeRng`, `pickModel`. Perfect fit; children pick fresh. |
| `state.ts` | **Drop / replace** | Use native `pi.appendEntry` + `sessionManager` for run checkpoints instead of the custom runs-dir layout. Keep `redact()` if secrets appear in artifacts. |
| `delegation-constants.ts` | **Drop** | pi-subagents protocol; not used natively. |
| `dispatcher.ts` | **Drop / rewrite** | Replace with a fresh-session spawner (`spawnChild(model, lens, task, reads) → Promise<finalResult>`) using `createAgentSession`. Keep the writer-overlap-guard concept for Stage-3 parallelism. |
| `types.ts` | **Refactor** | New `Phase` enum: `Scope→Research→Plan→Execute→Review→Compound→Complete` (+`Paused`). Drop CE phases. |
| `index.ts` | **Refactor heavily** | New phase machine, new command `/de-run`, native `pi.registerTool`/`pi.on`/`pi.appendEntry`/`pi.events` usage. |
| `prompts/orchestrator.md` | **Rewrite** | de-run posture prompt (rules 1–5 carry over as principles). |
| `prompts/shipping.md` | **Keep** | reused via `/ce-commit-push-pr`. |
| Child skill/role files | **New** | scope lens, 4 review lenses, scout lenses. |

**Estimate:** ~25% verbatim reuse, ~25% refactor, ~50% new.

---

## 11. Open Questions (none blocking — see §8)

1. If Stage 3 parallelism via inferred DAG proves error-prone, fall back to
   strict sequential (Stage-3 decision can relax).
2. If "main agent sole judge+fixer" produces noisy fix-up commits, add an
   optional squash pass in the lightweight shipping step (post-Stage-4, pre-PR).
3. If "fixed 4 reviewers always" proves too costly on small diffs, a future
   toggle could skip a persona whose domain mapping is empty — but that relaxes
   the locked Stage-4 decision, so requires explicit user sign-off.
