# Phase 1 — Bootstrap + Spawner

> Paste everything below the line into a fresh pi session running
> `opencode-go/glm-5.2`, started from this repository's root.

---

Read **`BUILD-PROMPT.md`** in full first. It holds the standing brief: what to
read, the verified environment facts, the ten traps, and the rules that apply to
every phase. Everything below is specific to this phase.

**Prerequisite:** None — this is the first phase.

**Scope: issues #1–#8. Do not start any issue outside this list.**

## Build

**#1 Repo tooling.** `package.json` (dependency on `@earendil-works/pi-coding-agent`),
`tsconfig.json` strict, `bun test` wired, and the directory layout from runtime
spec §2: `core/`, `hosts/`, `prompts/`, `templates/`, `tests/`. Move the existing
`.ts` files into place — `model-catalog.ts`, `state.ts`, `dispatcher.ts`,
`types.ts`, `index.ts` are the old CE extension and are being split, not kept
whole. `dispatcher.ts` and `delegation-constants.ts` are deleted outright.

**#2 check:layering.** `scripts/check-layering.ts` greps `core/` for
`ExtensionAPI`, `ExtensionContext`, `pi.registerCommand`, `pi.appendEntry`,
`pi.sendMessage`, `pi.events`, `ctx.ui`, `ctx.signal`. Wired into `npm run check`.
Build this **before** the code it guards.

**#3 core/catalog.ts.** Port `model-catalog.ts` verbatim, then add the missing
step: resolve a `CatalogModel` to a `Model<any>` via
`modelRegistry.find(provider, id)`.

**#4 core/schemas.ts.** The six schemas from pipeline spec §12 — `ScopeResult`,
`ScoutResult`, `VerifyResult`, `PlanReviewResult`, `ExecutorResult`,
`DiffReviewResult`. Plus the extractor: pull exactly one fenced json block from a
final assistant message; two blocks is a violation, prose around it is fine.
Strict on required fields, tolerant of unknown extras.

**#5 core/spawn.ts.** One function that builds every child identically — per-child
`DefaultResourceLoader` with `systemPromptOverride`, `extensionsOverride` empty,
`SessionManager.inMemory(cwd)`, per-role tool allowlist, resolved model.

**#6 Pool and lifecycle.** Worker pool capped at 3 concurrent children across all
stages. `Promise.allSettled` fan-out. Dispose in `finally`. Per-role `timeoutMs`.
`host.signal` → `session.abort()` → `dispose()`.

**#7 Repair and retry.** Schema violation → one repair prompt in the same session
→ second violation is a child failure → one retry as a fresh spawn **that
re-picks its model** → second failure blocks the stage.

**#8 Test harness.** Stub `Host` (scripted `ask()` answers, captured events,
controllable signal), fake child session, CLI harness to run one child by hand,
and `tests/fixtures/` with recorded outputs including deliberately malformed ones.

## Traps that bite in this phase

These are traps 1–5 in `BUILD-PROMPT.md`. All five live in `spawn.ts`:

1. Completion is `await session.prompt(task)`. **Never `agent_end`** — it fires
   per low-level run and pi may still auto-retry or compact afterward.
2. There is **no `systemPrompt` option** on `createAgentSession`. Role lenses go
   through `DefaultResourceLoader({ systemPromptOverride })`, one loader instance
   per child, each with `await loader.reload()`.
3. `extensionsOverride` must be empty, or a child loads the global extensions —
   or de-run itself — and spawns recursively.
4. `Promise.allSettled`, never `Promise.all`. Dispose in `finally`, including on
   timeout and abort.
5. `pickModel` returns strings; `createAgentSession` needs a `Model<any>`.

## Exit gate

```bash
bun test && npx tsc --noEmit && npm run check:layering
```

Plus the live check that matters: **spawn one real child** with
`prompts/lenses/scout.md` as its lens, pointed at this repository, and confirm it
returns JSON that passes `ScoutResult` validation with at least one citation that
actually resolves to a real line. If the scout returns findings with no citations,
the schema constraint is not wired up.

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
