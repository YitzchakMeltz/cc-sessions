# cc-sessions

Save and restore your open Claude Code sessions — across Apple Terminal tabs, or across tmux panes. After a reboot or a crash, run one command and every conversation reopens where you left off.

Terminal tabs are macOS only. The tmux backend works anywhere tmux does.

## Why this exists

I kept several Claude Code sessions open across Terminal tabs — one per thing I was working on — and I stopped turning my laptop off because a restart meant losing track of them. `claude --resume` exists, but it hands you a list of *every* session in a directory and leaves you to remember which ones were actually open and which you'd already finished. That guessing game got old.

So the machine tracks it instead. A Claude Code hook records which sessions are live as you work. When you come back after a reboot, `cc-sessions restore` reopens exactly the tabs that were open, each running `claude --resume` on the right session in the right directory.

Day to day you don't run anything. The snapshot updates itself. You only touch the CLI after a restart.

## Requirements

- macOS (for the Terminal backend)
- Node.js on your `PATH` (`node -v` should work)
- Claude Code CLI on your `PATH` — used at restore time (`claude --resume`)
- tmux 3.0+, if you want the tmux backend

## Install

```sh
git clone https://github.com/YitzchakMeltz/cc-sessions.git
cd cc-sessions
./install.sh
```

The installer copies the scripts into `~/.claude`, merges three hooks into `~/.claude/settings.json` (it won't clobber hooks you already have), and symlinks `cc-sessions` onto your `PATH`. Open a new terminal tab afterward so the command is picked up. It's idempotent — re-running it is safe.

## Usage

```sh
cc-sessions list      # show what's in the current snapshot
cc-sessions save      # snapshot live sessions now (also runs automatically)
cc-sessions restore   # reopen every saved session
```

`restore` picks its backend automatically: tmux if the snapshot holds tmux panes
and a tmux server is up, Terminal tabs otherwise. Force it with `--tmux` or
`--terminal`.

| Flag | Effect |
|---|---|
| `--tmux` / `--terminal` | force a backend instead of auto-detecting |
| `--no-create` | only resume into panes that already exist; don't make new ones |
| `--force` | resume even into panes that look busy |
| `--dry-run` | print what would happen, change nothing |

The first `restore` triggers a macOS Accessibility prompt — it sends ⌘T to open new tabs, and macOS gates synthetic keystrokes. Approve your terminal app once (System Settings → Privacy & Security → Accessibility) and you won't see it again.

## How it works

Three Claude Code hooks do the bookkeeping:

- **`SessionStart`** registers a session — writes `~/.claude/open-sessions/<sessionId>.json` with its working directory and the PID of the owning `claude` process. Each session reports its own ID, so multiple sessions in the *same* folder stay distinct.
- **`Stop`** (fires after every Claude response) refreshes the snapshot from the live registry.
- **`SessionEnd`** removes the session's *registry* entry but deliberately **never touches the snapshot**.

That last point is the whole trick. Closing a tab, a crash, and an OS restart all fire `SessionEnd` the same way — there's no reliable signal to tell them apart. If `SessionEnd` pruned the snapshot, a reboot would wipe it on the exact event you're trying to survive. So closed sessions instead fall off naturally: the next time a *surviving* session saves, dead entries (their process is gone) get pruned. `save` also refuses to overwrite a non-empty snapshot with an empty one, so a save that runs right after boot — when nothing is alive yet — can't erase your last good state.

`restore` reads the snapshot and either drives Apple Terminal via AppleScript, opening one tab per session, or sends the same `cd <cwd> && claude --resume <id>` into the right tmux pane.

Everything is event-driven — no background daemon, no polling timer — so it holds up across sleep/wake.

## tmux

If a session is running under tmux, `SessionStart` also records its pane, and
`restore` puts the conversation back in that pane instead of opening a Terminal
tab.

The snapshot stores **logical coordinates** — `session:window.pane` — not the
tmux pane id. Pane ids (`%3`) die with the tmux server, and they shift under
`renumber-windows`; coordinates are re-resolved on every save, and they're the
same addressing a layout restore rebuilds panes at.

That's the point of the design: it composes with
[tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect). Resurrect
brings your windows, panes and working directories back but starts each pane at
a bare shell — it has no way to know *which* conversation belonged there.
cc-sessions does. Let resurrect rebuild the layout, then chain this on:

```tmux
set -g @resurrect-hook-post-restore-all 'sleep 3 && cc-sessions restore --tmux'
```

The short delay lets the restored panes' shells finish starting before they're
sent anything — without it a pane can still be initialising when the hook fires,
and the resume is skipped as "busy".

Reboot, and the layout comes back with every Claude Code session live in the
pane it was in.

Some details worth knowing:

- **Busy panes are left alone.** A pane only gets a resume command if it's
  sitting at a shell prompt, so re-running `restore` can't stack two sessions in
  one pane or interrupt something mid-run. `--force` overrides this.
- **Missing panes are recreated** in the right tmux session, named after the
  window they came from. Pass `--no-create` to only fill panes that already
  exist — the right choice if something else owns your layout.
- **Panes are matched exactly.** `tmux display-message -t` silently falls back
  to the session's current pane when the target doesn't exist, which would drop
  a session into an unrelated pane; the lookup is an exact match instead.
- **Multiple tmux servers are respected.** Sessions go back to the socket they
  came from, falling back to the default server if that socket is gone.

## Trade-offs worth knowing

- **Close a single tab and it isn't removed from the snapshot right away.** It drops off when another live session next auto-saves. If you close it and immediately reboot, `restore` reopens it — one harmless extra tab. That's the deliberate cost of surviving crashes: I'd rather reopen a tab you didn't need than lose one you did.
- **Only sessions started *after* install are tracked.** The hooks can't retroactively see sessions that were already running.

## Files it installs

| Path | Purpose |
|---|---|
| `~/.claude/scripts/session-tracker.js` | `SessionStart` / `SessionEnd` hook handler |
| `~/.claude/scripts/cc-sessions.js` | the `save` / `restore` / `list` CLI |
| `~/.claude/scripts/restore-tabs.applescript` | opens one Terminal tab per session |
| `~/.claude/settings.json` | the three hooks (merged in, not overwritten) |
| `<bindir>/cc-sessions` | `PATH` symlink to `cc-sessions.js` |
| `~/.claude/open-sessions/` | live registry, one file per session |
| `~/.claude/session-snapshot.json` | the saved snapshot |

## Troubleshooting

- **`cc-sessions: command not found`** — open a new tab so the symlink's directory is on `PATH`; `which cc-sessions` should resolve it.
- **`restore` opens nothing** — check `cc-sessions list`. If it's empty, nothing was tracked yet (only post-install sessions register).
- **Tabs don't open, or everything lands in one window** — grant Accessibility permission to your terminal app.
- **Snapshot not updating** — confirm `SessionStart`, `SessionEnd`, and `Stop` are present in `~/.claude/settings.json`, then run `cc-sessions save` by hand; it should report the live sessions.

## Uninstall

```sh
./uninstall.sh
```

It removes the scripts, the snapshot, the registry, and the `PATH` symlink. The three hooks in `~/.claude/settings.json` are left for you to delete by hand — the uninstaller won't edit a file that's likely holding other hooks you care about.

## License

MIT — see [LICENSE](LICENSE).
