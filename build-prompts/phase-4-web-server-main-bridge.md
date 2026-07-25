# Phase 4 — Web server + main bridge

> Paste everything below the line into a fresh pi session running
> `opencode-go/glm-5.2`, started from this repository's root.

---

Read **`BUILD-PROMPT.md`** in full first. It holds the standing brief: what to
read, the verified environment facts, the ten traps, and the rules that apply to
every phase. Everything below is specific to this phase.

**Prerequisite:** Phase 3 complete — a full run reaches Stage 5 headlessly.

**Scope: issues #24–#26. Do not start any issue outside this list.**

## Build

**#24 hosts/web/server.ts.** HTTP serves the rendered shell, `output.css`, and
`client.js`; WebSocket carries all live traffic. Client→server messages:
`prompt`, `dialog_response`, `child_steer`, `abort`, `resume`.

**#25 Ring buffer + replay.** Last N events (default 2000) per run. Client sends
its last `seq` on reconnect; server replays everything after it. Every event
carries `seq`, `runId`, `generation`.

**#26 Main bridge + header.** `session.subscribe()` → `message.delta`
(text and thinking), `message.end`, `tool.call` → the middle column's existing
`.msg-user` / `.msg-thinking` / `.msg-response` classes. Input row → `prompt`.
Header stats read in-process: context % from `contextUsage.percent`, cache % from
`cacheRead / (cacheRead + input)`, thinking level.

`templates/wireframe.html.j2` becomes the **shell** — `render.py` renders the
static skeleton with empty-state data at build time, `client.js` hydrates it live.
No framework. Keep the existing Tailwind output and DOM structure; you are wiring
the markup that exists, not redesigning it.

## Traps that bite in this phase

- **The server refuses to start on a non-loopback bind.** Refusal, not a warning.
  The UI drives executor children holding `bash`, `write`, and `edit`, so anyone
  who reaches the port runs arbitrary commands as the user. Same for a `cwd`
  outside a git work tree.
- **Run `redact()` over event payloads before they leave core.** Scouts read
  `.env` files and will quote them.
- A page refresh mid-run must restore the full UI. That is what #25 is for; it is
  a requirement for an operational tool, not a nicety.

## Exit gate

```bash
bun test && npx tsc --noEmit && npm run check:layering
```

Plus the live check: start the server, open the page, send a prompt from the
input row, and watch assistant text stream into the middle column with the header
stats updating. Then **refresh the page mid-turn** and confirm the conversation
rebuilds from replay rather than coming back empty.

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
