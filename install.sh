#!/usr/bin/env bash
# agentic-compound-engineering — install script
#
# Downloads the complete ce-babysit-pr skill bundle from the pinned upstream
# EveryInc/compound-engineering-plugin revision and copies the extension +
# agents into ~/.pi/agent/. It does not touch your settings.json or any other
# installed CE skill/agent.
#
# Run from the repo root: ./install.sh
set -euo pipefail

PI_AGENT="${HOME}/.pi/agent"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Upstream Every.to Compound Engineering revision that ships the full
# ce-babysit-pr bundle (SKILL.md + references/watch-loop.md + scripts/pr-snapshot).
# Do not change without verifying the skill contract is intact.
BABYSIT_COMMIT="b7a09f4035c33ba006939593f89c5e4e304f0201"
BABYSIT_BASE="https://raw.githubusercontent.com/EveryInc/compound-engineering-plugin/${BABYSIT_COMMIT}/skills/ce-babysit-pr"
BABYSIT_FILES=("SKILL.md" "references/watch-loop.md" "scripts/pr-snapshot")

confirm() {
  printf 'This will install into %s. Continue? [y/N] ' "$PI_AGENT"
  read -r ans
  case "${ans,,}" in y|yes) ;; *) echo "Aborted."; exit 1 ;; esac
}

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }
}

need cp
need mkdir
need curl

echo "agentic-compound-engineering installer"
echo "--------------------------------------"

if [ ! -d "$PI_AGENT" ]; then
  echo "Pi agent dir not found at $PI_AGENT — is Pi installed?"
  echo "  npm i -g @earendil-works/pi-coding-agent"
  exit 1
fi
confirm

echo
echo "== 1/4  extensions =="
mkdir -p "$PI_AGENT/extensions/agentic-compound-engineering/prompts" \
         "$PI_AGENT/extensions/agentic-compound-engineering/tests"
cp "$SCRIPT_DIR/extensions/agentic-compound-engineering"/*.ts \
   "$SCRIPT_DIR/extensions/agentic-compound-engineering"/*.json \
   "$PI_AGENT/extensions/agentic-compound-engineering/" 2>/dev/null || true
[ -f "$SCRIPT_DIR/extensions/agentic-compound-engineering/README.md" ] && \
  cp "$SCRIPT_DIR/extensions/agentic-compound-engineering/README.md" \
     "$PI_AGENT/extensions/agentic-compound-engineering/"
cp "$SCRIPT_DIR/extensions/agentic-compound-engineering/prompts/"* \
   "$PI_AGENT/extensions/agentic-compound-engineering/prompts/"
cp "$SCRIPT_DIR/extensions/agentic-compound-engineering/tests/"*.ts \
   "$PI_AGENT/extensions/agentic-compound-engineering/tests/"
[ -f "$SCRIPT_DIR/extensions/mixture-of-agents.ts" ] && \
  cp "$SCRIPT_DIR/extensions/mixture-of-agents.ts" "$PI_AGENT/extensions/mixture-of-agents.ts"
echo "  copied extension + mixture-of-agents.ts"

echo
echo "== 2/4  agent definitions =="
mkdir -p "$PI_AGENT/agents"
cp "$SCRIPT_DIR"/agents/agentic-compound-*.md "$PI_AGENT/agents/"
echo "  copied $(ls "$SCRIPT_DIR"/agents/agentic-compound-*.md | wc -l) agent files"

echo
echo "== 3/4  ce-babysit-pr skill bundle (from EveryInc/compound-engineering-plugin@${BABYSIT_COMMIT:0:7}) =="
DEST="$PI_AGENT/skills/ce-babysit-pr"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
ok=1
for f in "${BABYSIT_FILES[@]}"; do
  mkdir -p "$STAGE/$(dirname "$f")"
  code=$(curl -fsSL -w '%{http_code}' -o "$STAGE/$f" "$BABYSIT_BASE/$f" 2>/dev/null || echo "000")
  if [ "$code" != "200" ] || [ ! -s "$STAGE/$f" ]; then
    echo "  FAILED to fetch $f (HTTP $code)"
    ok=0
  fi
done
if [ "$ok" -ne 1 ]; then
  echo
  echo "Babysit bundle incomplete. NOT installing a partial skill directory."
  echo "Re-run once the network/upstream is available."
  exit 1
fi
chmod +x "$STAGE/scripts/pr-snapshot"
rm -rf "${DEST}.old.$$"
[ -d "$DEST" ] && mv "$DEST" "${DEST}.old.$$"
mv "$STAGE" "$DEST"
rm -rf "${DEST}.old.$$" 2>/dev/null || true
echo "  installed $DEST"
echo "  files present: $(find "$DEST" -type f | wc -l)"

echo
echo "== 4/4  reminder: enable models in settings.json =="
echo "  Add to ~/.pi/agent/settings.json > enabledModels (if missing):"
echo "    \"openai-codex/gpt-5.6-sol\","
echo "    \"openai-codex/gpt-5.4-mini\","
echo "    \"opencode-go/glm-5.2\", \"opencode-go/deepseek-v4-pro\","
echo "    \"opencode-go/kimi-k3\", \"opencode-go/grok-4.5\""
echo
echo "  And ensure packages include:"
echo "    \"npm:pi-subagents\", \"npm:pi-ask-user\""
echo "  (run: pi install npm:pi-subagents ; pi install npm:pi-ask-user)"

echo
echo "Done. (Re)start Pi, then: /agentic-compound-engineering start"