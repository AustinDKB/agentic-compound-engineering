# Build de-run — standing brief

> **This is the shared context every build session needs.** The six phase prompts
> in [`build-prompts/`](build-prompts/) each open by telling the model to read
> this file first, then hand it one phase's scope.
>
> - **Six sessions (recommended):** paste `build-prompts/phase-N-*.md` into a
>   fresh pi session, one phase at a time. Each phase has its own exit gate and
>   ends by telling the model to stop.
> - **One session:** paste everything below the line and let it run all 31 issues.
>   Ambitious for GLM-5.2; the build order below is designed so a partial run is
>   still useful.

| Phase | Prompt | Issues | Milestones |
|---|---|---|---|
| 1 | `phase-1-bootstrap-spawner.md` | #1–#8 | M0, M1 |
| 2 | `phase-2-pipeline-core.md` | #9–#16 | M2 |
| 3 | `phase-3-execute-review-ship.md` | #17–#23 | M3 |
| 4 | `phase-4-web-server-main-bridge.md` | #24–#26 | M4 |
| 5 | `phase-5-child-panes.md` | #27–#28 | M5 |
| 6 | `phase-6-gates-tui-host.md` | #29–#31 | M6 |

---

You are implementing **de-run** end to end. The architecture is fully specified
and committed to this repo. Your job is to write the code, not to redesign it.

## Step 0 — read before writing anything

1. `de-run-pipeline-spec.md` — the whole file. What the pipeline does: six
   stages, global invariants, child roles, output schemas, artifact templates.
2. `de-run-runtime-spec.md` — the whole file. Where it runs: the host-agnostic
   core, the web UI and pi TUI hosts, the event contract, testing, security.
3. `prompts/lenses/scout.md` — the one child lens that already exists; it is the
   style reference for the others.
4. `gh issue list --limit 40` — 31 issues across milestones M0–M6. Each issue
   body names its spec section and, where one exists, the failure mode that makes
   it non-obvious.

**The specs are the contract. Do not edit them.** If you find a spec that is
wrong or impossible, stop and report it with the evidence — do not silently
deviate, and do not "improve" a decision that is already recorded.

## Environment facts — verified, do not re-derive

- SDK is `@earendil-works/pi-coding-agent`, installed globally at
  `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`. Its
  `docs/` and `dist/**/*.d.ts` are the authority on every API you use.
- Extensions and apps can runtime-import that package; the loader aliases it.
- Built-in tool names are exactly: `read`, `bash`, `edit`, `write`, `grep`,
  `find`, `ls`.
- `~/.pi/agent/skills/` contains **only** `lavish`. There is no
  `ce-commit-push-pr` and no `ce-babysit-pr` — shipping is implemented in core.
- These models exist in `~/.pi/agent/models-store.json`: `gpt-5.6-sol`,
  `gpt-5.4-mini`, `glm-5.2`, `deepseek-v4-pro`, `kimi-k3`, `grok-4.5`.
- Runtime and test runner: **bun**.
- There is no mixture-of-agents extension. Do not add model routing anywhere.

**Never invent an API.** Before calling anything on the SDK, confirm its
signature in `dist/**/*.d.ts` or `docs/`. A guessed method that type-checks
against `any` is the most likely way this build fails silently.

## Build order

Work milestone by milestone, issue by issue, in this order. Do not start a
milestone until the previous one's tests pass.

| Milestone | Issues | Gate to move on |
|---|---|---|
| M0 Bootstrap | #1 #2 #3 | `bun test` green, `tsc --noEmit` clean, `check:layering` passes |
| M1 Spawner | #4 #5 #6 #7 #8 | A real child session runs the scout lens and returns schema-valid JSON |
| M2 Pipeline core | #9 #10 #11 #12 #13 #14 #15 #16 | Stages 0–2 run end to end with a stub Host and no web UI |
| M3 Execute/review/ship | #17 #18 #19 #20 #21 #22 #23 | A full run produces commits and a PR |
| M4 Web server | #24 #25 #26 | Middle column and header live in the browser |
| M5 Child panes | #27 #28 | Six panes stream; steering works |
| M6 Gates | #29 #30 #31 | Every gate answerable in the browser; TUI host works |

**Issue #16 (the ~19 remaining prompts) is deliberately in M2, not M0.** Write
those lenses against real child output, not blind. Do not pull it forward.

## Traps — get these wrong and it will look like it works

These are the specific mistakes this design is built to avoid. Each is in the
specs; they are repeated here because they are the ones that pass review and
fail in production.

1. **Completion is `await session.prompt(task)`, never `agent_end`.** `agent_end`
   fires per low-level run and pi may still auto-retry, auto-compact, or drain
   queued messages afterward, so an `agent_end` handler inlines partial results.
2. **`createAgentSession` has no `systemPrompt` option.** Role lenses go through
   `new DefaultResourceLoader({ systemPromptOverride })` — a **separate loader
   instance per child**, each with `await loader.reload()`.
3. **Children must set `extensionsOverride` to empty.** Otherwise
   `DefaultResourceLoader` discovers `~/.pi/agent/extensions/*` and a child loads
   unrelated extensions, or de-run itself, and spawns recursively.
4. **Fan-out is `Promise.allSettled`, never `Promise.all`**, and every child is
   disposed in a `finally` — including on timeout and abort. A rejected
   `Promise.all` abandons in-flight siblings.
5. **`pickModel` returns provider/id strings; `createAgentSession` needs a
   `Model<any>`.** Resolve through `modelRegistry.find(provider, id)`. A miss is
   a child failure, not a silent default.
6. **Git scope attribution compares against the union of all live and committed
   unit scopes**, never the returning unit's scope alone. With three executors
   sharing a tree, a per-unit check flags every sibling's in-progress edits as
   violations and reverts good work. Issue #19 is this, and it needs the
   concurrent-siblings test.
7. **Escalate before dedup** in review merge. Deduping first destroys the
   evidence that escalation counts.
8. **Reviewer models are pinned once per run** and reused across all three
   rounds. Re-rolling them makes the blocking gate non-deterministic.
9. **`pi.appendEntry` data never reaches the LLM.** Anything the main agent must
   reason about is returned as a tool result.
10. **The web server refuses to start** on a non-loopback bind, and refuses to
    start outside a git work tree. Refusal, not a warning.

## Rules while you work

- **`core/` never imports `pi.*` or `ctx.*`.** Everything outward goes through
  the `Host` port. Run `npm run check:layering` before every commit; if it fails,
  you have put host code in core and must move it, not suppress the check.
- TypeScript strict mode. No `any` to make an error go away — if you need `any`,
  you have not read the right `.d.ts`.
- **Every module ships with tests, and no test makes a model call.** Use the stub
  Host and recorded fixtures from #8. The suite must stay gateable.
- **One commit per issue**, message ending `Closes #N`. Do not batch.
- If a decision is genuinely not covered by the specs, choose the simplest option
  consistent with them, write one line about it in `DECISIONS.md`, and keep
  moving. Do not stall and do not ask.
- If you are blocked by something real — a missing credential, an SDK method that
  does not exist, a spec contradiction — stop, report it precisely, and continue
  with every other issue that is not blocked by it.

## Verification you must run before declaring done

```bash
bun test                 # all green, no model calls
npx tsc --noEmit         # clean
npm run check:layering   # clean
```

Plus the two live smoke checks:

- **M2 smoke:** a real run through stages 0–2 against this repo, producing
  `.artifacts/scope/`, `.artifacts/research/`, and `.artifacts/plan/` with real
  citations. Confirm the research dossier's `file:line` references actually
  resolve.
- **M6 smoke:** start the web server, open the wireframe, drive a run far enough
  to answer one question modal and see at least two sub-agent panes stream
  concurrently.

## Definition of done

All 31 issues closed. `bun test`, `tsc --noEmit`, and `check:layering` clean. A
run started from the browser reaches Stage 5 and writes a compound doc, with the
PR opened by `core/ship.ts`.

Report at the end: which issues are closed, which are blocked and why, every
entry you added to `DECISIONS.md`, and anything in the specs you believe is wrong
now that you have implemented against them.

Begin with Step 0. Do not write code until you have read both specs in full.
