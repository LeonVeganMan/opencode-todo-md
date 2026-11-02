/** @jsxImportSource @opentui/solid */
import { existsSync } from "node:fs"
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import {
  FILTER_LABEL,
  FILTER_ORDER,
  SORT_LABEL,
  addTodo,
  cellsOf,
  changeDue,
  completeTodo,
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
  sortBy,
  sortTodos,
  tagWidthOf,
  tagsOf,
  toggleTodo,
  todosFor,
  updateTodo,
  type SortKey,
  type TodoFilter,
} from "./command.ts"
import { createRefresher } from "./refresh.ts"
import { STRINGS } from "./strings.ts"
import { pageSize } from "./page.ts"
import { isOverdue, type Todo, type TodoPriority } from "./checklist.ts"

// "none" clears the priority: updateTodo passes it through as an explicit undefined.
const EDIT_PRIORITIES: Array<TodoPriority | undefined> = [undefined, "high", "medium", "low"]

const isoDay = (offset: number) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/** Due dates are picked, not typed: the dialog already has a text input and focus would fight over it. */
const DUE_CHOICES = [
  { label: "none", value: undefined },
  { label: "oggi", value: isoDay(0) },
  { label: "+7g", value: isoDay(7) },
  { label: "+30g", value: isoDay(30) },
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
  const cycle = () => {
    const index = EDIT_PRIORITIES.indexOf(priority())
    setPriority(EDIT_PRIORITIES[(index + 1) % EDIT_PRIORITIES.length])
  }
  const save = (value: string) => {
    const content = value.trim()
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
    <box flexDirection="column" gap={1}>
      <text>Edit task</text>
      <Show when={props.todo.done}>
        <text>{`Completed ${props.todo.done}`}</text>
      </Show>
      <input value={props.todo.content} focused={!dueEditing()} onSubmit={save} />
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
      <text>Tab priority · ✎ due types a date · Enter saves · Esc cancels</text>
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
      () => (
        <EditDialog
          todo={todo}
          onSave={(content, priority, due) => {
            updateTodo(context, sessionID, value, { content, priority, due })
            context.ui.dialog.clear()
          }}
          onCancel={() => context.ui.dialog.clear()}
        />
      ),
      () => {
        resolve()
        // Esc or save closes only the editor: reopening on the next tick lets the host finish closing first.
        setTimeout(() => openTodoDialog(context, sessionID), 0)
      },
    )
  })
}

// theme.text is an object (base/muted/feedback.*.base), not a color: passing it straight to fg crashes the renderer.
type ThemeText = { base?: string; muted?: string; feedback?: { error?: { base?: string }; warning?: { base?: string } } }
type ThemeColors = { error?: string; warning?: string; textMuted?: string; text?: string }
const colorsOf = (context: { theme?: unknown }): ThemeColors => {
  const theme = (context.theme ?? {}) as { text?: ThemeText; current?: { text?: ThemeText } }
  const text = theme.text ?? theme.current?.text ?? {}
  return {
    error: text.feedback?.error?.base,
    warning: text.feedback?.warning?.base,
    textMuted: text.muted,
    text: text.base,
  }
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
  // Recomputed on every open: a resize between dialogs is picked up.
  const PAGE = pageSize()
  // A size set before show() is ignored on this build, so ask again from inside the dialog.
  onMount(() => context.ui.dialog.set?.({ size: "xlarge", centered: true }))
  const [tick, setTick] = createSignal(0)
  const [filter, setFilter] = createSignal<TodoFilter>("all")
  const [priority, setPriority] = createSignal<TodoPriority | undefined>()
  const [tag, setTag] = createSignal<string | undefined>()
  const [sort, setSort] = createSignal<SortKey | undefined>()
  const [page, setPage] = createSignal(0)
  const [query, setQuery] = createSignal("")
  const [cursor, setCursor] = createSignal(0)
  // The search box takes the keyboard only when it asks: `/` focuses it, Esc hands it back to the list.
  const [focusSearch, setFocusSearch] = createSignal(false)
  const [pendingDelete, setPendingDelete] = createSignal<string | undefined>()

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
  const rows = createMemo(() => {
    const filtered = base().filter((todo) => matchesQuery(todo, query()))
    return sort() ? sortBy(filtered, sort()!) : sortTodos(filtered)
  })
  const tagWidth = createMemo(() => tagWidthOf(base()))
  const pages = createMemo(() => Math.max(1, Math.ceil(rows().length / PAGE)))
  const current = () => Math.min(page(), pages() - 1)
  const visible = () => rows().slice(current() * PAGE, current() * PAGE + PAGE)

  const key = (todo: Todo, index: number) => (todo.id !== undefined ? `#${todo.id}` : `t${index}`)
  const refresh = () => setTick((value) => value + 1)

  // The list keeps its own cursor while the search box does not have the keyboard.
  const selected = () => visible()[Math.min(cursor(), Math.max(0, visible().length - 1))]
  const move = (delta: number) => {
    setPendingDelete(undefined)
    const next = cursor() + delta
    // Walking past the last visible row turns the page instead of stopping at the edge.
    if (next >= visible().length) {
      if (current() >= pages() - 1) return
      setPage(current() + 1)
      setCursor(0)
      return
    }
    if (next < 0) {
      if (current() === 0) return
      setPage(current() - 1)
      setCursor(PAGE - 1)
      return
    }
    setCursor(next)
  }
  // Two ctrl+d like the editor: the first arms the task, the second deletes it. No dialog to dismiss.
  const deleteSelected = () => {
    const item = selected()
    if (!item) return
    const value = key(item.todo, item.index)
    if (pendingDelete() !== value) return setPendingDelete(value)
    removeTodo(context, props.sessionID, value)
    setPendingDelete(undefined)
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
    setPage(0)
  }
  const cyclePriority = (todo: Todo, index: number) => {
    const next = NEXT_PRIORITY[(NEXT_PRIORITY.indexOf(todo.priority) + 1) % NEXT_PRIORITY.length]
    updateTodo(context, props.sessionID, key(todo, index), { content: todo.content, priority: next })
    refresh()
  }
  const toggle = (todo: Todo, index: number) => {
    toggleTodo(context, props.sessionID, key(todo, index))
    refresh()
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
          setPage(Math.max(0, current() - 1))
          setCursor(0)
        },
      },
      {
        id: "opencode-todo-md.pagedown",
        title: STRINGS.commands.pageDown,
        bind: "pagedown",
        run: () => {
          if (focusSearch()) return
          setPendingDelete(undefined)
          setPage(Math.min(pages() - 1, current() + 1))
          setCursor(0)
        },
      },
      {
        id: "opencode-todo-md.home",
        title: STRINGS.commands.home,
        bind: "home",
        run: () => {
          if (focusSearch()) return
          setPendingDelete(undefined)
          setPage(0)
          setCursor(0)
        },
      },
      {
        id: "opencode-todo-md.end",
        title: STRINGS.commands.end,
        bind: "end",
        run: () => {
          if (focusSearch()) return
          setPendingDelete(undefined)
          setPage(pages() - 1)
          setCursor(0)
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
    ],
  }))

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <For each={FILTER_ORDER}>
          {(value) => (
            <text
              flexShrink={0}
              fg={value === filter() ? theme().text : theme().textMuted}
              onMouseUp={() => {
                setFilter(value)
                setPage(0)
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
                setPage(0)
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
          setPage(0)
        }}>{`Sort: ${SORT_LABEL[sort() ?? "status"]} ▸`}</text>
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
          setPage(0)
          // Enter applies the search and hands the keyboard back to the list, so Esc is only the close key.
          setFocusSearch(false)
        }}
      />

      <text> </text>

      <box flexDirection="row">
        <text flexShrink={0} fg={theme().textMuted}>{"  "}</text>
        <For each={headerCells(tagWidth())}>
          {(cell, position) => (
            <text
              flexShrink={0}
              fg={theme().textMuted}
              onMouseUp={() => {
                const column = HEADER_SORTS[position()]
                if (!column) return
                setSort(sort() === column ? undefined : column)
                setPage(0)
              }}
            >{`${headerLabel(cell, position())} `}</text>
          )}
        </For>
      </box>

      <For each={visible()}>
        {({ todo, index }, row) => (
          <box flexDirection="row">
            <text flexShrink={0} fg={theme().text}>{row() === cursor() ? "▸ " : "  "}</text>
            <For each={cellsOf(todo, tagWidth())}>
              {(cell, position) => (
                <text
                  flexShrink={0}
                  fg={isOverdue(todo) ? theme().error : priorityColor(theme(), todo.priority)}
                  onMouseUp={() => {
                    if (position() === 0) return void editTodo(context, props.sessionID, key(todo, index))
                    if (position() === 1 || position() === 7) return toggle(todo, index)
                    if (position() === 2) return cyclePriority(todo, index)
                    if (position() === 4) return void changeDue(context, props.sessionID, key(todo, index)).then(refresh)
                    if (position() === 6) setTag(tagsOf(todo.content)[0])
                  }}
                >{row() === cursor() ? <b>{`${cell} `}</b> : `${cell} `}</text>
              )}
            </For>
          </box>
        )}
      </For>

      <text> </text>

      <box flexDirection="row" gap={2}>
        <text onMouseUp={() => { setPage((value) => Math.max(0, value - 1)); setCursor(0) }}>▲</text>
        <text fg={theme().textMuted}>{`${current() + 1}/${pages()}`}</text>
        <text onMouseUp={() => { setPage((value) => Math.min(pages() - 1, value + 1)); setCursor(0) }}>▼</text>
        <text fg={theme().textMuted}>{STRINGS.dialog.count(rows().length)}</text>
      </box>
      <text>
        {pendingDelete()
          ? `ctrl+d again to delete ${pendingDelete()}`
          : "Click: #id edits · ctrl+n new · ctrl+e edits · status toggles · priority cycles · due prompts · / searches · Esc closes"}
      </text>
    </box>
  )
}

function openTodoDialog(context: ReturnType<typeof usePlugin>, sessionID: string) {
  context.ui.dialog.clear()
  // Size before show: resizing a mounted surface moves the box but leaves the mouse hit grid at the old size, so
  // clicks land on the wrong cell (or nowhere) and the search box cannot be focused.
  context.ui.dialog.set({ size: "xlarge", centered: true })
  void context.ui.dialog.show(
    () => <TodoDialog sessionID={sessionID} close={() => context.ui.dialog.clear()} />,
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
    <box flexDirection="column" gap={1}>
      <text>
        <b>{STRINGS.dialog.helpTitle}</b>
      </text>
      <For each={STRINGS.dialog.help}>{(line) => <text>{line}</text>}</For>
      <text fg={colorsOf(context).textMuted}>Esc closes</text>
    </box>
  )
}

/** The subcommands are arguments of `/todo`, so the palette cannot list them: this dialog does. */
function openHelpDialog(context: ReturnType<typeof usePlugin>) {
  context.ui.dialog.clear()
  context.ui.dialog.set({ size: "medium", centered: true })
  void context.ui.dialog.show(() => <HelpDialog close={() => context.ui.dialog.clear()} />, () => {})
}

function Strip(props: { sessionID: string }) {
  const context = usePlugin()
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
  })

  const openList = () => openTodoDialog(context, props.sessionID)

  context.keymap.layer(() => ({
    mode: "global" as const,
    commands: [
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
  const collapsible = () => todos().length > 3

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
            <text fg={headerColor()}>
              <b>{`Todo ${done()}/${todos().length}`}</b>
            </text>
          </box>
        </box>
        <Show when={!collapsible() || open()}>
          <For each={todos().filter((todo) => todo.status !== "completed" && todo.status !== "cancelled")}>
            {(todo) => {
              // The row maps back to the file by position, so a click opens the list on that task.
              const index = todos().indexOf(todo)
              const id = todo.id ? `#${todo.id} ` : ""
              // Compact prefix: the sidebar is narrow, and a long prefix pushes the text into a second line.
              const prefix = `${id}${todo.status === "in_progress" ? "• " : ""}${todo.priority === "high" ? "! " : ""}${isOverdue(todo) ? "[!] " : ""}`
              return (
                <text
                  // The built-in sidebar rows use mouseup; mousedown is not delivered to text renderables here.
                  onMouseUp={() => openList()}
                  fg={colorOf(todo)}
                >
                  {prefix + clip(todo.content, STRIP_MAX - prefix.length)}
                </text>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode-todo-md.tui",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: (props) => <Strip sessionID={props.sessionID} />,
    })
  },
})
