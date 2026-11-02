# Announcement draft

Post to Reddit (r/opencode and any CLI/agent community you follow) and reuse as the GitHub release notes.

## Titles

- A project TODO.md for OpenCode: priorities, due dates, tags and a clickable list
- One TODO.md shared by every session, with priorities, status and due dates
- Your agent's todo list should survive the session
- I built a todo list for OpenCode that lives in your repo

## Body

OpenCode keeps a todo list per session. I wanted one per **project**, in a file I can see, grep and commit.

`opencode-todo-md` stores the list in `TODO.md` at the project root:

```markdown
- [ ] Fix login redirect <!-- id=1 priority=high due=2026-11-05 created=2026-10-30 -->
- [x] Add screenshot <!-- id=3 done=2026-10-31 created=2026-10-28 -->
```

The agent gets `todo_write` / `todo_read`, with stable ids so it can patch a single item instead of resending the list.
The TUI gets a sidebar strip and `/todo`: filter tabs with counters, tag and priority filters, sortable columns, search,
paging, and click actions on every cell.

Two things I liked while building it:

- the checklist is rewritten **in place**, so headings and notes in the file survive untouched;
- dates and priority live in an invisible HTML comment, so the markdown renders cleanly on GitHub.

Install from npm:

```json
{ "plugins": ["opencode-todo-md"] }
```

Installing registers the tools, but nothing forces the model to use them. If you want the file to be the source of
truth, one line in `AGENTS.md` (project or global) does the trick:

```markdown
If the project has a TODO.md at the root, keep it updated with todo_write (run todo_read first, then send the whole
list). Do not edit the checkboxes by hand: the metadata lives in the trailing HTML comment.
```

Feedback welcome, especially on the dialog layout in narrow terminals.

## First comment (optional)

Repo: https://github.com/LeonVeganMan/opencode-todo-md
npm: https://www.npmjs.com/package/opencode-todo-md

Status: v0.1.8, 58 unit tests. The TUI half (sidebar strip and `/todo`) loads at TUI startup: restart `opencode`, or
run `/reload`, after installing or updating.
