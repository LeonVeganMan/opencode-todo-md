# opencode-todo-md

A todo list for OpenCode that lives in your repository: the agent, the sidebar and every session of the project read and
write the same `TODO.md`.

Session-scoped todo lists disappear with the session and lose their state on compaction. This plugin keeps the plan in
plain markdown, next to the code, so it survives restarts, is visible in `git diff`, and can be edited by hand without
breaking the metadata.

## Features

- `todo_write` / `todo_read` tools: the agent replaces the whole list or patches single items by id.
- `/todo`: a self-drawn dialog with filters, tags, sorting, search, paging and per-cell actions.
- Sidebar strip reading `<session directory>/TODO.md`, refreshed on writes, on completed tool calls and every 60s.
- Stable ids, priorities, due dates, creation and completion dates, `@tags` derived from the task text.
- Checkboxes are rewritten in place: headings, notes and any other line of `TODO.md` are never touched.
- No build step: OpenCode loads the TypeScript sources directly.

## Install

From the plugin list in `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["opencode-todo-md"]
}
```

That works once the package is published on npm. Until then, clone it next to the other local plugins:

```sh
git clone https://github.com/LeonVeganMan/opencode-todo-md ~/.opencode/plugins/opencode-todo-md
```

OpenCode auto-loads every directory under the home-level `.opencode/plugins`, so no config entry is needed for a local
checkout. Restart the TUI (or run `/reload`) to load the TUI half after an update.

## Usage

### Agent tools

`todo_write` takes the complete list, which replaces the previous one:

```json
{ "todos": [{ "content": "Fix login redirect", "status": "in_progress", "priority": "high" }] }
```

or a patch list, where each item carries an `id` plus only the fields to change:

```json
{ "todos": [{ "id": 3, "status": "completed" }] }
```

`todo_read` prints the list with ids, priority, due, done and created dates. Ids are assigned on first appearance and
never reused, so a patch cannot hit the wrong task after a reorder.

### Command

| Command | Effect |
| --- | --- |
| `/todo` | Opens the dialog |
| `/todo add <text> [high\|medium\|low] [due=YYYY-MM-DD]` | Appends a task, no dialogs |
| `/todo done <id>` | Marks a task completed |
| `/todo init` | Creates `TODO.md` with `## To do` and `## Done` |

### Dialog

```
● all (35)  ○ open (12)  ○ closed (23)  ○ overdue (0)
● all  ○ high  ○ medium  ○ low

＋ New task   Tag: @android ▸   Sort: status ▸

Search and press Enter (open, high, #12, @tag)

#id  st  prio  created     due         done        tag       description
#14  [ ] high  2026-10-28  2026-11-07  -           @android  Test credit pack…
```

- State tabs carry counters; `Tag:` cycles the tags found in the file; `Sort:` cycles status, due, priority, created,
  done and id.
- Search applies on Enter and understands `open`, `done`, `cancelled`, `high`, `medium`, `low`, `#12`, `@tag` and free
  text.
- Click a cell: `#id` edits, `st` and description toggle completed, `prio` cycles, `due` asks for a date, `tag` filters
  by that task's first tag.
- Click the `#id`, `prio`, `created`, `due` or `done` header to sort by that column; the sorted column is marked with
  `▲`, a second click restores the default order.
- `↑`/`↓` move the cursor, `space` toggles, `enter` edits, `ctrl+d` deletes, `Esc` closes.

When the editor closes, the list reopens, so editing several tasks in a row is one flow. The dialog state (filter,
tag, sort, page) restarts when you come back from the editor.

### Sidebar

The strip shows the open tasks of the session's project with ids and dates; the header turns red when something is
overdue and shows the highest priority among the open tasks. Clicking the header or a row opens `/todo`.

## File format

```markdown
# TODO

- [ ] Fix login redirect <!-- id=1 priority=high due=2026-11-05 created=2026-10-30 -->
- [•] Write release notes @docs <!-- id=2 created=2026-10-30 -->
- [x] Add screenshot <!-- id=3 done=2026-10-31 created=2026-10-28 -->
```

`status` comes from the checkbox: `[ ]` pending, `[•]` in progress, `[x]` completed, `[-]` cancelled. Everything after
the task text is an invisible HTML comment, so the rendered markdown stays clean.

## Development

```sh
bun test    # unit tests for the checklist, filters, sorting and string tables
bun run check
```

The plugins live in the same repository as the sources; OpenCode resolves `@opencode/plugin` at runtime, so nothing has
to be installed locally to try a change.

## License

MIT
