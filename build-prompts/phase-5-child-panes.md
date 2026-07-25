# Phase 5 — Child panes

> Paste everything below the line into a fresh pi session running
> `opencode-go/glm-5.2`, started from this repository's root.

---

Read **`BUILD-PROMPT.md`** in full first. It holds the standing brief: what to
read, the verified environment facts, the ten traps, and the rules that apply to
every phase. Everything below is specific to this phase.

**Prerequisite:** Phase 4 complete — the middle column and header stream live.

**Scope: issues #27–#28. Do not start any issue outside this list.**

## Build

**#27 Child stream bridge + pane lifecycle.** Per-child `session.subscribe()`
tagged with `childId` → `child.started` / `child.block` / `child.ended`.
`child.block.type` is `thinking | tool | text`, which is exactly the three-way
split `templates/wireframe.html.j2` already renders as `msg-thinking`,
`msg-tool`, and `log-text`.

Panes are **per-child, not per-slot**, and persist after completion:
`queued` (dimmed, no body) → `live` (streaming) → `done`/`failed` (frozen, status
chip). Stage 1 can create six scouts total with three live at once — both numbers
in the wireframe are correct, they measure different things. The column already
has `overflow-auto`.

**#28 Child steering.** The `.agent-message` input in each pane calls
`childSession.steer(text)` on a **live** child. Queued, done, and failed children
are **rejected**, not silently dropped. Steering is echoed into the pane as a
`text` block so the transcript stays honest about why the child changed course.

## Traps that bite in this phase

- **The two-channel rule.** A child's full stream goes to the display, always.
  Only the schema-validated final message crosses into the main agent's context.
  Never inject stream content into the main session — not via `sendMessage`, not
  as a tool result, not as a context file. Runtime spec §5 exists because getting
  this backwards is both easy and expensive.
- **Steering does not exempt a child from its output contract.** The final message
  still goes through schema validation and the retry path.
- **Steering resets the idle timer but not the hard `timeoutMs`.** A user must not
  be able to turn a bounded worker into an unbounded one.
- Hide the steering input entirely when `capabilities.childSteering` is false.

## Exit gate

```bash
bun test && npx tsc --noEmit && npm run check:layering
```

Plus the live check: drive a run to Stage 1 with enough tags to spawn four or more
scouts, and confirm **three panes stream concurrently** while a fourth sits
queued and dimmed, then takes a slot as one finishes. Steer one live child and
confirm the message appears in its pane and changes what it does. Confirm the
main agent's transcript contains none of the child stream.

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
