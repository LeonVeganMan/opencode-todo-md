/**
 * The keys of the todo panel, in the order the help dialog prints them.
 * A parity test reads src/tui.tsx and fails when this list and the registered
 * bindings stop matching, so a rebind cannot leave the help behind.
 */
export type Shortcut = { bind: string; title: string }

export const SHORTCUTS: Array<Shortcut> = [
  { bind: "/", title: "Search" },
  { bind: "up", title: "Cursor up" },
  { bind: "down", title: "Cursor down / next page" },
  { bind: "pageup", title: "Previous page" },
  { bind: "pagedown", title: "Next page" },
  { bind: "home", title: "First page" },
  { bind: "end", title: "Last page" },
  { bind: "space", title: "Cycle selected state" },
  { bind: "ctrl+e", title: "Edit selected task" },
  { bind: "ctrl+n", title: "New task" },
  { bind: "ctrl+d", title: "Delete, pressed twice" },
  { bind: "ctrl+z", title: "Undo last delete" },
  { bind: "ctrl+r", title: "Renumber ids" },
  { bind: "escape", title: "Leave search, or close" },
]
