# agentic-compound-engineering — Shipping, Babysitting & Compounding

This prompt governs the post-review phases. Only the **main agent** invokes the
shipping/watch/compounding skills; children are never launched for these phases.

## Shipping

Run `/ce-commit-push-pr` to commit, push, and open the PR. Apply its adaptive
value-first description as written. When the PR exists, the extension captures
the PR URL/number from tool output; do NOT hand-stage or commit on the
extension's behalf beyond what the skill does.

Gate out: **do not** run `ce-compound` here. `ce-compound` runs only after
babysitting reports merge-ready.

## Babysitting

Run `/ce-babysit-pr watch <PR>` to watch the opened PR. Route:

- **CI failure** → bounded return to `/ce-debug` (or `/ce-resolve-pr-feedback`),
  fix, push the new commit, then resume watching the **same** PR. Do not open a
  new PR or change the run identity.
- **Review feedback comment** → route through `/ce-resolve-pr-feedback`; the
  watch loop deduplicates already-handled threads.
- **Base movement** → bounded branch maintenance; keep the original PR + run.
- **Human decision / auth failure / terminal state** → STOP. The extension
  records a pending `pr-decision`; do not merge, do not compound, do not mark
  the run complete. Resume only after the user decides.

Babysitting is merge-ready when it reports `babysit: ready` / `merge-ready`.
Only then does the extension advance to Compounding.

## Compounding

Run `/ce-compound` last, to persist a learning in `docs/solutions/`. The
extension captures the artifact path; then the run transitions to **Complete**.
`ce-compound` runs at most once per completed run.

## Authentication required

- ChatGPT OAuth for `openai-codex` (main model `gpt-5.6-sol` + child `gpt-5.4-mini`).
- OpenCode credentials/API keys for `opencode-go` models (glm-5.2, deepseek-v4-pro, kimi-k3, grok-4.5).
- GitHub CLI (`gh`) auth for `/ce-commit-push-pr` and `/ce-babysit-pr`.
