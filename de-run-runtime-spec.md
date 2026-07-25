# de-run Runtime & Host Specification

> **Status:** Architecture decision record + implementation contract.
> Companion to `de-run-pipeline-spec.md`, which defines *what* the pipeline does
> (stages, invariants, child roles). This document defines *where it runs*: the
> orchestrator core, the two hosts that drive it, and the event contract between
> them.
>
> **Primary target:** a full operational web UI matching `wireframe.html`.
> **Also supported:** the pi TUI, as a degraded but functional fallback.

---

## 0. Posture

One orchestrator core, two hosts.

```
            ┌──────────────────────────┐
   web ui ──┤                          │
            │   core/  (SDK only)      ├── child sessions (createAgentSession)
   pi TUI ──┤   phase machine, spawner │── main session   (createAgentSession)
            │   gates, artifacts       │
            └──────────────────────────┘
```

The web host is where the product lives. The extension host exists so that a
broken web build never costs you the pipeline, and so `/de-run` still works from
a terminal. Everything in `de-run-pipeline-spec.md` §1–§7 is host-agnostic and
lives in `core/`.

---

## 1. The dependency rule (non-negotiable)

**`core/` may import SDK primitives only. It must never import or reference
`pi.*`, `ctx.*`, or any extension-host type.** Every interaction with the outside
world goes through the `Host` port (§3).

Permitted in `core/`: `createAgentSession`, `SessionManager`,
`DefaultResourceLoader`, `SettingsManager`, `ModelRuntime`, `defineTool`,
`getAgentDir`, `node:*`.
Forbidden in `core/`: `ExtensionAPI`, `ExtensionContext`, `pi.registerCommand`,
`pi.appendEntry`, `pi.sendMessage`, `pi.events`, `ctx.ui`, `ctx.signal`.

**Enforcement:** a `check:layering` script greps `core/` for the forbidden
identifiers and fails the build. This is worth automating on day one — the rule
is nearly free to honor up front and a rewrite to retrofit, because `ctx.ui` and
`pi.appendEntry` calls otherwise thread themselves through every stage.

---

## 2. Module layout

**The codebase moves to a standalone git repo** (e.g. `~/code/de-run`) with its
own `package.json`, `tsconfig.json`, and tests. Nothing in
`~/.pi/agent/extensions/agentic-compound-engineering` is version-controlled
today, which is reason enough on its own. The TUI host is wired back in by
registering its path in pi's `settings.json`:

```json
{ "extensions": ["/home/austin/code/de-run/dist/hosts/extension.js"] }
```

```
de-run/
  core/
    host.ts        # Host port + DeRunEvent union (types only, no logic)
    pipeline.ts    # phase machine, drive loop, de_advance, transition table
    spawn.ts       # child sessions, 3-slot pool, schema validation + repair
    schemas.ts     # the six child output schemas (pipeline spec §12)
    gates.ts       # verification command allowlist + confirm escape (§5.3)
    execute.ts     # writeScope DAG, git scope attribution, gate loop, orphan recovery
    review.ts      # cluster → escalate → dedup, 3-round cap
    ship.ts        # branch/push/gh pr create (pipeline spec §6.5)
    store.ts       # runs-dir checkpoints, locks, redact()  (from state.ts)
    catalog.ts     # model-catalog.ts verbatim + registry resolution
  hosts/
    extension.ts   # pi extension adapter (TUI)
    web/
      server.ts    # http + ws, localhost only
      client.js    # browser hydration over the Jinja shell
  prompts/         # orchestrator posture + role lenses
  templates/
    wireframe.html.j2
  tests/
    fixtures/      # recorded child outputs (golden JSON)
```

---

## 3. The Host port

```ts
export interface Host {
  readonly mode: "web" | "extension";
  readonly capabilities: HostCapabilities;
  readonly ui: HostUI;
  readonly signal: AbortSignal;
  /** Display-only sink. Never routed into any LLM context. */
  publish(event: DeRunEvent): void;
}

export interface HostCapabilities {
  /** Host can render per-child live streams (right column). */
  childStreams: boolean;
  /** Host can deliver mid-flight steering to an individual child. */
  childSteering: boolean;
}

export interface HostUI {
  /** Rich multi-option gate. The primary surface for every stage gate. */
  ask(questions: Question[]): Promise<Answer[]>;
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(label: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

export interface Question {
  /** Short chip label, ≤12 chars — "Scope tag", "Findings", "Orphan U3". */
  header: string;
  question: string;
  options: { label: string; description: string }[];   // 2-4
  multiSelect: boolean;
  /** Free-text "Other" escape. Default true. */
  allowOther?: boolean;
}

export interface Answer {
  header: string;
  /** Chosen option labels, or the free-text value when the user picked Other. */
  values: string[];
  other?: string;
  cancelled?: boolean;
}
```

`ask()` is the gate surface; `select`/`confirm`/`input` remain for one-off
prompts that don't warrant the full component. Every gate in the pipeline spec
(§2 tag disambiguation, §4.3 findings selection, §4.6 plan acceptance, §5.3 gate
command escape, §5.6 orphan recovery) is an `ask()` call.

Core **always** publishes the full event stream; hosts decide what to render.
`capabilities` exists so core can skip work a host cannot use — with
`childStreams: false` it emits `child.started`/`child.ended` but suppresses
per-delta `child.block` events rather than generating thousands of no-ops.

A `HostUI` method that a host cannot satisfy must **reject**, never silently
resolve. Pipeline spec §1.8 (gates block when no UI is available) is implemented
by that rejection.

---

## 4. Event contract

One versioned discriminated union. Every event carries `seq` (monotonic per run),
`runId`, and `generation`, so a reconnecting client can replay from a cursor and
so stale events are droppable by the same rule as pipeline spec §1.10.

| Event | Payload | Feeds |
|---|---|---|
| `run.started` | `{ task, runId }` | whole UI |
| `run.blocked` | `{ stage, reason, detail }` | notification + phase state |
| `run.complete` | `{ artifacts[] }` | phase state |
| `phase.changed` | `{ phase, index, status: "pending"\|"active"\|"done"\|"blocked", desc }` | left column |
| `todos.changed` | `{ items: [{ id, text, status }] }` | header |
| `stats.changed` | `{ contextPercent, cachePercent, thinkingLevel }` | header |
| `message.delta` | `{ msgId, role: "user"\|"thinking"\|"assistant", text }` | middle column |
| `message.end` | `{ msgId }` | middle column |
| `tool.call` | `{ msgId, name, summary }` | middle column |
| `child.started` | `{ childId, role, model, uId?, paneSlot }` | right column |
| `child.block` | `{ childId, type: "thinking"\|"tool"\|"text", text }` | right column |
| `child.ended` | `{ childId, status: "ok"\|"failed"\|"timeout"\|"aborted", summary }` | right column |
| `dialog.request` | `{ dialogId, method, title, message?, options? }` | modal |
| `dialog.response` | `{ dialogId, value?, confirmed?, cancelled? }` | client → server |
| `artifact.written` | `{ path, stage }` | notification |

`child.block.type` is deliberately the same three-way split the wireframe
template already renders (`msg-thinking` / `msg-tool` / `log-text`).

---

## 5. Child streams: display vs. context

**This is the clarification that makes the web UI possible.** There are two
distinct channels out of a child session:

| Channel | Content | Governed by |
|---|---|---|
| **To the display** | the full stream — thinking deltas, tool calls, text | this document |
| **To the main agent's LLM context** | the final validated message only | pipeline spec §1.4, §1.5 |

Pipeline spec §1.4's "the child's streaming/thinking stream is never read into the
main agent's context" constrains the **second** channel only. Forwarding a child's
full stream to a UI pane is fully compatible with it and is the entire point of
the right column.

**Neither host may inject child stream content into the main session** — not via
`pi.sendMessage`, not as a tool result, not as a context file. The only thing
that crosses into the main agent is the schema-validated final message.

---

## 6. Wireframe binding

`templates/wireframe.html.j2` becomes the **shell**: `render.py` renders the
static skeleton with empty-state data at build time, and `client.js` hydrates it
live from the WebSocket. No framework; the existing Tailwind `output.css` and DOM
structure stay as they are.

| Region | Existing hook | Driven by | Notes |
|---|---|---|---|
| Header stats | `.stat` | `stats.changed` | Context % from `contextUsage.percent`; Cache % derived from `cacheRead / (cacheRead + input)`; Thinking from session state. Read in-process — no RPC round trip. |
| Header to-do | `.todo-item` | `todos.changed` | Checkboxes are **display-only status reflections**, not inputs. |
| Left column | `.step`, `.step-title`, `.step-desc` | `phase.changed` | 7 steps map to the pipeline as: Scope→Stage 0, Research→1, Plan→2, Execute→3, Review→4, **Ship→Stage 4's post-P0-clean shipping step (§6.5)**, Compound→5. `.step-desc` carries the live gate text, replacing the placeholder. |
| Middle bubbles | `.msg-user` / `.msg-thinking` / `.msg-response` | `message.delta` / `message.end` / `tool.call` | Direct map from `session.subscribe()` `text_delta` / `thinking_delta` / `tool_execution_*`. |
| Middle input row | `input[type=text]` + Submit | client → `prompt` | Sends to the main session. Disabled while the question modal is open (§6.1). |
| Right column boxes | `.agent-box`, `.agent-title`, `.agent-body` | `child.*` | One pane per child; see §6.2. |
| Per-agent input | `.agent-message` | client → `child_steer` | See §7. Hidden entirely when `capabilities.childSteering` is false. |

### 6.1 The question modal — a required new component

The wireframe has no gate surface. It needs one, and it is the single most
load-bearing piece of new UI: **every human gate in the pipeline blocks the run
until this component answers.** A run cannot complete without it, which is why it
is a milestone-6 deliverable rather than a nicety.

**Shape.** Modal over the middle column, dimming but not hiding the phase and
sub-agent columns — the user needs the surrounding context to answer well.

```
┌─ Scope tag ───────────────────────────────┐
│ Two tags tie for this task. Which applies?│
│                                           │
│  ◉ schema-change                          │
│    Adds a column to customers; needs a    │
│    migration and a backfill.              │
│                                           │
│  ○ debug                                  │
│    The reported symptom is a failing      │
│    nightly run, not a schema gap.         │
│                                           │
│  ○ Other…  [_______________________]      │
│                                           │
│                        [ Cancel ] [ OK ]  │
└───────────────────────────────────────────┘
```

**Requirements:**

- Renders 1–4 questions per `ask()` call, answered in sequence within one modal.
- `header` renders as a chip; each option shows **label plus description** —
  descriptions are what make a gate answerable without re-reading the artifact.
- `multiSelect: true` renders checkboxes (Stage-2 findings selection needs it);
  otherwise radios.
- **"Other" free-text** is present unless `allowOther: false`. The Stage-0 tag
  gate and the orphan gate both need an escape the option list didn't anticipate.
- Keyboard-first: ↑/↓ to move, Space to toggle, Enter to confirm, Esc to cancel.
- **Cancel is a real answer**, not a dismissal: it returns `cancelled: true`, and
  core turns that into a `human-decision` block (pipeline spec §1.8). The modal
  must not be dismissable by clicking the backdrop — an accidental click cannot
  be allowed to block a run.
- **Survives reconnect.** A pending dialog is re-emitted on reconnect (§8); the
  component rebuilds from the `dialog.request` payload alone, holding no state
  the server doesn't have.
- While a modal is open the main input row is disabled — the run is blocked and
  typing at it would be a lie.

**Transport.** `dialog.request` carries `{ dialogId, method: "ask", questions }`;
the client replies `dialog.response` with `{ dialogId, answers }`. The existing
`select`/`confirm`/`input` methods keep their simpler payloads.

### 6.2 Pane lifecycle vs. the concurrency cap

The wireframe shows six panes; pipeline spec §1.7 caps **live** children at 3.
Both are correct — they measure different things. Stage 1 can produce six scouts
in total, three at a time.

Panes are therefore **per-child, not per-slot**, and persist after completion:

- `queued` — created on enqueue, dimmed, no body yet
- `live` — streaming `child.block` events
- `done` / `failed` — frozen, retains its final body and a status chip

`paneSlot` on `child.started` is a stable ordinal for layout; the column scrolls
(`overflow-auto` is already on the container).

---

## 7. Child steering

The wireframe's "Message this agent…" input is a real capability, and it only
works in the web host.

- Implemented as `childSession.steer(text)` on the live child. Delivered after
  that child's current turn finishes its tool calls, before its next LLM call.
- **Only while the child is `live`.** Steering a `queued`, `done`, or `failed`
  child is rejected by the server, not silently dropped.
- Steering text is recorded in the run log and echoed into the pane as a
  `child.block` of type `text` so the transcript stays honest about why the
  child changed course.
- **Steering does not exempt the child from its output contract.** Its final
  message still goes through schema validation and the repair/retry path
  (pipeline spec §1.5, §1.9).
- Steering resets the child's idle timer but **not** its hard `timeoutMs`
  (pipeline spec §9) — a user cannot accidentally turn a bounded worker into an
  unbounded one.
- Extension host: `capabilities.childSteering = false`, input hidden.

---

## 8. Web transport

- **Bind `127.0.0.1` only.** See §11.
- HTTP serves the rendered shell, `output.css`, and `client.js`. WebSocket
  carries everything live. No JSONL framing concerns — WS frames are already
  message-delimited.
- **Client → server messages:** `prompt`, `dialog_response`, `child_steer`,
  `abort`, `resume`.
- **Replay.** The server keeps a ring buffer of the last N events (default 2000)
  per run. A client reconnecting sends its last `seq`; the server replays
  everything after it. A page refresh mid-run must restore the full UI — for an
  operational tool this is a requirement, not a nicety.
- **Dialogs** are a request/response pair keyed by `dialogId`, backed by a
  promise registry on the server. An unanswered dialog at disconnect stays
  pending and is re-emitted on reconnect; the run stays blocked meanwhile, per
  pipeline spec §1.8.
- **Abort** trips the `AbortController` behind `Host.signal`, which core plumbs
  to `session.abort()` + `dispose()` on every live child (pipeline spec §1.4).

---

## 9. Bootstrap

```ts
const { session } = await createAgentSession({
  cwd,
  agentDir: getAgentDir(),                        // picks up auth.json + models.json
  model: registry.find("openai-codex", "gpt-5.6-sol"),
  sessionManager: SessionManager.create(cwd),     // persisted — NOT inMemory
  resourceLoader: mainLoader,
  customTools: [deAdvance, /* stage tools */],
});
```

- **Main session is persisted.** Children are `SessionManager.inMemory()` per
  pipeline spec §1.3.
- **Main loader keeps skills** (`~/.pi/agent/skills/` discovery) so
  `/ce-commit-push-pr` still works via `session.prompt("/ce-commit-push-pr")`.
- **Main loader sets `extensionsOverride` to empty** — in the web host, de-run is
  the application, and unrelated global extensions (`metrics-header.ts`, `rtk.ts`,
  `python_sniper`) should not load into it.
- Auth needs no new code: `agentDir` defaults resolve the existing openai-codex
  OAuth and opencode-go credentials.
- **`cwd` is `process.cwd()`.** The server is launched from inside the target
  repo; one server serves one repo. `.artifacts/` and `docs/solutions/` resolve
  relative to it, matching how the pi TUI already behaves. The server **refuses
  to start** if `cwd` is not inside a git work tree — every stage from §5 onward
  assumes git.
- Reference implementations: `examples/sdk/12-full-control.ts`,
  `13-session-runtime.ts`, `09-api-keys-and-oauth.ts`.

---

## 10. TUI degradation matrix

| Capability | Web host | Extension host |
|---|---|---|
| Main conversation | full stream, middle column | native TUI transcript |
| Phase state | left column, live | `ctx.ui.setWidget("de-run:phase", …)` |
| Stats | header, live | `ctx.ui.setStatus` footer line |
| Todos | header | widget lines |
| **Child streams** | **full per-delta panes** | **aggregated only** — one widget line per child (`role · model · status · elapsed`); `capabilities.childStreams = false` |
| **Child steering** | **yes** | **no** |
| **Human gates** | **question modal (§6.1) — full `ask()`** | `ctx.ui.select` per question, sequentially; descriptions appended to option labels; no multi-select (asked as repeated single-selects) |
| Artifacts | notification + path | `ctx.ui.notify` |

The extension host registers `/de-run` via `pi.registerCommand` and the
`de_advance` tool via `pi.registerTool`; the web host exposes the same two as a
WS message and a `customTools` entry respectively. Both construct a `Host` and
hand it to the identical `core/` entry point.

---

## 11. Security posture

The web UI drives executor children that hold `bash`, `write`, and `edit`. **Anyone
who can reach the port can run arbitrary commands as you.** Therefore:

- Bind `127.0.0.1` only. If a configured bind address is not loopback, the server
  **refuses to start** rather than warning.
- No auth layer is in scope, which is exactly why no non-loopback bind is
  permitted. Remote access, if ever wanted, is a separate design with a real
  token handshake.
- Run `redact()` (kept from `state.ts`) over event payloads and artifacts before
  they leave core — child output can quote `.env` contents or connection strings
  it read while scouting.
- Executor children are told not to run `git` (pipeline spec §5.1); that is a
  correctness boundary, not a security one. Do not rely on it for containment.

---

## 12. Testing

**Automated: stub `Host` + recorded fixtures.** No model calls, no cost,
deterministic — the suite must be gateable on every commit.

| Target | Covered by |
|---|---|
| Transition table, illegal edges, stale generation | stub `Host`, synthetic `de_advance` calls |
| Drive loop, incl. the non-advancing stage → re-prompt → block path | fake session whose `prompt()` resolves without advancing |
| `writeScope` DAG readiness and the 3-slot pool | synthetic plans, no sessions |
| **Git scope attribution (§5.2)** | temp git repo, scripted concurrent edits — must prove a sibling's in-progress files are *not* reported as violations |
| Review clustering, escalation, dedup, 3-round cap | synthetic `DiffReviewResult` sets |
| Schema validation, repair prompt, retry, block | `tests/fixtures/` golden child outputs, incl. deliberately malformed ones |
| Orphan recovery (§5.6) | temp repo with uncommitted edits + scripted `host.ui.select` answers |
| Gate allowlist, incl. `pytest; rm -rf /` and metacharacter rejection | unit tests on `core/gates.ts` |

Fixtures are recorded from real runs once and committed, so the validator — which
is load-bearing under pipeline spec §1.5 — never ships untested.

**Manual:** one scripted end-to-end run against a scratch repo before any
release. Real models, real cost, not gateable.

---

## 13. Milestones

1. **`schemas.ts` + `spawn.ts` + pool + validation**, exercised by a CLI harness
   with a stub `Host`. Everything downstream depends on it. Needs one real lens
   prompt (scout) to exercise end-to-end.
2. **`pipeline.ts` + `store.ts` + drive loop**, driven by a script, artifacts on
   disk. Stages 0–2 run end-to-end with no UI — the fastest way to find out
   whether the lens prompts are any good, and the point at which the remaining
   ~19 prompts get written against real output.
3. **`execute.ts` + `gates.ts` + `ship.ts`.** Stages 3–4 land; runs produce
   commits and a PR.
4. **Web server + main-agent bridge.** Middle column and header go live.
5. **Child bridge.** The six panes go live. `capabilities.childStreams = true`.
6. **Question modal + dialog protocol (§6.1).** Every human gate works in the
   browser; the run is fully operational end to end. Nothing ships without this
   — a gate that cannot be answered is a run that cannot finish.

The extension host is built last, against the frozen `Host` port, and should be
small — if it isn't, the §1 dependency rule has been violated somewhere.

---

## 14. Non-goals

- Multi-user, authentication, remote access (§11).
- Replacing the pi TUI as a general coding interface — the extension host drives
  de-run only.
- Rendering child transcripts into the main agent's context, ever (§5).
- A babysit stage. The run completes with the PR open (pipeline spec §7).
