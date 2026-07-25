# Phase 2 — Pipeline core

> Paste everything below the line into a fresh pi session running
> `opencode-go/glm-5.2`, started from this repository's root.

---

Read **`BUILD-PROMPT.md`** in full first. It holds the standing brief: what to
read, the verified environment facts, the ten traps, and the rules that apply to
every phase. Everything below is specific to this phase.

**Prerequisite:** Phase 1 complete — `bun test` green and a real child returns schema-valid JSON.

**Scope: issues #9–#16. Do not start any issue outside this list.**

## Build

**#9 core/store.ts.** Runs-dir checkpoints keyed by `runId` holding phase,
generation, `pausedPhase`, `blockedPhase`, `ownerSession`, U-ID states, commit
SHAs. Run lock. `redact()` carried over from `state.ts`. Resume classification:
committed / never-started / orphaned.

**#10 core/pipeline.ts.** The drive loop from pipeline spec §1.12 — one
`await session.prompt()` per stage, publishing `phase.changed` on entry. **A
non-advancing stage gets one re-prompt** with the reason, then blocks. No
watchdog: `prompt()` resolves on settle, so an unmoved generation means the stage
ended.

**#11 de_advance.** Params `to`, `artifactPath`, `summary`, `gateMet`,
`blockReason?`. Validation in order, first failure returns an error and leaves
state untouched: legal transition → generation match → artifact exists and
non-empty → `gateMet:false` records a block → otherwise advance. Full transition
table from §1.13. `Paused`/`Blocked` are entered by core, **never named by the
agent** as a `to` target.

**#12 Stage 0 de-scope.** Scope subagent classifies into the 5 tags, multi-tag
allowed. `ambiguous: true` → `host.ui.ask()` before the artifact is written.

**#13 Stage 1 de-research.** Baseline 2 scouts plus tag-driven extras, through
the 3-slot pool, every input inlined. Then one plan-verify agent re-checks every
absence claim with `file:line` evidence. **An unverifiable claim blocks the
stage.**

**#14 Stage 2 de-plan.** Draft → 4 lens reviewers concurrently → findings via
`host.ui.ask()` (multiSelect) → apply → Lavish render → human nitpick. The
confirm gate always fires. U-IDs carry `gate`, `rollback`, `ownerScout`, `risks`,
and **`writeScope: string[]` (required)**.

**#15 Artifact writers.** Shared front matter on every artifact; required
sections per pipeline spec §13. The execute log is required, not optional —
Stage 5 consumes it.

**#16 The remaining ~19 lens prompts.** Orchestrator posture, scope/plan-verify/
executor lenses, the 4 domain lenses **parameterized over target** (the same lens
reviews a plan at Stage 2 and a diff at Stage 4 — write 4, not 8), 6 scout domain
briefs, 6 stage continuation prompts, the Stage-2 planning checklist, and the
per-role schema instruction blocks.

**Write #16 last, after #12–#14 have produced real child output.** That output is
the reason this issue is in this phase instead of phase 1. Read what the models
actually returned, then write the lens that fixes what went wrong.

## Traps that bite in this phase

- **`pi.appendEntry` data never reaches the LLM.** Every JSON index the main
  agent must reason about — scope tags, plan U-IDs — is returned as a **tool
  result**. This is trap 9 and it is silent: the run appears to work while the
  agent reasons from nothing.
- The runs-dir is the single source of truth. A session-scoped store cannot
  resume a run in a new session.
- Re-entry from `Paused`/`Blocked` bumps the generation, so in-flight
  continuations are stale by construction.

## Exit gate

```bash
bun test && npx tsc --noEmit && npm run check:layering
```

Plus the live check: **a real run through stages 0–2 against this repository**,
producing `.artifacts/scope/`, `.artifacts/research/`, and `.artifacts/plan/`.
Open the research dossier and confirm its `file:line` citations resolve to the
lines claimed. Confirm the plan's U-IDs each carry a `writeScope`.

This is the first point where you learn whether the lens prompts are any good.
If the dossier is thin or the citations are wrong, fix the lenses before moving on
— every later phase inherits this quality.

## Rules for this phase

- One commit per issue, message ending `Closes #N`.
- `core/` never imports `pi.*` or `ctx.*`. Run `npm run check:layering` before
  every commit.
- No test may make a model call.
- Decision not covered by the specs? Pick the simplest consistent option, add one
  line to `DECISIONS.md`, keep moving.
- **Stop when this phase's exit gate passes.** Do not start the next phase.

## Report at the end

Issues closed, issues blocked and why, `DECISIONS.md` entries added, and anything
in the specs you now believe is wrong having implemented against it.
