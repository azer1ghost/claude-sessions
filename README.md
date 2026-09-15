# Claude Sessions

A local browser for every Claude Code session stored on this machine
(`~/.claude/projects/**.jsonl`) — read conversations, inspect per-session stats,
delete safely, and continue a session right from the page.

```bash
npm install
npm run dev          # API on 127.0.0.1:5179, UI on http://localhost:5180
```

Requires Node 20+, and a local Claude Code install (`claude` on `PATH`) for the
"open in terminal" button. Nothing is configured by hand: every
project and session is discovered at runtime from `~/.claude/projects`
(override with `CLAUDE_CONFIG_DIR`), and titles, paths, models and stats are read
out of the transcripts themselves.

## What it does

**Sidebar tree** — projects (resolved to their real paths on disk) with their
sessions nested underneath: title, age, message count, size, context usage.
A pulsing blue dot marks whatever Claude Code is writing to right now (any
transcript touched in the last 2 minutes), on both the session and its project.
The tree polls `/api/activity` every 8s — a ~50 ms stat sweep — so ages refresh
and the most recently active project keeps floating to the top.

**Chat pane** — the full transcript: user/assistant text rendered as markdown,
thinking, tool calls and tool results in collapsible blocks, images inline.
Long blocks are truncated to 6k chars with a "show more" button that fetches the
rest. Messages load 60 at a time; `jump to end` opens the tail of a long session.

**Details rail** — context usage (last turn + peak, against the 200k or 1M
window), start/end/duration, file size, message and tool counts, total tokens
(output / input / cache write / cache read), a per-tool histogram, cwd, git
branch, model, CLI version, and every subagent + workflow transcript belonging
to the session (clickable).

**Open in terminal** — the button in the chat header opens a real terminal in
the session's own `cwd` running `claude --resume <id>`, so you pick the
conversation up where Claude Code left it. macOS uses Terminal.app (set
`TERMINAL_APP=iTerm` for iTerm2), Linux uses `x-terminal-emulator`; if no
terminal can be driven, the command is copied to the clipboard instead.

**Search** — `Enter` in the top bar greps every transcript for a literal string
(capped at 120 files, 90s) and lists the matching sessions.

**Cleanup (bulk delete by age)** — the `Cleanup` button opens a dialog: pick an
age ("older than N days") and a scope (all projects or the selected one), hit
`Preview`, and every stale session is listed first — title, project path, age,
size (including its subagent folder), oldest first, each with a checkbox and all
selected by default. The footer shows the count and total size; the delete
button needs a second click to confirm. Everything goes to the trash, so it is
still restorable. Nothing is touched before you confirm the list.

**Delete safely** — only sessions can be deleted, never a whole project folder.
A deleted session moves to `~/.claude/.session-browser-trash/` and takes its
`subagents/` folder with it. The Trash dialog restores or permanently purges
entries. Nothing is removed from disk until you purge.

**Export** — `.md` (rendered transcript) or the raw `.jsonl`.

**Theme** — Claude-style warm light palette with a dark mode (`☾` / `☀`,
remembered in localStorage; follows the OS on first run).

## Layout

```
server/
  index.js      Express API (:5179)
  store.js      transcript scanning, metadata, pagination, trash
  search.js     grep-backed deep search
  terminal.js   opens a terminal on a session with `claude --resume`
src/
  main.js       UI (vanilla JS, full re-render per pane)
  api.js        fetch wrappers + ndjson streaming
  md.js         escaping markdown renderer
  format.js     bytes / numbers / dates
  style.css     Tailwind v4 + theme tokens
```

## Privacy & safety

- Everything runs on your machine. No transcript, path or token ever leaves it —
  the app has no telemetry and no outbound calls.
- Both servers bind to loopback only (`HOST=127.0.0.1`), because the API serves
  full transcripts and can open a terminal on your machine. Do not expose it to a
  network you do not trust.
- The repo carries no data: only code. Your sessions stay in `~/.claude`, the
  metadata cache in `~/.claude/.session-browser-cache.json`, and deleted
  sessions in `~/.claude/.session-browser-trash/`.
- Deletion is never destructive from the UI: sessions move to the trash, and
  project folders cannot be deleted at all.

## Notes

- Session metadata is cached in `~/.claude/.session-browser-cache.json`, keyed by
  file size + mtime, so rescans are instant. Bump `META_VERSION` in `store.js`
  to invalidate it.
- Parsed messages are kept in an in-memory LRU (4 sessions). An 82 MB transcript
  parses in ~0.3 s cold, ~7 ms warm.
- All transcript content is HTML-escaped before rendering.
- Read/write access is limited to `~/.claude/projects`; subagent paths are
  resolved and checked against the session folder.
