/**
 * Keys the todo panel listens to. The help dialog renders this list, and a test
 * compares it with the `bind` values in `src/tui.tsx`, so the two cannot drift.
 */
export type Shortcut = { bind: string; title: string }

export const SHORTCUTS: Array<Shortcut> = [
  { bind: "/", title: "Search tasks" },
  { bind: "up", title: "Cursor up" },
  { bind: "down", title: "Cursor down, next page at the edge" },
  { bind: "pageup", title: "Previous page" },
  { bind: "pagedown", title: "Next page" },
  { bind: "home", title: "First page" },
  { bind: "end", title: "Last page" },
  { bind: "space", title: "Toggle the selected task" },
  { bind: "ctrl+e", title: "Edit the selected task" },
  { bind: "ctrl+n", title: "New task" },
  { bind: "ctrl+d", title: "Delete, twice and without a dialog" },
  { bind: "escape", title: "Leave search, or close the panel" },
]
