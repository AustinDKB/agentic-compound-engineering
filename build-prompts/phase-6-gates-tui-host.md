# Phase 6 — Gates + TUI host

> Paste everything below the line into a fresh pi session running
> `opencode-go/glm-5.2`, started from this repository's root.

---

Read **`BUILD-PROMPT.md`** in full first. It holds the standing brief: what to
read, the verified environment facts, the ten traps, and the rules that apply to
every phase. Everything below is specific to this phase.

**Prerequisite:** Phase 5 complete — sub-agent panes stream and steering works.

**Scope: issues #29–#31. Do not start any issue outside this list.**

## Build

**#29 Question modal.** The single most load-bearing piece of new UI: every human
gate blocks the run until this component answers, so a run cannot complete
without it. The wireframe has no gate surface today — you are adding one.

Modal over the middle column, dimming but not hiding the phase and sub-agent
columns; the user needs surrounding context to answer well. 1–4 questions per
`ask()` call, answered in sequence in one modal. `header` renders as a chip. Each
option shows **label plus description** — the descriptions are what make a gate
answerable without re-reading the artifact. `multiSelect` → checkboxes, else
radios. Free-text "Other" unless `allowOther: false`. Keyboard-first: arrows,
Space, Enter, Esc.

**#30 Dialog transport.** `dialog.request` → `dialog.response` keyed by
`dialogId`, with a promise registry on the server. An unanswered dialog at
disconnect **stays pending** and is re-emitted on reconnect; the run stays blocked
meanwhile.

**#31 hosts/extension.ts.** The pi TUI adapter, built last against the frozen
`Host` port. `/de-run` via `pi.registerCommand`, `de_advance` via
`pi.registerTool`. `ask()` degrades to sequential `ctx.ui.select` calls with
descriptions appended to labels and multi-select asked as repeated single-selects.
`publish()` → `setStatus`/`setWidget` with `childStreams: false` (one aggregated
line per child) and `childSteering: false`. `ctx.signal` → `host.signal`.

**#31 should be small. If it isn't, host code has leaked into `core/`** — find it
and move it rather than growing the adapter.

## Traps that bite in this phase

- **Cancel is a real answer**, returning `cancelled: true`, which core turns into
  a `human-decision` block. It is not a dismissal.
- **The modal must not be dismissable by backdrop click.** An accidental click
  cannot be allowed to block a run.
- **The component holds no state the server lacks** — it rebuilds from the
  `dialog.request` payload alone. That is what makes reconnect work.
- Disable the main input row while a modal is open. The run is blocked; letting
  the user type at it is a lie.

## Exit gate

```bash
bun test && npx tsc --noEmit && npm run check:layering
```

Plus the two live checks that close out the whole build:

1. **A complete run driven entirely from the browser** — start it from the input
   row, answer the Stage-0 tag gate, the Stage-2 findings gate (multi-select), and
   the plan acceptance gate in the modal, and watch it reach Stage 5 and write a
   compound doc with the PR opened by `core/ship.ts`. Refresh the page **while a
   gate is open** and confirm the modal comes back pending.
2. **The same run started from the pi TUI** via `/de-run`, confirming the gates
   degrade to sequential selects and the aggregated child lines appear.

## Final report

All 31 issues closed. Beyond the standing report, state: which spec sections you
found wrong or incomplete while implementing, and what the six lens prompts
needed that the spec did not anticipate.

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
