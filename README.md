# de-run

An autonomous orchestrator for a **Prefect / Postgres(+Alembic) / CRM** data
stack, built natively on the pi SDK.

`de-run '<task>'` runs a deterministic 6-stage pipeline — **scope → research →
plan → execute → review → compound** — delegating bounded work to short-lived
child agent sessions while all judgment stays with a single main agent pinned to
`openai-codex/gpt-5.6-sol`.

## Status

**Pre-implementation.** The architecture is fully specified; the code is being
built against it. See the open issues for the unit-by-unit breakdown.

## Specifications

| Document | Defines |
|---|---|
| [`de-run-pipeline-spec.md`](de-run-pipeline-spec.md) | *What* the pipeline does — six stages, global invariants, child roles, output schemas, artifact templates |
| [`de-run-runtime-spec.md`](de-run-runtime-spec.md) | *Where it runs* — the host-agnostic core, the web UI and pi TUI hosts, the event contract, testing, security |
| [`New Architecture.mmd`](New%20Architecture.mmd) | The pipeline as a flow diagram |

## Shape

```
            ┌──────────────────────────┐
   web ui ──┤                          │
            │   core/  (SDK only)      ├── child sessions (createAgentSession)
   pi TUI ──┤   phase machine, spawner │── main session   (createAgentSession)
            │   gates, artifacts       │
            └──────────────────────────┘
```

One orchestrator core, two hosts. The **web UI** — a three-column operational
view of the main agent, the live sub-agent fan-out, and the phase state — is the
primary target. The **pi TUI** host is a degraded but functional fallback, so a
broken web build never costs you the pipeline.

`core/` may import SDK primitives only; it never touches `pi.*` or `ctx.*`.
Everything outward goes through the `Host` port.

## Key decisions

- **Children are fresh, pinned, disposable sessions.** Each picks one model from
  a five-model catalog, gets a role lens as its system prompt, and returns a
  schema-validated JSON result. Only that final result reaches the main agent's
  context — never the thinking stream, which goes to the UI instead.
- **Executors run in parallel, up to three at once**, over one working tree.
  Safety comes from per-unit declared `writeScope` plus a post-hoc git
  attribution check, not from a sandbox.
- **The main agent judges every gate and owns every commit.** Implementation is
  delegated; judgment is not.
- **No mixture-of-agents routing anywhere.** The main model is pinned for the
  whole run by construction.

## Predecessor

This repository previously held the generic Compound Engineering pipeline
extension. de-run replaces it with a domain-specific flow for this stack; the
prior tree remains in the git history.

## License

MIT © Austin Bakanec
