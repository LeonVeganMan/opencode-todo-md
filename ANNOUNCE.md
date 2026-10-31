# Announcement draft

Post to Reddit (r/opencode, r/commandline, r/neovim) and GitHub release notes.

## Titles

- I built a todo list for OpenCode that lives in your repo
- opencode-todo-md: one TODO.md shared by every session
- Your agent's todo list should survive the session

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

Install (local plugin, no build step):

```sh
git clone <repository-url> ~/.opencode/plugins/opencode-todo-md
```

Feedback welcome, especially on the dialog layout in narrow terminals.

## First comment (optional)

Repo: <repository-url>

Status: early, 41 unit tests, TUI half loads after `/reload`.
