#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');

const REG_DIR = path.join(os.homedir(), '.claude', 'open-sessions');

/**
 * Test whether a process command line belongs to the Claude Code binary,
 * whether it runs as `claude` directly or as `node .../claude`.
 *
 * @param command - The full command string from `ps -o command=`.
 * @returns True if any argument resolves to the claude executable.
 */
function isClaudeCommand(command) {
  return command.split(/\s+/).some(tok => {
    const base = path.basename(tok);
    return base === 'claude' || base === 'claude.exe';
  });
}

/**
 * Walk up the process ancestry to find the owning `claude` process.
 *
 * @param startPpid - The parent PID to begin the ancestry walk from.
 * @returns The PID of the nearest ancestor whose command is the claude binary, or null.
 */
function findClaudePid(startPpid) {
  let pid = startPpid;
  for (let i = 0; i < 25 && pid > 1; i++) {
    let line = '';
    try { line = execSync(`ps -o ppid=,command= -p ${pid}`, { encoding: 'utf8' }).trim(); } catch { return null; }
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) return null;
    if (isClaudeCommand(match[2])) return pid;
    pid = parseInt(match[1], 10);
  }
  return null;
}

/**
 * Capture the tmux pane this session is running in, if any.
 *
 * Only the pane id is recorded here — it is stable for the life of the tmux
 * server, and `cc-sessions save` resolves it to session/window/pane coordinates
 * each time, so panes that get renumbered or moved stay correctly addressed.
 *
 * @returns A `{ socket, pane }` reference, or null when not running under tmux.
 */
function tmuxRef() {
  const server = process.env.TMUX;
  const pane = process.env.TMUX_PANE;
  if (!server || !pane) return null;
  return { socket: server.split(',')[0] || null, pane };
}

/**
 * Read and parse the hook payload delivered by Claude Code on stdin.
 *
 * @returns The parsed hook input object, or an empty object on failure.
 */
function readHookInput() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return {}; }
}

const input = readHookInput();
const sessionId = input.session_id;
if (!sessionId) process.exit(0);

const file = path.join(REG_DIR, `${sessionId}.json`);

if (input.hook_event_name === 'SessionEnd') {
  // Remove the registry entry only — NEVER shrink the snapshot here. A close,
  // a crash, and an OS restart all fire SessionEnd indistinguishably, so pruning
  // here would wipe the snapshot on the very restart we need to survive. Closed
  // sessions instead fall off when a surviving session next runs `save`.
  try { fs.unlinkSync(file); } catch {}
  process.exit(0);
}

fs.mkdirSync(REG_DIR, { recursive: true });
fs.writeFileSync(file, JSON.stringify({
  sessionId,
  cwd: input.cwd || process.cwd(),
  claudePid: findClaudePid(process.ppid),
  tmux: tmuxRef(),
  startedAt: new Date().toISOString(),
}));

// New/updated session: refresh the snapshot from the live registry.
try {
  execFileSync(process.execPath, [path.join(os.homedir(), '.claude', 'scripts', 'cc-sessions.js'), 'save'], { stdio: 'ignore' });
} catch {}
