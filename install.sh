#!/usr/bin/env bash
#
# install.sh — set up cc-sessions.
#
# Installs the tracker hook + CLI into ~/.claude, wires the Claude Code hooks,
# and puts `cc-sessions` on your PATH. macOS only. Safe to re-run (idempotent).
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$REPO_DIR/src"

# --- preflight ---------------------------------------------------------------
if [[ "$(uname)" != "Darwin" ]]; then
  echo "cc-sessions is macOS-only (it drives Apple Terminal via AppleScript)." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH. Install Node.js first, then re-run." >&2
  exit 1
fi

SCRIPTS_DIR="$HOME/.claude/scripts"
SETTINGS="$HOME/.claude/settings.json"

mkdir -p "$SCRIPTS_DIR" "$HOME/.claude/open-sessions"

# --- 1. copy scripts into place ----------------------------------------------
cp "$SRC_DIR/session-tracker.js"      "$SCRIPTS_DIR/session-tracker.js"
cp "$SRC_DIR/cc-sessions.js"          "$SCRIPTS_DIR/cc-sessions.js"
cp "$SRC_DIR/restore-tabs.applescript" "$SCRIPTS_DIR/restore-tabs.applescript"
chmod +x "$SCRIPTS_DIR/cc-sessions.js" "$SCRIPTS_DIR/session-tracker.js"
echo "Installed scripts to $SCRIPTS_DIR"

# --- 2. merge hooks into settings.json ---------------------------------------
# SessionStart/SessionEnd register & deregister sessions; Stop refreshes the
# snapshot after every response. Existing hooks are preserved.
CC_SETTINGS="$SETTINGS" node <<'MERGE_EOF'
const fs = require('fs');
const path = require('path');
const file = process.env.CC_SETTINGS;
let j = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim()) {
    try {
      j = JSON.parse(raw);
    } catch (e) {
      const backup = file + '.bak';
      fs.writeFileSync(backup, raw);
      console.error(`\nERROR: ${file} exists but is not valid JSON (${e.message}).`);
      console.error(`A backup was saved to ${backup}. Refusing to overwrite your settings.`);
      console.error('Fix the JSON (or move the file aside) and re-run install.sh.');
      process.exit(1);
    }
  }
}
j.hooks = j.hooks || {};
const trackerCmd = 'node "$HOME/.claude/scripts/session-tracker.js"';
const saveCmd = 'node "$HOME/.claude/scripts/cc-sessions.js" save';
const wire = (evt, cmd, marker) => {
  j.hooks[evt] = j.hooks[evt] || [];
  if (!JSON.stringify(j.hooks[evt]).includes(marker)) {
    j.hooks[evt].push({ hooks: [{ type: 'command', command: cmd }] });
  }
};
wire('SessionStart', trackerCmd, 'session-tracker.js');
wire('SessionEnd', trackerCmd, 'session-tracker.js');
wire('Stop', saveCmd, 'cc-sessions.js');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(j, null, 2));
console.log('Merged SessionStart/SessionEnd/Stop hooks into ' + file);
MERGE_EOF

# --- 3. put `cc-sessions` on PATH --------------------------------------------
RC="$HOME/.zshrc"
[[ "${SHELL:-}" == *bash* ]] && RC="$HOME/.bashrc"

BIN_DIR=""
for d in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
  case ":$PATH:" in *":$d:"*) if [[ -d "$d" && -w "$d" ]]; then BIN_DIR="$d"; break; fi;; esac
done
if [[ -z "$BIN_DIR" ]]; then
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
  if ! grep -q '.local/bin' "$RC" 2>/dev/null; then
    printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC"
    echo "Added ~/.local/bin to PATH in $RC (open a new tab to pick it up)"
  fi
fi
ln -sf "$SCRIPTS_DIR/cc-sessions.js" "$BIN_DIR/cc-sessions"
echo "Linked cc-sessions -> $BIN_DIR/cc-sessions"

echo
echo "Done. Next steps:"
echo "  1. Open a new terminal tab so '$BIN_DIR' is on PATH, then run: cc-sessions list"
echo "  2. The first 'cc-sessions restore' asks for macOS Accessibility permission — approve it once."
echo "  3. Sessions started from now on are tracked automatically. Use:"
echo "       cc-sessions list      # show the saved snapshot"
echo "       cc-sessions save      # snapshot now (also happens automatically)"
echo "       cc-sessions restore   # reopen all saved sessions, one per tab"
