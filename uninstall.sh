#!/usr/bin/env bash
#
# uninstall.sh — remove cc-sessions.
#
# Deletes the installed scripts, the PATH symlink, and the snapshot/registry.
# Leaves your other Claude Code settings alone, but the three hooks it added to
# ~/.claude/settings.json must be removed by hand (see the note at the end).
#
set -euo pipefail

SCRIPTS_DIR="$HOME/.claude/scripts"

LINK="$(command -v cc-sessions || true)"
[[ -n "$LINK" && -L "$LINK" ]] && { rm -f "$LINK"; echo "Removed PATH symlink: $LINK"; }

rm -f "$SCRIPTS_DIR/session-tracker.js" \
      "$SCRIPTS_DIR/cc-sessions.js" \
      "$SCRIPTS_DIR/restore-tabs.applescript" \
      "$HOME/.claude/session-snapshot.json"
rm -rf "$HOME/.claude/open-sessions"
echo "Removed scripts, snapshot, and registry."

echo
echo "One manual step left: remove the cc-sessions hooks from"
echo "  ~/.claude/settings.json"
echo "Delete the SessionStart / SessionEnd entries that call session-tracker.js"
echo "and the Stop entry that calls cc-sessions.js."
