/** @jsxImportSource @opentui/solid */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, ErrorBoundary, type JSX } from "solid-js"
import { dirname, join } from "node:path"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import {
  FILTER_LABEL,
  FILTER_ORDER,
  SORT_LABEL,
  addTodo,
  cellsOf,
  changeDue,
  completeTodo,
  deleteTodo,
  directoryOf,
  filterByPriority,
  filterByTag,
  headerCells,
  importTodo,
  renumberTodo,
  initTodo,
  matchesQuery,
  newTodo,
  nextFilter,
  nextSort,
  onTodosChanged,
  parseTodoCommand,
  readFile,
  removeTodo,
  restoreTodo,
  sortBy,
  sortTodos,
  tagWidthOf,
  tagsOf,
  cycleTodo,
  todosFor,
  updateTodo,
  type DeletedTodo,
  type SortKey,
  type TodoFilter,
} from "./command.ts"
import { createRefresher } from "./refresh.ts"
import { SHORTCUTS } from "./shortcuts.ts"
import { STRINGS } from "./strings.ts"
import { pageSize } from "./page.ts"
import { DEFAULT_SETTINGS, loadSettings, mergeSettings, saveSettings, type Palette, type Settings } from "./settings.ts"
import { isDueSoon, isOverdue, parseChecklist, type Todo, type TodoPriority } from "./checklist.ts"
import { appendNote, deleteNote, filterNotes, isNoteDue, onNotesChanged, parseRemind, readNotes, saveNotes, snoozeNote, updateNote, stamp, type Note } from "./notes.ts"

// "none" clears the priority: updateTodo passes it through as an explicit undefined.
const EDIT_PRIORITIES: Array<TodoPriority | undefined> = [undefined, "high", "medium", "low"]

/** The host does not persist render crashes: keep them in a log the user can send us. */
function logTuiError(where: string, error: unknown) {
  try {
    const state = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? ".", ".local", "state")
    const file = join(state, "opencode", "todo-md-errors.log")
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file) && statSync(file).size > 256 * 1024) writeFileSync(file, "")
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    appendFileSync(file, `[${new Date().toISOString()}] ${where}: ${detail}\n`)
  } catch {
    // Logging must never take the UI down with it.
  }
}

/** Solid only catches render and effect errors; without this an uncaught one blanks the slot. */
function guarded(where: string, render: () => JSX.Element) {
  return (
    <ErrorBoundary
      fallback={(error) => {
        logTuiError(where, error)
        return <text> </text>
      }}
    >
      {render()}
    </ErrorBoundary>
  )
}

const isoDay = (offset: number) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/** Due dates are picked, not typed: the dialog already has a text input and focus would fight over it. */
const DUE_CHOICES = [
  { label: "none", value: undefined },
  { label: "today", value: isoDay(0) },
  { label: "+7d", value: isoDay(7) },
  { label: "+30d", value: isoDay(30) },
]

/** One screen for text, priority and due date: the host has no composite dialog, so it is a custom JSX one. */
function EditDialog(props: {
  todo: Todo
  onSave: (content: string, priority: TodoPriority | undefined, due: string | undefined) => void
  onCancel: () => void
}) {
  const context = usePlugin()
  const [priority, setPriority] = createSignal<TodoPriority | undefined>(props.todo.priority)
  const [due, setDue] = createSignal(props.todo.due)
  // One focused input at a time: the content box keeps its text, the due box takes over while editing a custom date.
  const [dueEditing, setDueEditing] = createSignal(false)
  let contentArea: TextareaRenderable | undefined
  const cycle = () => {
    const index = EDIT_PRIORITIES.indexOf(priority())
    setPriority(EDIT_PRIORITIES[(index + 1) % EDIT_PRIORITIES.length])
  }
  // A task is one line in TODO.md: a pasted newline becomes a space.
  const save = (value: string) => {
    const content = value.replace(/\s*\n\s*/g, " ").trim()
    if (content) props.onSave(content, priority(), due())
  }
  const dueChoices = () =>
    props.todo.due && !DUE_CHOICES.some((choice) => choice.value === props.todo.due)
      ? [...DUE_CHOICES, { label: props.todo.due, value: props.todo.due }]
      : DUE_CHOICES

  context.keymap.layer(() => ({
    mode: "global" as const,
    commands: [
      { id: "opencode-todo-md.edit.priority", title: STRINGS.commands.priority, bind: "tab", run: cycle },
      { id: "opencode-todo-md.edit.cancel", title: STRINGS.commands.cancelEdit, bind: "escape", run: () => props.onCancel() },
    ],
  }))

  return (
    <box flexDirection="column" gap={1} border borderStyle="rounded" borderColor={colorsOf(context).textMuted}>
      <text>Edit task</text>
      <Show when={props.todo.done}>
        <text>{`Completed ${props.todo.done}`}</text>
      </Show>
      <textarea
        ref={(node) => (contentArea = node)}
        initialValue={props.todo.content}
        focused={!dueEditing()}
        height={7}
        wrapMode="word"
        keyBindings={[
          { name: "return", action: "submit" },
          { name: "kpenter", action: "submit" },
          { name: "linefeed", action: "submit" },
        ]}
        onSubmit={() => save(contentArea?.plainText ?? "")}
      />
      <Show when={dueEditing()}>
        <input
          value={due() ?? ""}
          placeholder="YYYY-MM-DD"
          focused
          onSubmit={(value) => {
            setDue(value.trim() || undefined)
            setDueEditing(false)
          }}
        />
      </Show>
      <box flexDirection="row" gap={2}>
        <For each={EDIT_PRIORITIES}>
          {(value) => (
            <text
              fg={priorityColor(colorsOf(context), value)}
              onMouseUp={() => setPriority(value)}
            >{`${value === priority() ? "▸ " : "  "}${value ?? "none"}`}</text>
          )}
        </For>
      </box>
      <box flexDirection="row" gap={2}>
        <text onMouseUp={() => setDueEditing((value) => !value)}>{`${dueEditing() ? "▾" : "✎"} ${STRINGS.dialog.dueLabel.replace("✎ ", "")}`}</text>
        <For each={dueChoices()}>
          {(choice) => (
            <text
              fg={choice.value && choice.value < isoDay(0) ? colorsOf(context).error : colorsOf(context).textMuted}
              onMouseUp={() => setDue(choice.value)}
            >{`${choice.value === due() ? "▸ " : "  "}${choice.label}`}</text>
          )}
        </For>
      </box>
      <text>Tab priority · ✎ due date · Enter saves · Esc cancels</text>
    </box>
  )
}

/** Resolves when the dialog closes, so the caller can reopen the list. */
function editTodo(context: ReturnType<typeof usePlugin>, sessionID: string, value: string): Promise<void> {
  const loaded = readFile(directoryOf(context, sessionID))
  const todo = value.startsWith("#")
    ? loaded?.todos.find((item) => item.id === Number(value.slice(1)))
    : loaded?.todos[Number(value.slice(1))]
  if (!loaded || !todo) return Promise.resolve()
  return new Promise((resolve) => {
    // The list select is still open: close it before showing a custom dialog.
    context.ui.dialog.clear()
    context.ui.dialog.set({ size: "medium", centered: true })
    context.ui.dialog.show(
      () =>
        guarded("edit", () => (
          <EditDialog
            todo={todo}
            onSave={(content, priority, due) => {
              updateTodo(context, sessionID, value, { content, priority, due })
              context.ui.dialog.clear()
            }}
            onCancel={() => context.ui.dialog.clear()}
          />
        )),
      () => {
        resolve()
        // Esc or save closes only the editor: reopening on the next tick lets the host finish closing first.
        setTimeout(() => openTodoDialog(context, sessionID), 0)
      },
    )
  })
}

// theme.text is an object (base/muted/feedback.*.base), not a color: passing it straight to fg crashes the renderer.
type ThemeText = {
  base?: string
  muted?: string
  feedback?: {
    error?: { base?: string }
    warning?: { base?: string }
    success?: { base?: string }
    info?: { base?: string }
  }
}
type ThemeColors = {
  error?: string
  warning?: string
  success?: string
  info?: string
  textMuted?: string
  text?: string
}
const colorsOf = (context: { theme?: unknown }): ThemeColors => {
  const theme = (context.theme ?? {}) as { text?: ThemeText; current?: { text?: ThemeText } }
  const text = theme.text ?? theme.current?.text ?? {}
  return {
    error: text.feedback?.error?.base,
    warning: text.feedback?.warning?.base,
    success: text.feedback?.success?.base,
    info: text.feedback?.info?.base,
    textMuted: text.muted,
    text: text.base,
  }
}
// Colors from the README screenshot (Catppuccin Mocha), so the panel reads like the docs image.
const ROW_COLORS = {
  id: "#89dceb",
  completed: "#a6e3a1",
  running: "#f9e2af",
  high: "#f38ba8",
  medium: "#f9e2af",
  low: "#89b4fa",
  overdue: "#f38ba8",
  tag: "#cba6f7",
}

// One color per column: the table stays readable when rows are long.
// "theme" follows the host palette and falls back to the screenshot hex when a token is missing.
const cellColor = (
  theme: ThemeColors,
  todo: Todo,
  position: number,
  palette: Palette = "fixed",
): string | undefined => {
  const fixed = palette === "fixed"
  const high = fixed ? ROW_COLORS.high : (theme.error ?? ROW_COLORS.high)
  const medium = fixed ? ROW_COLORS.medium : (theme.warning ?? ROW_COLORS.medium)
  const low = fixed ? ROW_COLORS.low : (theme.info ?? ROW_COLORS.low)
  const completed = fixed ? ROW_COLORS.completed : (theme.success ?? ROW_COLORS.completed)
  const priority =
    todo.priority === "high"
      ? high
      : todo.priority === "medium"
        ? medium
        : todo.priority === "low"
          ? low
          : theme.textMuted
  if (position === 0) return fixed ? ROW_COLORS.id : theme.text
  if (position === 1) {
    if (todo.status === "completed") return completed
    if (todo.status === "in_progress") return medium
    if (todo.status === "cancelled") return theme.textMuted
    return theme.text
  }
  if (position === 2) return priority
  if (position === 3) return theme.textMuted
  if (position === 4) return isOverdue(todo) ? high : theme.textMuted
  if (position === 5) return todo.done ? completed : theme.textMuted
  if (position === 6) return fixed ? ROW_COLORS.tag : theme.text
  return theme.text
}

const priorityColor = (theme: ThemeColors, priority?: TodoPriority) =>
  priority === "high" ? theme.error : priority === "medium" ? theme.warning : theme.textMuted

// Sidebar rows stay one line: long task texts are clipped before they wrap.
const STRIP_MAX = 30
const clip = (text: string, room: number = STRIP_MAX) =>
  text.length > room ? `${text.slice(0, Math.max(room, 1) - 1)}…` : text

/** Cycles the priority of a task in place: none → high → medium → low → none. */
const NEXT_PRIORITY: Array<TodoPriority | undefined> = [undefined, "high", "medium", "low"]

/**
 * One window for the whole list: filters, tags, sorting and search live in signals,
 * so nothing closes and reopens while you work.
 */
function TodoDialog(props: { sessionID: string; close: () => void }) {
  const context = usePlugin()
  const theme = () => colorsOf(context)
  const settings = loadSettings(directoryOf(context, props.sessionID))
  // Recomputed on every open: a resize between dialogs is picked up.
  // The border eats two rows: the list height must not push the hint off the panel.
  const ROWS = settings.pageRows > 0 ? settings.pageRows : Math.max(4, pageSize() - (settings.borderStyle === "none" ? 0 : 2))
  // A size set before show() is ignored on this build, so ask again from inside the dialog.
  onMount(() => context.ui.dialog.set?.({ size: "xlarge", centered: true }))
  const [tick, setTick] = createSignal(0)
  const [filter, setFilter] = createSignal<TodoFilter>(settings.initialFilter)
  const [priority, setPriority] = createSignal<TodoPriority | undefined>()
  const [tag, setTag] = createSignal<string | undefined>()
  const [sort, setSort] = createSignal<SortKey | undefined>(settings.initialSort === "status" ? undefined : settings.initialSort)
  const [query, setQuery] = createSignal("")
  // The cursor is an index into the filtered rows: the scrollbox keeps it in view.
  const [cursor, setCursor] = createSignal(0)
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  // The search box takes the keyboard only when it asks: `/` focuses it, Esc hands it back to the list.
  const [focusSearch, setFocusSearch] = createSignal(false)
  const [pendingDelete, setPendingDelete] = createSignal<string | undefined>()
  const [undone, setUndone] = createSignal<DeletedTodo | undefined>()

  onMount(() => onCleanup(onTodosChanged(() => setTick((value) => value + 1))))

  const loaded = createMemo(() => {
    tick()
    return readFile(directoryOf(context, props.sessionID))
  })
  const todos = createMemo(() => loaded()?.todos ?? [])
  const tags = createMemo(() => [...new Set(todos().flatMap((todo) => tagsOf(todo.content)))])
  const base = createMemo(() => filterByPriority(filterByTag(todosFor(todos(), filter()), tag()), priority()))
  // Counters follow the tag/priority scope, not the active state tab: they say how many tasks each tab would show.
  const scope = createMemo(() => filterByPriority(filterByTag(todos(), tag()), priority()))
  const counts = createMemo(
    () =>
      Object.fromEntries(
        FILTER_ORDER.map((value) => [value, todosFor(scope(), value).length]),
      ) as Record<TodoFilter, number>,
  )
  const key = (todo: Todo, index: number) => (todo.id !== undefined ? `#${todo.id}` : `t${index}`)
  const arranged = createMemo(() => {
    const filtered = base().filter((todo) => matchesQuery(todo, query()))
    return sort() ? sortBy(filtered, sort()!) : sortTodos(filtered)
  })
  // The order is frozen while the dialog is open: a state or priority click must not move the row under the pointer.
  // It is rebuilt when the visible set changes, and from scratch on the next open because the dialog remounts.
  const [order, setOrder] = createSignal<string[]>([])
  createEffect(on([filter, sort, query, tag, priority], () => setOrder(arranged().map((item) => key(item.todo, item.index)))))
  const rows = createMemo(() => {
    const rank = new Map(order().map((value, index) => [value, index]))
    return [...arranged()].sort(
      (a, b) =>
        (rank.get(key(a.todo, a.index)) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(key(b.todo, b.index)) ?? Number.MAX_SAFE_INTEGER),
    )
  })
  const tagWidth = createMemo(() => tagWidthOf(base()))
  // Clamped cursor: deletes and filters can shrink the list under it.
  const at = () => Math.min(cursor(), Math.max(0, rows().length - 1))

  // Scroll only as much as the cursor needs: down past the last visible row, up past the first.
  // scrollHeight is measured by the previous frame, so the guard keeps the very first run harmless.
  createEffect(() => {
    const box = scroll()
    if (!box) return
    const c = at()
    const top = box.scrollTop
    if (c < top) box.scrollTo(c)
    else if (c >= top + ROWS) box.scrollTo(c - ROWS + 1)
  })

  const refresh = () => setTick((value) => value + 1)

  // The list keeps its own cursor while the search box does not have the keyboard.
  const selected = () => rows()[at()]
  const move = (delta: number) => {
    setPendingDelete(undefined)
    setCursor((value) => Math.max(0, Math.min(rows().length - 1, value + delta)))
  }
  // Undo is only the last deleted line: a snapshot of the whole file could overwrite another session's edits.
  // shortcut: one delete, not state/priority/edit, upgrade to a full history when asked.
  const rememberDelete = (index: number) => {
    const text = loaded()?.text
    if (!text) return
    const { items, lines } = parseChecklist(text)
    const item = items[index]
    if (item) setUndone({ line: lines[item.index], index: item.index })
  }
  // Two ctrl+d like the editor: the first arms the task, the second deletes it. No dialog to dismiss.
  const deleteSelected = () => {
    const item = selected()
    if (!item) return
    const value = key(item.todo, item.index)
    if (settings.deleteMode === "dialog") {
      rememberDelete(item.index)
      void deleteTodo(context, props.sessionID, value).then((deleted) => {
        if (!deleted) setUndone(undefined)
        refresh()
      })
      return
    }
    if (pendingDelete() !== value) return setPendingDelete(value)
    rememberDelete(item.index)
    if (!removeTodo(context, props.sessionID, value)) setUndone(undefined)
    setPendingDelete(undefined)
    refresh()
  }
  const undoDelete = () => {
    const deleted = undone()
    if (!deleted) return
    if (restoreTodo(context, props.sessionID, deleted)) setUndone(undefined)
    refresh()
  }
  const editSelected = () => {
    const item = selected()
    if (item) void editTodo(context, props.sessionID, key(item.todo, item.index))
  }

  const cycleTag = () => {
    const list = tags()
    if (list.length === 0) return
    const index = tag() ? list.indexOf(tag()!) : -1
    setTag(index + 1 >= list.length ? undefined : list[index + 1])
    setCursor(0)
  }
  const cyclePriority = (todo: Todo, index: number) => {
    const next = NEXT_PRIORITY[(NEXT_PRIORITY.indexOf(todo.priority) + 1) % NEXT_PRIORITY.length]
    updateTodo(context, props.sessionID, key(todo, index), { content: todo.content, priority: next })
    refresh()
  }
  const toggle = (todo: Todo, index: number) => {
    cycleTodo(context, props.sessionID, key(todo, index))
    if (settings.renumberAfterDone && todo.status !== "completed") void renumberTodo(context, props.sessionID).then(refresh)
    else refresh()
  }
  const add = async () => {
    if (await newTodo(context, props.sessionID)) refresh()
  }

  // Clicking a header cell sorts by that column; unsortable columns (status, tags, description) are inert.
  const HEADER_SORTS: Array<SortKey | undefined> = ["id", undefined, "priority", "created", "due", "done", undefined, undefined]
  // The sorted column is marked inside its padded cell: the row width stays identical.
  const headerLabel = (cell: string, position: number) =>
    HEADER_SORTS[position] && HEADER_SORTS[position] === sort() ? `${cell.trimEnd()} ▲`.padEnd(cell.length) : cell

  // Every list shortcut is gated on focusSearch(): while the box holds the keyboard those keys must type text.
  context.keymap.layer(() => ({
    mode: "global" as const,
    commands: [
      { id: "opencode-todo-md.search", title: STRINGS.commands.search, bind: "/", run: () => setFocusSearch(true) },
      {
        id: "opencode-todo-md.close",
        title: STRINGS.commands.close,
        bind: "escape",
        run: () => (focusSearch() ? setFocusSearch(false) : props.close()),
      },
      {
        id: "opencode-todo-md.up",
        title: STRINGS.commands.up,
        bind: "up",
        run: () => {
          if (!focusSearch()) move(-1)
        },
      },
      {
        id: "opencode-todo-md.down",
        title: STRINGS.commands.down,
        bind: "down",
        run: () => {
          if (!focusSearch()) move(1)
        },
      },
      {
        id: "opencode-todo-md.pageup",
        title: STRINGS.commands.pageUp,
        bind: "pageup",
        run: () => {
          if (focusSearch()) return
          setPendingDelete(undefined)
          move(-ROWS)
        },
      },
      {
        id: "opencode-todo-md.pagedown",
        title: STRINGS.commands.pageDown,
        bind: "pagedown",
        run: () => {
          if (focusSearch()) return
          setPendingDelete(undefined)
          move(ROWS)
        },
      },
      {
        id: "opencode-todo-md.home",
        title: STRINGS.commands.home,
        bind: "home",
        run: () => {
          if (focusSearch()) return
          setPendingDelete(undefined)
          move(-rows().length)
        },
      },
      {
        id: "opencode-todo-md.end",
        title: STRINGS.commands.end,
        bind: "end",
        run: () => {
          if (focusSearch()) return
          setPendingDelete(undefined)
          move(rows().length)
        },
      },
      {
        id: "opencode-todo-md.toggle",
        title: STRINGS.commands.toggle,
        bind: "space",
        run: () => {
          if (focusSearch()) return
          const item = selected()
          if (item) toggle(item.todo, item.index)
        },
      },
      {
        id: "opencode-todo-md.create",
        title: STRINGS.commands.create,
        bind: "ctrl+n",
        run: () => {
          if (!focusSearch()) void add()
        },
      },
      {
        id: "opencode-todo-md.edit",
        title: STRINGS.commands.edit,
        bind: "ctrl+e",
        run: () => {
          if (!focusSearch()) editSelected()
        },
      },
      {
        id: "opencode-todo-md.delete",
        title: STRINGS.commands.delete,
        bind: "ctrl+d",
        run: () => {
          if (!focusSearch()) deleteSelected()
        },
      },
      {
        id: "opencode-todo-md.undo",
        title: STRINGS.commands.undo,
        bind: "ctrl+z",
        run: () => {
          if (!focusSearch()) undoDelete()
        },
      },
      {
        id: "opencode-todo-md.renumber",
        title: STRINGS.commands.renumber,
        bind: "ctrl+g",
        run: () => {
          if (!focusSearch()) void renumberTodo(context, props.sessionID).then(refresh)
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" border={settings.borderStyle !== "none"} borderStyle={settings.borderStyle === "none" ? undefined : settings.borderStyle} borderColor={pendingDelete() ? (theme().error ?? ROW_COLORS.overdue) : focusSearch() ? (theme().info ?? ROW_COLORS.id) : theme().textMuted} paddingLeft={settings.padding} paddingTop={settings.padding}>
      <box flexDirection="row" gap={1}>
        <For each={FILTER_ORDER}>
          {(value) => (
            <text
              flexShrink={0}
              fg={value === filter() ? theme().text : theme().textMuted}
              onMouseUp={() => {
                setFilter(value)
                setCursor(0)
              }}
            >{`${value === filter() ? "●" : "○"} ${FILTER_LABEL[value]} (${counts()[value]})`}</text>
          )}
        </For>
      </box>

      <box flexDirection="row" gap={1}>
        <For each={NEXT_PRIORITY}>
          {(value) => (
            <text
              flexShrink={0}
              fg={value === priority() ? priorityColor(theme(), value) : theme().textMuted}
              onMouseUp={() => {
                setPriority(value)
                setCursor(0)
              }}
            >{`${value === priority() ? "●" : "○"} ${value ?? "all"}`}</text>
          )}
        </For>
      </box>

      <text> </text>

      <box flexDirection="row" gap={2}>
        <text flexShrink={0} onMouseUp={() => void add()}>＋ New task</text>
        <text flexShrink={0} fg={theme().textMuted} onMouseUp={cycleTag}>{`Tag: ${tag() ?? (tags().join(" ") || "none")} ▸`}</text>
        <text flexShrink={0} fg={theme().textMuted} onMouseUp={() => {
          setSort(nextSort(sort()))
          setCursor(0)
        }}>{`Sort: ${SORT_LABEL[sort() ?? "status"]} ▸`}</text>
        <text flexShrink={0} fg={theme().textMuted} onMouseUp={() => openSettingsDialog(context, props.sessionID)}>Settings ▸</text>
      </box>

      <text> </text>

      <input
        value={query()}
        placeholder="Search and press Enter (open, high, #12, @tag)"
        // focused: the host only gives the keyboard to an input that asks for it, so `/` (or a click) asks for it.
        focused={focusSearch()}
        onMouseUp={() => setFocusSearch(true)}
        onSubmit={(value) => {
          setQuery(value)
          setCursor(0)
          // Enter applies the search and hands the keyboard back to the list, so Esc is only the close key.
          setFocusSearch(false)
        }}
      />

      <text> </text>

      <box flexDirection="row">
        <text flexShrink={0} fg={theme().textMuted}>{"  "}</text>
        <For each={headerCells(tagWidth(), settings.descriptionWidth)
          .map((cell, position) => ({ cell, position }))
          .filter(({ position }) => visibleColumn(settings, position))}>
          {({ cell, position }) => (
            <text
              flexShrink={0}
              fg={theme().textMuted}
              onMouseUp={() => {
                const column = HEADER_SORTS[position]
                if (!column) return
                setSort(sort() === column ? undefined : column)
                setCursor(0)
              }}
            >{`${headerLabel(cell, position)} `}</text>
          )}
        </For>
      </box>

      <scrollbox
        // A real list, not pages: fixed height, own scroll offset, mouse wheel included.
        ref={setScroll}
        height={ROWS}
        flexShrink={0}
        flexDirection="column"
        focusable={false}
        verticalScrollbarOptions={{ visible: false }}
      >
        <For each={rows()}>
          {({ todo, index }, row) => (
            <box flexDirection="row">
              <text flexShrink={0} fg={theme().text}>{row() === at() ? "▸ " : "  "}</text>
              <For each={cellsOf(todo, tagWidth(), settings.descriptionWidth)
                .map((cell, position) => ({ cell, position }))
                .filter(({ position }) => visibleColumn(settings, position))}>
                {({ cell, position }) => (
                  <text
                    flexShrink={0}
                    fg={cellColor(theme(), todo, position, settings.palette)}
                    onMouseUp={() => {
                      if (position === 0 || position === 7) return void editTodo(context, props.sessionID, key(todo, index))
                      if (position === 1) return toggle(todo, index)
                      if (position === 2) return cyclePriority(todo, index)
                      if (position === 4) return void changeDue(context, props.sessionID, key(todo, index)).then(refresh)
                      if (position === 6) setTag(tagsOf(todo.content)[0])
                    }}
                  >{row() === at() ? <b>{`${cell} `}</b> : `${cell} `}</text>
                )}
              </For>
            </box>
          )}
        </For>
      </scrollbox>

      <text> </text>

      <box flexDirection="row" gap={2}>
        <text onMouseUp={() => move(-ROWS)}>▲</text>
        <text fg={theme().textMuted}>{rows().length ? `${at() + 1}/${rows().length}` : "0/0"}</text>
        <text onMouseUp={() => move(ROWS)}>▼</text>
        <text fg={theme().textMuted}>{STRINGS.dialog.count(rows().length)}</text>
      </box>
      <text> </text>
      <Show when={settings.showHints}>
        {/* Clicking the bar opens the full list of keys: one line is all that fits here. */}
        <box flexDirection="row" onMouseUp={() => openHelpDialog(context)}>
          <text fg={theme().textMuted}>
            {pendingDelete()
              ? `ctrl+d again to delete ${pendingDelete()} · Esc cancels`
              : "#id edit · ctrl+n new · ctrl+e edit · ctrl+d del · "}
          </text>
          <text fg={theme().info}><b>click for all keys</b></text>
        </box>
      </Show>
    </box>
  )
}

// Hidden columns are dropped before rendering; the click handler keeps the original index.
// Takes settings as an argument: this lives outside TodoDialog, where `settings` is not in scope.
const visibleColumn = (settings: Settings, position: number) =>
  position === 3 ? settings.showCreated
    : position === 5 ? settings.showDone
    : position === 6 ? settings.showTags
    : true

type SettingRow = { label: string; value: string; next: () => Settings }

const toggle = <K extends keyof Settings>(settings: Settings, key: K, values: ReadonlyArray<Settings[K]>): Settings => {
  const index = values.indexOf(settings[key])
  return { ...settings, [key]: values[(index + 1) % values.length] }
}

const yesNo = (value: boolean) => (value ? "on" : "off")

const settingRows = (settings: Settings): Array<SettingRow> => [
  { label: "Padding", value: String(settings.padding), next: () => toggle(settings, "padding", [0, 1, 2] as const) },
  { label: "Border", value: settings.borderStyle, next: () => toggle(settings, "borderStyle", ["rounded", "single", "none"] as const) },
  { label: "Palette", value: settings.palette, next: () => toggle(settings, "palette", ["theme", "fixed"] as const) },
  { label: "Column created", value: yesNo(settings.showCreated), next: () => ({ ...settings, showCreated: !settings.showCreated }) },
  { label: "Column done", value: yesNo(settings.showDone), next: () => ({ ...settings, showDone: !settings.showDone }) },
  { label: "Column tag", value: yesNo(settings.showTags), next: () => ({ ...settings, showTags: !settings.showTags }) },
  { label: "Description width", value: String(settings.descriptionWidth), next: () => toggle(settings, "descriptionWidth", [50, 60, 70, 80]) },
  { label: "Strip width", value: String(settings.stripMax), next: () => toggle(settings, "stripMax", [20, 30, 40, 50]) },
  { label: "Strip collapse after", value: String(settings.stripCollapse), next: () => toggle(settings, "stripCollapse", [3, 5, 8]) },
  { label: "Strip shows completed", value: yesNo(settings.stripCompleted), next: () => ({ ...settings, stripCompleted: !settings.stripCompleted }) },
  { label: "Strip header colour", value: yesNo(settings.stripHeaderColor), next: () => ({ ...settings, stripHeaderColor: !settings.stripHeaderColor }) },
  { label: "List rows", value: settings.pageRows === 0 ? "auto" : String(settings.pageRows), next: () => toggle(settings, "pageRows", [0, 4, 6, 8, 10, 12]) },
  { label: "Start filter", value: settings.initialFilter, next: () => toggle(settings, "initialFilter", ["all", "open", "closed", "overdue"] as const) },
  { label: "Start sort", value: settings.initialSort, next: () => toggle(settings, "initialSort", ["status", "due", "priority", "created", "done", "id"] as const) },
  { label: "Delete", value: settings.deleteMode === "double" ? "double ctrl+d" : "confirmation dialog", next: () => toggle(settings, "deleteMode", ["double", "dialog"] as const) },
  { label: "Renumber after done", value: yesNo(settings.renumberAfterDone), next: () => ({ ...settings, renumberAfterDone: !settings.renumberAfterDone }) },
  { label: "Create TODO.md automatically", value: yesNo(settings.autoInit), next: () => ({ ...settings, autoInit: !settings.autoInit }) },
  { label: "Show shortcut bar", value: yesNo(settings.showHints), next: () => ({ ...settings, showHints: !settings.showHints }) },
  { label: "Save to", value: settings.saveTo, next: () => toggle(settings, "saveTo", ["global", "project"] as const) },
]

const LABEL_WIDTH = 30
const VALUE_WIDTH = 24

function SettingsDialog(props: { sessionID: string; directory: string; close: () => void }) {
  const context = usePlugin()
  // The size set before show() is ignored on this build, so ask again once the dialog has mounted.
  onMount(() => context.ui.dialog.set?.({ size: "medium", centered: true }))
  const [current, setCurrent] = createSignal(loadSettings(props.directory))
  const [dirty, setDirty] = createSignal(false)
  // Nothing is written until Save: a stray click on a row cannot change the panel by accident.
  const change = (next: Settings) => {
    setCurrent(next)
    setDirty(true)
  }
  const save = () => {
    saveSettings(props.directory, current())
    context.ui.toast.show({ message: "Settings saved", variant: "success" })
    props.close()
  }
  const exportJson = async () => {
    const path = await context.ui.dialog.prompt({
      title: "Export settings",
      placeholder: "path of the JSON file",
      value: `${props.directory}/todo-md.json`,
    })
    if (!path) return
    writeFileSync(path, `${JSON.stringify(current(), null, 2)}\n`)
    context.ui.toast.show({ message: `Settings written to ${path}`, variant: "success" })
    props.close()
  }
  const importJson = async () => {
    const path = await context.ui.dialog.prompt({ title: "Import settings", placeholder: "path of the JSON file" })
    if (!path) return
    try {
      // mergeSettings validates every key, so a partial or hand-edited file cannot break the panel.
      change(mergeSettings(DEFAULT_SETTINGS, JSON.parse(readFileSync(path, "utf8"))))
    } catch {
      context.ui.toast.show({ message: `Cannot read ${path}`, variant: "error" })
    }
  }
  context.keymap.layer(() => ({
    mode: "global" as const,
    commands: [{ id: "opencode-todo-md.settings.close", title: "Todo: close settings", bind: "escape", run: () => props.close() }],
  }))
  // Same colour language as the README screenshot: on green, off muted, numbers warning, switches info.
  const theme = () => colorsOf(context)
  const valueFg = (value: string) =>
    value === "on"
      ? (theme().success ?? ROW_COLORS.completed)
      : value === "off"
        ? theme().textMuted
        : /^\d+$/.test(value)
          ? (theme().warning ?? ROW_COLORS.medium)
          : value === "theme" || value === "fixed"
            ? (theme().info ?? ROW_COLORS.id)
            : theme().text
  return (
    <box flexDirection="column" paddingLeft={1} paddingTop={1} border borderStyle="rounded" borderColor={colorsOf(context).textMuted}>
      <text><b>{`Settings${dirty() ? " *" : ""}`}</b></text>
      <text> </text>
      <For each={settingRows(current())}>
        {(row) => (
          <box flexDirection="row" onMouseUp={() => change(row.next())}>
            {/* Values share one right edge: a monospace pad keeps the column straight. */}
            <text flexShrink={0} fg={theme().textMuted}>{row.label.padEnd(LABEL_WIDTH)}</text>
            <text flexShrink={0} fg={valueFg(row.value)}>{clip(row.value, VALUE_WIDTH).padStart(VALUE_WIDTH)}</text>
            <Show when={row.label === "Palette"}>
              {/* A swatch shows the accent the chosen palette actually uses. */}
              <text fg={row.value === "fixed" ? ROW_COLORS.id : (theme().info ?? ROW_COLORS.id)}>{" █"}</text>
            </Show>
          </box>
        )}
      </For>
      <text> </text>
      <box flexDirection="row" gap={2}>
        <text flexShrink={0} fg={theme().success ?? ROW_COLORS.completed} onMouseUp={save}><b>Save</b></text>
        <text flexShrink={0} fg={theme().textMuted} onMouseUp={() => props.close()}>Cancel</text>
        <text flexShrink={0} fg={theme().success ?? ROW_COLORS.completed} onMouseUp={() => change({ ...DEFAULT_SETTINGS, saveTo: current().saveTo })}>Reset to defaults</text>
        <text flexShrink={0} fg={theme().info ?? ROW_COLORS.id} onMouseUp={() => void exportJson()}>Export JSON</text>
        <text flexShrink={0} fg={theme().info ?? ROW_COLORS.id} onMouseUp={() => void importJson()}>Import JSON</text>
      </box>
      <text> </text>
      <text fg={theme().textMuted}>Click a row to cycle it · Save writes the file · Esc cancels · the panel applies them next time it opens</text>
    </box>
  )
}

function openSettingsDialog(context: ReturnType<typeof usePlugin>, sessionID: string) {
  context.ui.dialog.clear()
  context.ui.dialog.set({ size: "medium", centered: true })
  const directory = directoryOf(context, sessionID)
  void context.ui.dialog.show(
    () => guarded("settings", () => <SettingsDialog sessionID={sessionID} directory={directory} close={() => context.ui.dialog.clear()} />),
    () => {},
  )
}

function openTodoDialog(context: ReturnType<typeof usePlugin>, sessionID: string) {
  context.ui.dialog.clear()
  // Size before show: resizing a mounted surface moves the box but leaves the mouse hit grid at the old size, so
  // clicks land on the wrong cell (or nowhere) and the search box cannot be focused.
  context.ui.dialog.set({ size: "xlarge", centered: true })
  void context.ui.dialog.show(
    () => guarded("todo", () => <TodoDialog sessionID={sessionID} close={() => context.ui.dialog.clear()} />),
    () => {},
  )
}

function HelpDialog(props: { close: () => void }) {
  const context = usePlugin()
  context.keymap.layer(() => ({
    mode: "global" as const,
    commands: [{ id: "opencode-todo-md.help.close", title: STRINGS.commands.close, bind: "escape", run: () => props.close() }],
  }))
  return (
    <box flexDirection="column" paddingLeft={1} paddingTop={1} border borderStyle="rounded" borderColor={colorsOf(context).textMuted}>
      <text>
        <b>{STRINGS.dialog.helpTitle}</b>
      </text>
      <text> </text>
      {/* Generated from the bindings themselves: a rebind cannot leave this list behind. */}
      <For each={SHORTCUTS}>
        {(row) => <text>{clip(`${row.bind.padEnd(9)}${row.title}`, 56)}</text>}
      </For>
      <text> </text>
      <For each={STRINGS.dialog.helpLegend}>
        {(line) => <text fg={colorsOf(context).textMuted}>{line}</text>}
      </For>
      <text> </text>
      <text fg={colorsOf(context).textMuted}>Esc closes</text>
    </box>
  )
}

/** The subcommands are arguments of `/todo`, so the palette cannot list them: this dialog does. */
function openHelpDialog(context: ReturnType<typeof usePlugin>) {
  context.ui.dialog.clear()
  context.ui.dialog.set({ size: "medium", centered: true })
  void context.ui.dialog.show(() => guarded("help", () => <HelpDialog close={() => context.ui.dialog.clear()} />), () => {})
}

function NotesDialog(props: { sessionID: string; close: () => void }) {
  const context = usePlugin()
  const directory = directoryOf(context, props.sessionID)
  const settings = loadSettings(directory)
  const theme = () => colorsOf(context)
  const [tick, setTick] = createSignal(0)
  const [cursor, setCursor] = createSignal(0)
  const [filter, setFilter] = createSignal("all")
  const [query, setQuery] = createSignal("")
  const [focusSearch, setFocusSearch] = createSignal(false)
  const [pendingDelete, setPendingDelete] = createSignal<number>()
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>()
  const loaded = createMemo(() => {
    tick()
    return readNotes(directory)
  })
  const notes = createMemo(() => loaded().notes)
  const rows = settings.pageRows > 0 ? settings.pageRows : Math.max(4, pageSize() - (settings.borderStyle === "none" ? 0 : 2))
  const tags = createMemo(() => [...new Set(notes().flatMap((note) => tagsOf(note.content)))])
  const filters = createMemo(() => [
    { key: "all", label: STRINGS.notes.all(notes().length) },
    { key: "due", label: STRINGS.notes.due(notes().filter((note) => isNoteDue(note)).length) },
    ...tags().map((tag) => ({
      key: tag,
      label: STRINGS.notes.tag(tag, notes().filter((note) => tagsOf(note.content).includes(tag)).length),
    })),
  ])
  const visible = createMemo(() => filterNotes(notes(), filter()))
  const shown = createMemo(() => {
    const search = query().trim().toLowerCase()
    return search ? visible().filter((note) => note.content.toLowerCase().includes(search)) : visible()
  })
  const at = () => Math.min(cursor(), Math.max(0, shown().length - 1))
  const current = () => shown()[at()]
  const dueCount = createMemo(() => notes().filter((note) => isNoteDue(note)).length)

  onMount(() => context.ui.dialog.set?.({ size: "xlarge", centered: true }))

  const save = (text: string, message: string) => {
    saveNotes(loaded().file, text)
    setTick((value) => value + 1)
    context.ui.toast.show({ message, variant: "success" })
  }

  const reset = () => {
    setPendingDelete(undefined)
    setCursor(0)
  }

  const cycleFilter = () => {
    const keys = filters().map((item) => item.key)
    setFilter(keys[(keys.indexOf(filter()) + 1) % keys.length] ?? "all")
    reset()
  }

  const search = () => setFocusSearch(true)

  const add = async () => {
    const content = await context.ui.dialog.prompt({ title: STRINGS.notes.newTitle, placeholder: STRINGS.notes.newPlaceholder })
    if (!content?.trim()) return
    save(appendNote(loaded().text, content).text, STRINGS.notes.added)
    setFilter("all")
    setQuery("")
    setCursor(shown().length - 1)
  }

  const edit = async () => {
    const note = current()
    if (!note) return
    const content = await context.ui.dialog.prompt({
      title: STRINGS.notes.editTitle,
      placeholder: STRINGS.notes.editPlaceholder,
      value: note.content,
    })
    if (!content?.trim() || content.trim() === note.content) return
    save(updateNote(loaded().text, note.id, { content }).text, STRINGS.notes.updated)
  }

  const remove = () => {
    const note = current()
    if (!note) return
    if (pendingDelete() !== note.id) return setPendingDelete(note.id)
    save(deleteNote(loaded().text, note.id).text, STRINGS.notes.deleted)
    setPendingDelete(undefined)
    setCursor((value) => Math.min(value, Math.max(0, shown().length - 1)))
  }

  const snooze = async () => {
    const note = current()
    if (!note) return
    const choice = await context.ui.dialog.select({
      title: STRINGS.notes.snooze,
      current: "",
      options: [
        { title: STRINGS.notes.snooze5, value: "5" },
        { title: STRINGS.notes.snooze30, value: "30" },
        { title: STRINGS.notes.snooze60, value: "60" },
        { title: STRINGS.notes.snoozeClear, value: "clear" },
      ],
    })
    if (choice === undefined) return
    if (choice === "clear") {
      save(updateNote(loaded().text, note.id, { remind: null }).text, STRINGS.notes.cleared)
      return
    }
    save(snoozeNote(loaded().text, note.id, Number(choice)).text, STRINGS.notes.snoozed)
  }

  const move = (delta: number) => {
    setPendingDelete(undefined)
    setCursor((value) => Math.max(0, Math.min(shown().length - 1, value + delta)))
  }

  const remindColor = (note: Note) => {
    if (!note.remind) return theme().textMuted
    if (isNoteDue(note)) return theme().error
    if (note.remind <= stamp(new Date(Date.now() + 7_200_000))) return theme().warning ?? theme().info
    return theme().textMuted
  }

  context.keymap.layer(() => ({
    mode: "global" as const,
    commands: [
      {
        id: "opencode-todo-md.notes.close",
        title: STRINGS.commands.close,
        bind: "escape",
        run: () => {
          if (focusSearch()) return setFocusSearch(false)
          props.close()
        },
      },
      { id: "opencode-todo-md.notes.up", title: STRINGS.commands.up, bind: "up", run: () => move(-1) },
      { id: "opencode-todo-md.notes.down", title: STRINGS.commands.down, bind: "down", run: () => move(1) },
      { id: "opencode-todo-md.notes.pageup", title: STRINGS.commands.pageUp, bind: "pageup", run: () => move(-rows) },
      { id: "opencode-todo-md.notes.pagedown", title: STRINGS.commands.pageDown, bind: "pagedown", run: () => move(rows) },
      { id: "opencode-todo-md.notes.home", title: STRINGS.commands.home, bind: "home", run: () => setCursor(0) },
      { id: "opencode-todo-md.notes.end", title: STRINGS.commands.end, bind: "end", run: () => setCursor(Math.max(0, shown().length - 1)) },
      { id: "opencode-todo-md.notes.search", title: STRINGS.notes.search, bind: "/", run: search },
      { id: "opencode-todo-md.notes.filter", title: STRINGS.notes.filter, bind: "tab", run: cycleFilter },
      { id: "opencode-todo-md.notes.create", title: STRINGS.commands.create, bind: "ctrl+n", run: add },
      { id: "opencode-todo-md.notes.edit", title: STRINGS.commands.edit, bind: "ctrl+e", run: edit },
      {
        id: "opencode-todo-md.notes.snooze",
        title: STRINGS.notes.snooze,
        bind: "s",
        run: () => {
          if (focusSearch()) return
          void snooze()
        },
      },
      { id: "opencode-todo-md.notes.delete", title: STRINGS.commands.delete, bind: "ctrl+d", run: remove },
    ],
  }))

  createEffect(() => {
    const box = scroll()
    if (!box) return
    const c = at()
    const top = box.scrollTop
    if (c < top) box.scrollTo(c)
    else if (c >= top + rows) box.scrollTo(c - rows + 1)
  })

  return (
    <box
      flexDirection="column"
      border={settings.borderStyle !== "none"}
      borderStyle={settings.borderStyle === "none" ? undefined : settings.borderStyle}
      borderColor={pendingDelete() ? (theme().error ?? ROW_COLORS.overdue) : query() ? (theme().info ?? ROW_COLORS.id) : theme().textMuted}
      paddingLeft={settings.padding}
      paddingTop={settings.padding}
    >
      <text>
        <b>{STRINGS.notes.title}</b>
      </text>
      <text fg={theme().textMuted}>{`${notes().length} ${notes().length === 1 ? "note" : "notes"} · ${dueCount()} due`}</text>
      <text> </text>
      <box flexDirection="row" gap={1}>
        <For each={filters()}>
          {(item) => (
            <text
              flexShrink={0}
              fg={item.key === filter() ? theme().text : theme().textMuted}
              onMouseUp={() => {
                setFilter(item.key)
                reset()
              }}
            >{`${item.key === filter() ? "●" : "○"} ${item.label}`}</text>
          )}
        </For>
      </box>
      <input
        value={query()}
        placeholder={STRINGS.notes.searchPlaceholder}
        focused={focusSearch()}
        onMouseUp={() => setFocusSearch(true)}
        onSubmit={(value) => {
          setQuery(value)
          setCursor(0)
          setFocusSearch(false)
        }}
      />
      <Show when={query()}>
        <text fg={theme().info}>{`Search: ${query()}`}</text>
      </Show>
      <text> </text>
      <box flexDirection="row" gap={1}>
        <text>{"  "}</text>
        <text width={4} fg={theme().textMuted}><b>#id</b></text>
        <text width={40} fg={theme().textMuted}><b>note</b></text>
        <text width={14} fg={theme().textMuted}><b>tags</b></text>
        <text width={16} fg={theme().textMuted}><b>remind</b></text>
      </box>
      <Show
        when={shown().length > 0}
        fallback={
          <text fg={theme().textMuted}>{notes().length === 0 ? STRINGS.notes.empty : STRINGS.notes.emptyFiltered}</text>
        }
      >
        <scrollbox
          ref={setScroll}
          height={rows}
          flexShrink={0}
          flexDirection="column"
          focusable={false}
          verticalScrollbarOptions={{ visible: false }}
        >
          <For each={shown()}>
            {(note, index) => (
              <box flexDirection="row" gap={1}>
                <text>{index() === at() ? "▸ " : "  "}</text>
                <text width={4} fg={theme().textMuted}>{`#${note.id}`}</text>
                <text width={40}>{clip(note.content, 40)}</text>
                <text width={14} fg={theme().info}>{clip(tagsOf(note.content).join(" "), 14) || "—"}</text>
                <text width={16} fg={remindColor(note)}>{note.remind ?? "—"}</text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
      <text> </text>
      <text fg={theme().textMuted}>{STRINGS.notes.page(at() + 1, shown().length)}</text>
      <text fg={theme().textMuted}>{STRINGS.notes.hint}</text>
    </box>
  )
}

function openNotesDialog(context: ReturnType<typeof usePlugin>, sessionID: string) {
  context.ui.dialog.clear()
  context.ui.dialog.set({ size: "large", centered: true })
  void context.ui.dialog.show(() => guarded("notes", () => <NotesDialog sessionID={sessionID} close={() => context.ui.dialog.clear()} />), () => {})
}

function Strip(props: { sessionID: string }) {
  const context = usePlugin()
  const settings = loadSettings(directoryOf(context, props.sessionID))
  const [tick, setTick] = createSignal(0)
  const [open, setOpen] = createSignal(true)

  // Re-reads on mount, after our own dialog writes, when a tool call completes (the agent writing TODO.md), and every 60s as a fallback for hand edits.
  onMount(() => {
    const refresher = createRefresher(() => setTick((value) => value + 1))
    onCleanup(() => refresher.stop())
    const data = context.data as unknown as {
      on?: (
        type: string,
        handler: (event: { data?: { part?: { type?: string; state?: { status?: string } } } }) => void,
      ) => () => void
    }
    const stop = data.on?.("message.part.updated", (event) => {
      const part = event.data?.part
      if (part?.type === "tool" && part.state?.status === "completed") refresher.push()
    })
    if (stop) onCleanup(stop)
    onCleanup(onTodosChanged(() => setTick((value) => value + 1)))
    onCleanup(onNotesChanged(() => setTick((value) => value + 1)))

    const seen = new Set<string>()
    const checkReminders = () => {
      const { notes } = readNotes(directoryOf(context, props.sessionID))
      for (const note of notes) {
        if (!note.remind || !isNoteDue(note)) continue
        const key = `${note.id}:${note.remind}`
        if (seen.has(key)) continue
        seen.add(key)
        context.ui.toast.show({ message: STRINGS.notes.reminder(note.id, note.content), variant: "warning" })
      }
    }
    checkReminders()
    const reminders = setInterval(checkReminders, 30_000)
    onCleanup(() => clearInterval(reminders))
  })

  const noteCommand = (input?: string) => {
    const args = String(input ?? "").trim()
    if (!args || args === "list") return openNotesDialog(context, props.sessionID)
    const match = args.match(/\s+remind=(\S+)\s*$/i)
    const content = match ? args.slice(0, match.index ?? args.length).trim() : args
    const remind = parseRemind(match ? match[1] : "")
    if (!remind.ok) {
      context.ui.toast.show({ message: STRINGS.notes.invalidRemind, variant: "error" })
      return
    }
    if (!content) return openNotesDialog(context, props.sessionID)
    const loadedNotes = readNotes(directoryOf(context, props.sessionID))
    saveNotes(loadedNotes.file, appendNote(loadedNotes.text, content, { remind: remind.remind }).text)
    context.ui.toast.show({ message: STRINGS.notes.added, variant: "success" })
  }

  const openList = () => {
    // The setting is opt-in: creating files behind the user's back is not the default.
    if (settings.autoInit) {
      const file = loaded()?.file
      if (file && !existsSync(file)) initTodo(context, props.sessionID)
    }
    openTodoDialog(context, props.sessionID)
  }

  context.keymap.layer(() => ({
    mode: "global" as const,
    commands: [
      {
        id: "opencode-todo-md.note",
        title: STRINGS.commands.openNotes,
        slash: { name: "note", arguments: true },
        palette: true,
        run: (input?: string) => noteCommand(input),
      },
      {
        id: "opencode-todo-md.open",
        title: STRINGS.commands.openList,
        slash: { name: "todo", arguments: true },
        palette: true,
        run: (input?: string) => {
          const command = parseTodoCommand(String(input ?? ""))
          if (command.action === "init") {
            initTodo(context, props.sessionID)
            return openList()
          }
          if (command.action === "import")
            return void importTodo(context, props.sessionID).then((converted) => converted && openList())
          if (command.action === "renumber")
            return void renumberTodo(context, props.sessionID).then((changed) => changed && openList())
          if (command.action === "add" && command.text)
            return void addTodo(context, props.sessionID, command.text, command.priority, command.due)
          if (command.action === "done") {
            completeTodo(context, props.sessionID, command.id)
            return openList()
          }
          if (command.action === "help") return openHelpDialog(context)
          if (command.action === "settings") return openSettingsDialog(context, props.sessionID)
          return openList()
        },
      },
    ],
  }))

  const loaded = createMemo(() => {
    tick()
    return readFile(directoryOf(context, props.sessionID))
  })
  const todos = createMemo(() => loaded()?.todos ?? [])
  // A TODO.md with no checkbox is an unmanaged file: say so instead of hiding the strip as if the list were empty.
  const emptyFile = () => {
    const file = loaded()?.file
    return !!file && existsSync(file) && todos().length === 0
  }
  const done = createMemo(() => todos().filter((todo) => todo.status === "completed").length)
  const collapsible = () => todos().length > settings.stripCollapse
  const noteList = createMemo(() => {
    tick()
    return readNotes(directoryOf(context, props.sessionID)).notes
  })
  const noteCount = createMemo(() => noteList().length)
  const noteDue = createMemo(() => noteList().filter((note) => isNoteDue(note)).length)
  const [notesOpen, setNotesOpen] = createSignal(true)
  const notesCollapsible = () => noteCount() > 0

  // Color carries the priority: red high, yellow medium, muted low or unset. An overdue task is always red.
  const colorOf = (todo: Todo) => (isOverdue(todo) ? colorsOf(context).error : priorityColor(colorsOf(context), todo.priority))

  // Header carries the highest priority still open, so a collapsed strip still signals urgency.
  const headerColor = createMemo(() => {
    const theme = colorsOf(context)
    const pending = todos().filter((todo) => todo.status === "pending" || todo.status === "in_progress")
    if (pending.some(isOverdue)) return theme.error
    if (pending.some((todo) => todo.priority === "high")) return theme.error
    if (pending.some((todo) => todo.priority === "medium")) return theme.warning
    return theme.text
  })

  return (
    <box flexDirection="column" gap={0}>
    <Show when={noteCount() > 0}>
      <box width="100%" flexDirection="row" gap={1}>
        <Show when={notesCollapsible()}>
          <box flexShrink={0} onMouseUp={() => setNotesOpen((value) => !value)}>
            <text fg={colorsOf(context).text}>{notesOpen() ? "▼" : "▶"}</text>
          </box>
        </Show>
        <box flexGrow={1} minWidth={0} onMouseUp={() => openNotesDialog(context, props.sessionID)}>
          <text fg={colorsOf(context).textMuted}>
            <b>{`Notes ${noteDue()}/${noteCount()}`}</b>
          </text>
        </box>
      </box>
      <Show when={!notesCollapsible() || notesOpen()}>
        <For each={noteList()}>
          {(note) => {
            const prefix = `#${note.id} `
            return (
              <text
                onMouseUp={() => openNotesDialog(context, props.sessionID)}
                fg={isNoteDue(note) ? colorsOf(context).error : colorsOf(context).textMuted}
              >
                {prefix + clip(note.content, settings.stripMax - prefix.length)}
              </text>
            )
          }}
        </For>
      </Show>
    </Show>
    <Show
      when={todos().length > 0}
      fallback={
        // The slot crashes the whole sidebar if a render returns undefined: always render an element.
        <Show when={emptyFile()} fallback={<text> </text>}>
          <text fg={colorsOf(context).textMuted} onMouseUp={() => openList()}>
            Todo · no tasks
          </text>
        </Show>
      }
    >
      <box flexDirection="column" gap={0}>
        <box width="100%" flexDirection="row" gap={1}>
          <Show when={collapsible()}>
            <box flexShrink={0} onMouseUp={() => setOpen((value) => !value)}>
              <text fg={colorsOf(context).text}>{open() ? "▼" : "▶"}</text>
            </box>
          </Show>
          <box flexGrow={1} minWidth={0} onMouseUp={() => openList()}>
            <text fg={settings.stripHeaderColor ? headerColor() : colorsOf(context).text}>
              <b>{`Todo ${done()}/${todos().length}`}</b>
            </text>
          </box>
        </box>
        <Show when={!collapsible() || open()}>
          <For each={todos().filter((todo) => todo.status !== "cancelled" && (settings.stripCompleted || todo.status !== "completed"))}>
            {(todo) => {
              // The row maps back to the file by position, so a click opens the list on that task.
              const index = todos().indexOf(todo)
              const id = todo.id ? `#${todo.id} ` : ""
              // Compact prefix: the sidebar is narrow, and a long prefix pushes the text into a second line.
              // Priority rides on the colour alone; `!` and `[!]` were both red and read as the same alarm.
              const prefix = `${id}${todo.status === "in_progress" ? "• " : ""}${isOverdue(todo) ? "[!] " : isDueSoon(todo) ? "[·] " : ""}`
              return (
                <text
                  // The built-in sidebar rows use mouseup; mousedown is not delivered to text renderables here.
                  onMouseUp={() => openList()}
                  fg={colorOf(todo)}
                >
                  {prefix + clip(todo.content, settings.stripMax - prefix.length)}
                </text>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
    </box>
  )
}

export default Plugin.define({
  id: "opencode-todo-md.tui",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: (props) => guarded("sidebar", () => <Strip sessionID={props.sessionID} />),
    })
  },
})
