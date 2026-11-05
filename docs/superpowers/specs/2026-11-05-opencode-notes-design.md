# opencode-notes — short design

Date: 2026-11-05

## Intent

Capture ideas, reminders and small findings for a project without turning them into todos. Notes live next to
`TODO.md`, are readable and editable by hand, are available to the agent through tools, and can carry an optional
time reminder that the TUI fires while OpenCode is open.

## Goals

- `opencode-notes.md` in the session's project directory, created on the first note.
- One line per note: stable id, text, `@tags` in the text, optional `remind` timestamp.
- Agent tools: `note_read`, `note_write`, `note_delete`.
- `/note <text> [remind=15m|2h|1d|YYYY-MM-DDTHH:MM]` appends a note and confirms with a toast.
- The TUI shows a toast when a reminder is due, once per session.
- Every line that is not a note is preserved byte-identical.

## Non-goals for v1

- No notes dialog or sidebar section: humans edit the file by hand, the agent uses the tools.
- No notifications while OpenCode is closed and no waking the agent.
- No tags filter, priority, status, due date or renumber.
- No system-prompt injection: the plugin API for it is unverified here, so the tools are the agent interface.

## Format

```markdown
# Notes

- Controllare il token GitHub @security <!-- id=1 created=2026-11-05 remind=2026-11-05T14:30 -->
- Idea senza reminder @ui <!-- id=2 created=2026-11-05 -->
```

- `id`: `max + 1`, never reused.
- `created`: local date, `YYYY-MM-DD`.
- `remind`: local datetime, `YYYY-MM-DDTHH:MM`, optional.
- The heading is added only when the file is created; existing content is never reformatted.

## Components

- `src/notes.ts`: parse/render, id allocation, append/update/delete, tag extraction, reminder parsing (relative
  `15m`, `2h`, `1d` and absolute `YYYY-MM-DDTHH:MM`) and `isDue`.
- `src/index.ts`: the three tools, resolving the directory the same way `todoFile` does.
- `src/command.ts` and `src/strings.ts`: `/note` handling; relative reminders are resolved at capture time.
- `src/tui.tsx`: `/note` slash command and a 30-second interval in the sidebar component that reads the file and
  toasts due notes once per TUI session (in-memory set, not persisted).
- `README.md` and the changelog.

## Errors

- Invalid `remind`: reject with a clear message and write nothing.
- Missing file: `/note` creates it, the tools treat it as empty.
- Malformed metadata: keep the line as plain text and ignore the metadata; never drop user text.

## Testing

Parse/render roundtrip, foreign lines preserved, id allocation, tags, relative/absolute/invalid reminders,
overdue detection, append/update/delete, file creation.

## Limits

- Reminders fire only while the TUI process is alive.
- A due reminder stays in the file until editing or deleting it, so a missed toast is not lost.
- Editing the file by hand is supported: the parser only rewrites note lines it is asked to change.

## Update: list panel and snooze (approved)

The first version ships the list panel from the start and lets a reminder be snoozed.

- `/note` with no text opens a scrollable list; each row shows `#id`, the text, and the reminder in red when it is due.
- Keys: `ctrl+n` new, `ctrl+e` edit, `s` snooze, `ctrl+d` delete (twice), `esc` close.
- Snooze offers 5 minutes, 30 minutes, 1 hour or clear; the reminder becomes `now + delta` (or disappears).
- The reminder check runs every 30 seconds with an in-memory `${id}:${remind}` key, so each reminder fires once per TUI
  session and again after a snooze.
- `tab` cycles the panel filters: all notes, notes with a due reminder, and one filter per `@tag`.
- `/` searches the visible notes; the sidebar shows `Notes due/total` and the first due note, both opening the panel.
