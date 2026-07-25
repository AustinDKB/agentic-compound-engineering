# Phase 3 — Execute, review, ship

> Paste everything below the line into a fresh pi session running
> `opencode-go/glm-5.2`, started from this repository's root.

---

Read **`BUILD-PROMPT.md`** in full first. It holds the standing brief: what to
read, the verified environment facts, the ten traps, and the rules that apply to
every phase. Everything below is specific to this phase.

**Prerequisite:** Phase 2 complete — stages 0–2 produce a plan whose U-IDs carry `writeScope`.

**Scope: issues #17–#23. Do not start any issue outside this list.**

## Build

**#17 core/gates.ts.** Allowlist across the five families in pipeline spec §5.3.
Match on **command head plus argument shape**, not substring — `pytest; rm -rf /`
is not a pytest invocation. Shell metacharacters force the confirm path
regardless of head. Anything outside the allowlist runs only after an explicit
`host.ui.confirm` showing the exact command.

**#18 core/execute.ts.** DAG inferred from `writeScope` overlap plus stated U-ID
order. A unit is ready when every earlier overlapping unit passed its gate;
launch up to 3. Executor children get write tools and are told **never to run
git**. Main agent judges each gate — no verifier child. Gate failure → one retry
with a re-picked model → second failure STOPs (in-flight siblings finish and are
judged; no new units launch). Atomic commit per U-ID via `git add <writeScope>`.

**#19 Git scope attribution.** The most important issue in this phase.

**#20 Orphan recovery.** Classify on resume; per orphaned unit present its diff
and `host.ui.ask()` for keep / re-run / discard. Write the diff to
`.artifacts/execute/orphaned/<runId>-<uId>.patch` **before any revert**. Resume
blocks until every orphan is resolved.

**#21 core/review.ts.** 4 reviewers always run. Cluster → count personas →
escalate → **then** dedup. Reviewer models pinned once per run. Max 3 rounds,
then STOP without shipping or compounding.

**#22 core/ship.ts.** Core does branch → push → `gh pr create` deterministically.
The agent authors only title and body via `prompts/shipping.md`. Hard-block
preconditions: `gh` authed, `origin` exists, tree clean apart from `.artifacts/`.

**#23 Stage 5 de-compound.** Failures always compound. Successes only on a
flagged reusable novelty. **Teardown in a `finally` on every exit path** —
dispose live children, release the lock, write the terminal checkpoint. This
applies to the STOP exits in stages 1, 3, and 4 too.

## Traps that bite in this phase

- **#19 is the one that will silently ruin runs.** Attribute changed paths
  against the **union of all live and committed unit scopes**, never the
  returning unit's scope alone. Three executors share one working tree, so a
  per-unit check sees siblings' in-progress edits and reports them as violations
  — reverting good work on essentially every unit. Write the concurrent-siblings
  test in a temp repo and watch it fail against the naive implementation first.
- **Escalate before dedup** in review merge. Deduping first destroys the evidence
  escalation counts.
- **Reviewer models pinned across rounds.** Re-rolling them makes the blocking
  gate non-deterministic and lets the loop oscillate — new reviewers raising new
  P0s on already-fixed code.
- `/ce-commit-push-pr` does not exist. Do not try to invoke it.

## Exit gate

```bash
bun test && npx tsc --noEmit && npm run check:layering
```

Plus the live check: **a full run against a scratch repo** that produces one
commit per U-ID, a clean review pass, and an open PR whose body has all five
required sections. Then kill the process mid-execute and resume — confirm the
orphan gate fires and the pre-revert patch exists on disk.

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
