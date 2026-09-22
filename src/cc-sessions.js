#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const REG_DIR = path.join(HOME, '.claude', 'open-sessions');
const SNAPSHOT = path.join(HOME, '.claude', 'session-snapshot.json');
const APPLESCRIPT = path.join(HOME, '.claude', 'scripts', 'restore-tabs.applescript');

// Overridable so wrapper scripts (and the test suite) can stand in for the real CLI.
const CLAUDE_BIN = process.env.CC_SESSIONS_CLAUDE_BIN || 'claude';

// A pane running one of these is idle — safe to send a resume command to.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'ksh', 'dash', 'tcsh', 'csh']);

const PANE_FORMAT = '#{session_name}\t#{window_index}\t#{window_name}\t#{pane_index}';

/**
 * Check whether a process with the given PID is currently alive.
 *
 * @param pid - The process ID to test.
 * @returns True if the process exists, false otherwise.
 */
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Run a tmux command against a specific server socket.
 *
 * @param socket - Path to the tmux server socket, or null for the default server.
 * @param args - The tmux arguments to run.
 * @returns Trimmed stdout on success, or null if tmux failed or is not installed.
 */
function tmux(socket, args) {
  try {
    return execFileSync('tmux', socket ? ['-S', socket, ...args] : args,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * Test whether a tmux server is reachable on the given socket.
 *
 * @param socket - Path to the tmux server socket, or null for the default server.
 * @returns True if the server answers.
 */
function serverIsUp(socket) {
  return tmux(socket, ['list-sessions', '-F', '#{session_name}']) !== null;
}

/**
 * Resolve a live tmux pane id into stable logical coordinates.
 *
 * Pane ids (`%3`) live only as long as the tmux server, so the snapshot stores
 * session/window/pane coordinates instead — the same addressing a layout restore
 * (tmux-resurrect and friends) rebuilds panes at.
 *
 * @param ref - The `{ socket, pane }` recorded for the session, or null.
 * @returns A location object, or null if the pane no longer resolves.
 */
function resolveTmuxLocation(ref) {
  if (!ref || !ref.pane) return null;
  const out = tmux(ref.socket, ['display-message', '-p', '-t', ref.pane, '-F', PANE_FORMAT]);
  if (!out) return null;
  const [session, window, windowName, pane] = out.split('\t');
  if (!session) return null;
  return { socket: ref.socket || null, session, window: Number(window), windowName, pane: Number(pane) };
}

/**
 * Read the snapshot from disk.
 *
 * @returns The stored session array, or an empty array if there is no snapshot.
 */
function readSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')); } catch { return []; }
}

/**
 * Load live session records from the registry, pruning entries whose owner died.
 *
 * @param previous - The previous snapshot, used to carry forward tmux coordinates
 *   that can no longer be resolved (for instance when the pane has since closed).
 * @returns An array of `{ sessionId, cwd, tmux? }` for sessions still running.
 */
function collectLiveSessions(previous) {
  const prior = new Map((previous || []).map(s => [s.sessionId, s]));
  let files = [];
  try { files = fs.readdirSync(REG_DIR).filter(f => f.endsWith('.json')); } catch { return []; }
  const live = [];
  for (const f of files) {
    const full = path.join(REG_DIR, f);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
    if (rec.claudePid === null || isAlive(rec.claudePid)) {
      const located = resolveTmuxLocation(rec.tmux) || (prior.get(rec.sessionId) || {}).tmux || null;
      const entry = { sessionId: rec.sessionId, cwd: rec.cwd };
      if (located) entry.tmux = located;
      live.push(entry);
      continue;
    }
    try { fs.unlinkSync(full); } catch {}
  }
  return live;
}

/**
 * Render one snapshot entry as a single human-readable line.
 *
 * @param session - The snapshot entry to describe.
 * @returns The formatted line, without indentation.
 */
function describe(session) {
  const at = session.tmux
    ? `  [tmux ${session.tmux.session}:${session.tmux.window}.${session.tmux.pane}]`
    : '';
  return `${session.sessionId.slice(0, 8)}  ${session.cwd}${at}`;
}

/**
 * Snapshot currently-live sessions. Refuses to overwrite an existing snapshot
 * with an empty one, so a post-reboot auto-save cannot wipe the last good state.
 */
function save() {
  const sessions = collectLiveSessions(readSnapshot());
  if (!sessions.length) {
    console.log('No live sessions — keeping existing snapshot intact.');
    return;
  }
  fs.writeFileSync(SNAPSHOT, JSON.stringify(sessions, null, 2));
  console.log(`Saved ${sessions.length} session(s) to ${SNAPSHOT}`);
  sessions.forEach(s => console.log(`  • ${describe(s)}`));
}

/**
 * Wrap a value in single quotes for safe use in a POSIX shell command.
 *
 * @param value - The raw string to escape.
 * @returns The shell-safe, single-quoted representation.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the shell command that reopens one session in its working directory.
 *
 * @param session - The snapshot entry to resume.
 * @returns The command line to run in a shell.
 */
function resumeCommand(session) {
  return `cd ${shellQuote(session.cwd)} && ${CLAUDE_BIN} --resume ${shellQuote(session.sessionId)}`;
}

/**
 * Reopen each session in its own Apple Terminal tab.
 *
 * @param sessions - The snapshot entries to reopen.
 */
function restoreTerminal(sessions) {
  const cmds = sessions.map(resumeCommand);
  try {
    execFileSync('osascript', [APPLESCRIPT, ...cmds], { stdio: 'inherit' });
  } catch (e) {
    if (/keystrokes|1002/.test(e.message || '')) {
      console.error('\nTerminal needs Accessibility permission to open new tabs (it sends ⌘T).');
      console.error('Grant it: System Settings → Privacy & Security → Accessibility → enable your');
      console.error('terminal app, then run `cc-sessions restore` again.');
    } else {
      console.error(`Could not open tabs: ${e.message}`);
    }
    process.exit(1);
  }
  console.log(`Reopened ${sessions.length} session(s).`);
}

/**
 * Index every pane on a tmux server by its logical coordinates.
 *
 * Panes are matched by exact lookup rather than with `display-message -t`,
 * which silently falls back to the session's current pane when the window or
 * pane it was given does not exist — and would hand back an unrelated pane.
 *
 * @param socket - The tmux socket to query, or null for the default server.
 * @returns A Map from `session:window.pane` to `{ paneId, command }`, or null
 *   if the server is unreachable.
 */
function indexPanes(socket) {
  const out = tmux(socket, ['list-panes', '-a', '-F',
    '#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_current_command}']);
  if (out === null) return null;
  const panes = new Map();
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [session, window, pane, paneId, command] = line.split('\t');
    panes.set(`${session}:${window}.${pane}`, { paneId, command });
  }
  return panes;
}

/**
 * Look up the pane a session was last seen in.
 *
 * @param panes - The pane index for the server, from `indexPanes`.
 * @param location - The session's recorded tmux coordinates.
 * @returns `{ paneId, command }` for the existing pane, or null if it is gone.
 */
function findPane(panes, location) {
  return panes.get(`${location.session}:${location.window}.${location.pane}`) || null;
}

/**
 * Create a pane to host a session whose original pane no longer exists,
 * reusing its tmux session if one by that name is present.
 *
 * @param socket - The tmux socket to create in, or null for the default server.
 * @param session - The snapshot entry being restored.
 * @param fallbackSession - tmux session name to use when the entry has no coordinates.
 * @returns The new pane's id, or null if tmux refused.
 */
function createPane(socket, session, fallbackSession) {
  const name = (session.tmux && session.tmux.session) || fallbackSession;
  const windowName = (session.tmux && session.tmux.windowName) || path.basename(session.cwd) || 'claude';
  if (tmux(socket, ['has-session', '-t', name]) === null) {
    return tmux(socket, ['new-session', '-d', '-P', '-F', '#{pane_id}',
      '-s', name, '-n', windowName, '-c', session.cwd]);
  }
  return tmux(socket, ['new-window', '-d', '-P', '-F', '#{pane_id}',
    '-t', `${name}:`, '-n', windowName, '-c', session.cwd]);
}

/**
 * Test whether a pane is sitting at a shell prompt and can accept a command.
 *
 * @param command - The pane's current foreground command.
 * @returns True when the pane looks idle.
 */
function isIdle(command) {
  return SHELLS.has(String(command || '').replace(/^-/, ''));
}

/**
 * Resume each session inside tmux, in the pane it was last seen in.
 *
 * Panes rebuilt by a layout restore (tmux-resurrect, continuum) come back as
 * bare shells; this drops the matching `claude --resume` into each one. Panes
 * that are busy are left alone, so the command is safe to re-run.
 *
 * @param sessions - The snapshot entries to resume.
 * @param options - `{ create, dryRun }` behaviour flags.
 */
function restoreTmux(sessions, options) {
  // Sessions with no recorded pane join whichever server the located ones are
  // on, so they never leak onto the default server by accident.
  const tally = new Map();
  for (const s of sessions) {
    const socket = s.tmux && s.tmux.socket;
    if (socket) tally.set(socket, (tally.get(socket) || 0) + 1);
  }
  const primary = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])[0] || '';

  const groups = new Map();
  for (const s of sessions) {
    const key = (s.tmux && s.tmux.socket) || primary;
    if (!groups.has(key)) groups.set(key, { socket: key || null, entries: [] });
    groups.get(key).entries.push(s);
  }

  let resumed = 0, busy = 0, failed = 0;

  for (const group of groups.values()) {
    // Fall back to the default server when the recorded socket is stale.
    let socket = group.socket;
    if (!serverIsUp(socket)) {
      if (socket && serverIsUp(null)) {
        console.log(`tmux socket ${socket} is gone — using the default server instead.`);
        socket = null;
      } else {
        console.error(`No tmux server reachable for ${group.entries.length} session(s) — skipped.`);
        failed += group.entries.length;
        continue;
      }
    }

    const panes = indexPanes(socket) || new Map();

    for (const s of group.entries) {
      const existing = s.tmux ? findPane(panes, s.tmux) : null;
      let paneId = existing && existing.paneId;

      if (existing && !isIdle(existing.command) && !options.force) {
        console.log(`  ↷ ${describe(s)} — pane is busy (${existing.command}), left alone`);
        busy++;
        continue;
      }

      if (!paneId) {
        if (!options.create) {
          console.log(`  ✗ ${describe(s)} — pane is gone, and --no-create was given`);
          failed++;
          continue;
        }
        if (options.dryRun) {
          console.log(`  + ${describe(s)} — would create a pane and resume`);
          resumed++;
          continue;
        }
        paneId = createPane(socket, s, options.session);
        if (!paneId) {
          console.log(`  ✗ ${describe(s)} — could not create a pane`);
          failed++;
          continue;
        }
      }

      if (options.dryRun) {
        console.log(`  → ${paneId}  ${resumeCommand(s)}`);
        resumed++;
        continue;
      }

      if (tmux(socket, ['send-keys', '-t', paneId, resumeCommand(s), 'Enter']) === null) {
        console.log(`  ✗ ${describe(s)} — send-keys to ${paneId} failed`);
        failed++;
        continue;
      }
      console.log(`  ✓ ${describe(s)} → ${paneId}`);
      resumed++;
    }
  }

  console.log(`\nResumed ${resumed} session(s)` +
    (busy ? `, ${busy} pane(s) already busy` : '') +
    (failed ? `, ${failed} failed` : '') + '.');
  if (failed) process.exit(1);
}

/**
 * Decide which backend to restore with when the user did not say.
 *
 * @param sessions - The snapshot entries about to be restored.
 * @returns Either 'tmux' or 'terminal'.
 */
function detectMode(sessions) {
  const sockets = new Set(sessions.filter(s => s.tmux).map(s => (s.tmux.socket || '')));
  if (!sockets.size) return 'terminal';
  for (const socket of sockets) if (serverIsUp(socket || null)) return 'tmux';
  return serverIsUp(null) ? 'tmux' : 'terminal';
}

/**
 * Reopen every session in the snapshot, in tmux or in Terminal tabs.
 *
 * @param options - `{ mode, create, dryRun, force, session }` behaviour flags.
 */
function restore(options) {
  const sessions = readSnapshot();
  if (!sessions.length) {
    console.error('No snapshot found. Run `cc-sessions save` first.');
    process.exit(1);
  }
  const mode = options.mode || detectMode(sessions);
  if (mode === 'tmux') {
    console.log(`Restoring ${sessions.length} session(s) into tmux:`);
    restoreTmux(sessions, options);
  } else {
    restoreTerminal(sessions);
  }
}

/**
 * Print the current snapshot contents.
 */
function list() {
  const sessions = readSnapshot();
  if (!sessions.length) { console.log('No snapshot yet.'); return; }
  console.log(`Snapshot holds ${sessions.length} session(s):`);
  sessions.forEach(s => console.log(`  • ${describe(s)}`));
}

const [, , action, ...rest] = process.argv;
const flags = new Set(rest.filter(a => a.startsWith('--')));
const options = {
  mode: flags.has('--tmux') ? 'tmux' : flags.has('--terminal') ? 'terminal' : null,
  create: !flags.has('--no-create'),
  dryRun: flags.has('--dry-run'),
  force: flags.has('--force'),
  session: 'claude',
};

if (action === 'save') save();
else if (action === 'restore') restore(options);
else if (action === 'list') list();
else {
  console.error('Usage: cc-sessions <save|list|restore [--tmux|--terminal] [--no-create] [--force] [--dry-run]>');
  process.exit(1);
}
