# agentic-compound-engineering

A global Pi extension that keeps the main agent on `openai-codex/gpt-5.6-sol`,
persists a **resumable** Compound Engineering pipeline, and delegates bounded
work to one-model-per-run subagents. The extension owns state, commands,
dispatch plumbing, and model assignment; the main agent owns judgment.

## Install / prerequisites

- `pi install npm:pi-subagents` (delegation API)
- `pi install npm:pi-ask-user` (blocking `ask_user` for Compound skills)
- `ce-babysit-pr` bundle installed from Compound Engineering commit
  `b7a09f4035c33ba006939593f89c5e4e304f0201` (`SKILL.md` + `references/watch-loop.md` + `scripts/pr-snapshot`).
- `openai-codex/gpt-5.4-mini` and `openai-codex/gpt-5.6-sol` enabled in `~/.pi/agent/settings.json`.
- RTK official Pi adapter at `~/.pi/agent/extensions/rtk.ts` (RTK ≥ 0.23.0).

## Command surface — `/agentic-compound-engineering`

| Subcommand | Behavior |
|------------|----------|
| `start`  | Preflight (model auth, `subagent` tool, `ce-babysit-pr` skill) → create run, suspend MoA, repin `gpt-5.6-sol`, queue brainstorm. |
| `status` | Print the compact run summary (phase, gate, todos, children, artifacts). |
| `pause`  | Checkpoint `Paused`, release MoA token, suppress prompts. **Keeps state.** |
| `resume` | Reacquire MoA token, repin `gpt-5.6-sol`, bump generation, continue at pending gate. |
| `off`    | Suppress prompts + release MoA token, **retain** the checkpoint. Deleting a run is a separate maintenance action. |

Footer status: a single width-safe line `ACE: <phase> [off]`.

## Phases & gates

```
Brainstorming → Planning → PlanReview → Implementing ⇄ Verifying
  → Simplifying → CodeReview → Shipping → Babysitting → Compounding → Complete
```

- **Brainstorming** — child `agentic-compound-brainstormer`; unresolved product
  blockers become a main-agent `ask_user` gate before planning.
- **Planning** — fan out the 5 read-only research children (repo, learnings,
  framework, best-practices, flow); all settle, then the main agent runs
  `/ce-plan` (pipeline posture) and renders via Lavish. Plan-file detection sets the
  plan hash for the doc-review child.
- **PlanReview** — child `agentic-compound-doc-reviewer` reviews the **post-Lavish**
  plan hash; main agent applies accepted findings; todos are created from plan U-IDs.
- **Implementing** — child `agentic-compound-implementer` per U-ID, dependency order;
  no concurrent writers on overlapping files (extension-enforced).
- **Verifying** — independent child `agentic-compound-verifier`; approve marks the
  unit done; reject returns it to implementation.
- **Simplifying** — child `agentic-compound-simplifier`; targeted re-verify afterward.
- **CodeReview** — child `agentic-compound-code-reviewer`; required fixes applied +
  re-verified before shipping.
- **Shipping** — main agent runs `/ce-commit-push-pr`; extension captures the PR URL.
- **Babysitting** — main agent runs `/ce-babysit-pr watch`; route CI/review feedback
  to debug/resolve loops; **pauses on human decisions** — never auto-merges.
- **Compounding** — main agent runs `/ce-compound`; extension records the learning
  artifact, marks Complete, and releases the MoA suspension token.

## Child model catalog (R15)

One model chosen per child run and persisted before launch (never re-randomized on
resume — preserves provider-side cache locality):

| Provider | Model |
|----------|-------|
| opencode-go | glm-5.2 |
| opencode-go | deepseek-v4-pro |
| opencode-go | kimi-k3 |
| opencode-go | grok-4.5 |
| openai-codex | gpt-5.4-mini |

`kimi-k2.7-code` is intentionally excluded. Unavailable/unauthenticated entries are
warned-once and skipped. Children run with an explicit model and never inherit
per-turn MoA routing (`PI_SUBAGENT_PARENT_SESSION` suppresses MoA in child processes).

## MoA coordination (R2)

While a run is active, the extension emits `moa:suspend` (token
`agentic-compound-engineering`) on the shared `pi.events` bus. MoA's per-turn
routing is suppressed **without mutating the user's manual preference**. On
`off`/`pause`/complete it emits `moa:release`. Multiple owners must all release.
A manual `/moa` toggle while suspended stays after release.

## State location (operational, not source-controlled)

```
~/.pi/agent/agentic-compound-engineering/runs/<cwd-hash>/
  registry.json            compact discovery index (no transcripts)
  <runId>/state.json       checkpoint (user-only, redacted)   [Paused|Active|Complete]
  <runId>/artifacts.json   artifact store
  <runId>/.lock            pid + mtime run lock
```

On `session_start` the extension reconciles the branch-local checkpoint (authoritative)
with the registry (discovery) and acquires the run lock. A restart never silently
skips unfinished work: illegal transitions, failed gates, and human-decision pauses
are preserved as `failed`/`paused` checkpoints.

## Recovery

- **Missing provider/auth**: `start` preflight blocks with the exact blocker; the
  prior checkpoint is untouched.
- **Malformed state**: quarantined (renamed `.quarantined-<ts>`); never treated as a
  valid completed gate.
- **Stale queued continuation / late child response**: tagged with run generation;
  an older generation cannot advance a newer checkpoint.
- **Interrupted Lavish review**: persists a `lavish-review` pending decision; resume
  after the user accepts.
- **Blocked PR decision**: babysitting pauses; resume after the user decides.

## Verification (how this was tested)

Stub harness (`tests/harness.ts`) + `bun test` cover: catalog resolution & seeded
distribution (R15); MoA suspension + child isolation (R2/R14); durable state,
registry, redaction, locks (R3/R17); dispatcher fixed-model persistence,
backpressure, writer-overlap guard, file-only artifacts (R5/R10/R14); orchestration
gate sequence, todo loop, verifier-reject retry, plan-file detection, bounded
prompts (R5-R9); shipping/babysit/compounding ordering, single-compound guard (R13).
Type correctness via `tsc --noEmit` against the installed `@earendil-works` `.d.ts`.
No live PRs or paid model calls are used as the primary automated test path.

## Files

- `index.ts` — extension factory, commands, state, MoA coordination, orchestration engine.
- `state.ts` — durable state, registry, locks, redaction, compact summary.
- `model-catalog.ts` — multi-provider child catalog + seeded assignment.
- `dispatcher.ts` — typed pi-subagents v1 delegation, backpressure, writer guard.
- `types.ts` — shared state shapes.
- `prompts/orchestrator.md` + `prompts/shipping.md` — orchestration & shipping posture.
- `tests/*.test.ts` — stub harness + per-unit tests.
