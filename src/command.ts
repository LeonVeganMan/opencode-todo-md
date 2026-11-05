import { STRINGS } from "./strings.ts"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TODO_PRIORITIES, applyChecklist, importBullets, insertChecklistItem, isOverdue, parseChecklist, removeChecklistItem, renumberChecklist, type Todo, type TodoPriority } from "./checklist.ts"

export type SelectOption = {
  title: string
  value: string
  description?: string
  disabled?: boolean
}

type DialogContext = {
  data?: { session?: { get?: (id: string) => { directory?: string } | undefined } }
  location?: { directory?: string }
  ui: {
    dialog: {
      select: (input: {
        title: string
        options: Array<SelectOption>
        search?: (query: string, options: Array<SelectOption>) => Array<SelectOption>
        current?: string
        actions?: Array<{ bind: string; title: string; onTrigger: (value: string) => void }>
      }) => Promise<string | undefined>
      prompt: (input: { title: string; placeholder?: string; value?: string }) => Promise<string | undefined>
      confirm: (input: { title: string; message: string }) => Promise<boolean>
      // Optional: the host sizes dialogs from a shared stack, so the list can ask for the widest one.
      set?: (input: { size?: "medium" | "large" | "xlarge"; centered?: boolean }) => void
    }
    toast: { show: (input: { message: string; variant?: "info" | "success" | "warning" | "error" }) => void }
  }
}

/** TODO.md lives in the session's project directory, never in the process cwd. */
export function directoryOf(context: DialogContext, sessionID: string): string | undefined {
  return context.data?.session?.get?.(sessionID)?.directory ?? context.location?.directory
}

export function readFile(directory: string | undefined): { file: string; text: string; todos: Array<Todo> } | undefined {
  if (!directory) return undefined
  const file = join(directory, "TODO.md")
  const text = existsSync(file) ? readFileSync(file, "utf8") : "# TODO\n"
  return { file, text, todos: parseChecklist(text).items.map((item) => item.todo) }
}

const PRIORITY_RANK: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 }
const FAR_DATE = "9999-99-99"

/** Priority high to low, then the nearest due date; tasks without a date go last. */
function byPriorityThenDue(a: Todo, b: Todo): number {
  const rank = (a.priority ? PRIORITY_RANK[a.priority] : 3) - (b.priority ? PRIORITY_RANK[b.priority] : 3)
  if (rank !== 0) return rank
  return (a.due ?? FAR_DATE).localeCompare(b.due ?? FAR_DATE)
}

/** Same order the ids get on renumber: open tasks by priority and due date, closed ones at the bottom. */
export function sortTodos(todos: Array<Todo>): Array<{ todo: Todo; index: number }> {
  return renumberOrder(todos).map((index) => ({ todo: todos[index], index }))
}

const FILTER_WORDS: Record<string, (todo: Todo) => boolean> = {
  open: (todo) => todo.status === "pending" || todo.status === "in_progress",
  done: (todo) => todo.status === "completed",
  cancelled: (todo) => todo.status === "cancelled",
  high: (todo) => todo.priority === "high",
  medium: (todo) => todo.priority === "medium",
  low: (todo) => todo.priority === "low",
}

/** Query language shared by the select search and the custom dialog: open/done/high/…, `#id`, `@tag`, free text. */
export function matchesQuery(todo: Todo, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return words.every((word) => {
    const filter = FILTER_WORDS[word]
    if (filter) return filter(todo)
    if (word.startsWith("#")) return String(todo.id) === word.slice(1)
    if (word.startsWith("@")) return todo.content.toLowerCase().split(/\s+/).some((token) => token.startsWith(word))
    return todo.content.toLowerCase().includes(word)
  })
}

/** Empty query keeps the sorted list; otherwise words filter (open/done/high/…, `#id`, `@tag`) and free text matches the task. */
export function filterOptions(query: string, options: Array<SelectOption>, todos: Array<{ todo: Todo; index: number }>): Array<SelectOption> {
  if (query.trim() === "") return options

  const matched = todos.filter(({ todo }) => matchesQuery(todo, query))
  // Options are keyed by `#id` now; `t<index>` stays for files written before ids.
  const keep = new Set(
    matched.flatMap(({ todo, index }) => [`t${index}`, todo.id !== undefined ? `#${todo.id}` : ""]),
  )
  return options.filter((option) => option.value === "new" || keep.has(option.value))
}

/** Counts live once in the title: the select prints `category` inline on every row, which reads as if each task had 24 items. */
export function summaryTitle(todos: Array<Todo>): string {
  const count = (match: (todo: Todo) => boolean) => todos.filter(match).length
  const label = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`
  const parts = [
    STRINGS.summary.title,
    label(count((todo) => todo.status === "pending" || todo.status === "in_progress"), STRINGS.summary.open, STRINGS.summary.open),
  ]
  const completed = count((todo) => todo.status === "completed")
  if (completed) parts.push(label(completed, STRINGS.summary.completed, STRINGS.summary.completed))
  const cancelled = count((todo) => todo.status === "cancelled")
  if (cancelled) parts.push(label(cancelled, STRINGS.summary.cancelled, STRINGS.summary.cancelled))
  return parts.join(" · ")
}

/** Table columns. Monospace makes padding real alignment inside the select row. */
const COL_ID = 4
const COL_STATUS = 3
const COL_PRIORITY = 6
const COL_CREATED = 10
const COL_DUE = 11
const COL_DONE = 10
const COL_TAGS = 8
const COL_CONTENT = 50

/** Pads to the column width, or clips with an ellipsis so the row never wraps. */
const cell = (text: string, width: number) =>
  text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)

const STATUS_LABEL: Record<string, string> = { ...STRINGS.statuses }

/** `@tag` tokens in the task text, deduplicated. They are only a convention, nothing is stored. */
export function tagsOf(content: string): Array<string> {
  const found = content.match(/(^|\s)@[\w-]+/g) ?? []
  return [...new Set(found.map((tag) => tag.trim()))]
}

/** Header cells, one per column: the custom dialog renders each as its own clickable text. */
export function headerCells(tagWidth: number = COL_TAGS, contentWidth: number = COL_CONTENT): Array<string> {
  return [
    cell(STRINGS.table.id, COL_ID),
    cell(STRINGS.table.status, COL_STATUS),
    cell(STRINGS.table.priority, COL_PRIORITY),
    cell(STRINGS.table.created, COL_CREATED),
    cell(STRINGS.table.due, COL_DUE),
    cell(STRINGS.table.done, COL_DONE),
    cell(STRINGS.table.tags, tagWidth),
    cell(STRINGS.table.content, contentWidth),
  ]
}

/** Header row; the tag column can widen to the longest tag the project actually uses. */
export function tableHeader(tagWidth: number = COL_TAGS): string {
  return headerCells(tagWidth).join(" ")
}

export const TABLE_HEADER = tableHeader()

/** Due date, prefixed by ! when overdue. The full ISO date fits: the column is 11 wide. */
const dueCell = (todo: Todo) => (todo.due ? `${isOverdue(todo) ? "!" : ""}${todo.due}` : "-")

/** One table row: every column is fixed-width, so headers and rows line up. The description is the last column: at xlarge (116) the row fits on one line. */
export function cellsOf(todo: Todo, tagWidth: number = COL_TAGS, contentWidth: number = COL_CONTENT): Array<string> {
  return [
    cell(todo.id !== undefined ? `#${todo.id}` : "-", COL_ID),
    cell(STATUS_LABEL[todo.status] ?? todo.status, COL_STATUS),
    cell(todo.priority ?? "-", COL_PRIORITY),
    cell(todo.created ?? "-", COL_CREATED),
    cell(dueCell(todo), COL_DUE),
    cell(todo.done ?? "-", COL_DONE),
    cell(tagsOf(todo.content).join(" "), tagWidth),
    cell(descriptionOf(todo), contentWidth),
  ]
}

/** The task text, whitespace collapsed: it goes on a line of its own under the meta row. */
export function descriptionOf(todo: Todo): string {
  return todo.content.replace(/\s+/g, " ")
}

export function tableRow(todo: Todo, tagWidth: number = COL_TAGS): string {
  return cellsOf(todo, tagWidth).join(" ")
}

/** Widest tag in the list, clamped so the description keeps room and the row does not jump around. */
export function tagWidthOf(todos: Array<Todo>): number {
  const lengths = todos.flatMap((todo) => tagsOf(todo.content).map((tag) => tag.length))
  return Math.min(8, Math.max(6, ...lengths))
}

export type SortKey = "id" | "due" | "priority" | "created" | "done"

export type TodoFilter = "all" | "open" | "doing" | "closed" | "due"

export const FILTER_ORDER: Array<TodoFilter> = ["all", "open", "doing", "closed", "due"]
export const FILTER_LABEL: Record<TodoFilter, string> = { ...STRINGS.filters }
export function nextFilter(current: TodoFilter = "all"): TodoFilter {
  return FILTER_ORDER[(FILTER_ORDER.indexOf(current) + 1) % FILTER_ORDER.length]
}

/** Keeps open (pending/in_progress), in progress, closed (completed/cancelled) or overdue tasks; `all` is a no-op. */
export function todosFor(todos: Array<Todo>, filter: TodoFilter = "all"): Array<Todo> {
  if (filter === "all") return todos
  if (filter === "due") return todos.filter(isOverdue)
  if (filter === "doing") return todos.filter((todo) => todo.status === "in_progress")
  const open = filter === "open"
  return todos.filter((todo) =>
    open ? todo.status === "pending" || todo.status === "in_progress" : todo.status === "completed" || todo.status === "cancelled",
  )
}

/** Keeps the tasks carrying `@tag`; no tag is a no-op. */
export function filterByTag(todos: Array<Todo>, tag?: string): Array<Todo> {
  return tag ? todos.filter((todo) => tagsOf(todo.content).includes(tag)) : todos
}

/** Keeps the tasks with that priority; no priority is a no-op. */
export function filterByPriority(todos: Array<Todo>, priority?: TodoPriority): Array<Todo> {
  return priority ? todos.filter((todo) => todo.priority === priority) : todos
}

/** Sort cycles by key; the first state is the default priority-then-due order. */
const SORT_ORDER: Array<SortKey | undefined> = [undefined, "due", "priority", "created", "done", "id"]
export const SORT_LABEL: Record<string, string> = { ...STRINGS.sorts }
export function nextSort(current?: SortKey): SortKey | undefined {
  return SORT_ORDER[(SORT_ORDER.indexOf(current) + 1) % SORT_ORDER.length]
}

/** Orders by one column; open tasks come first, missing dates and ids go last. */
export function sortBy(todos: Array<Todo>, key: SortKey): Array<{ todo: Todo; index: number }> {
  return todos
    .map((todo, index) => ({ todo, index }))
    .sort((left, right) => {
      const a = left.todo
      const b = right.todo
      const state = Number(isClosed(a)) - Number(isClosed(b))
      if (state !== 0) return state
      switch (key) {
        case "id":
          return (a.id ?? 1e9) - (b.id ?? 1e9)
        case "due":
          return (a.due ?? FAR_DATE).localeCompare(b.due ?? FAR_DATE)
        case "priority":
          return byPriorityThenDue(a, b)
        case "created":
          return (a.created ?? FAR_DATE).localeCompare(b.created ?? FAR_DATE)
        case "done":
          return (a.done ?? FAR_DATE).localeCompare(b.done ?? FAR_DATE)
      }
    })
}

export type TodoCommand =
  | { action: "list" }
  | { action: "init" }
  | { action: "add"; text: string; priority?: TodoPriority; due?: string }
  | { action: "done"; id: number }
  | { action: "import" }
  | { action: "renumber" }
  | { action: "settings" }
  | { action: "help" }

/**
 * `/todo`, `/todo init`, `/todo import`, `/todo renumber`, `/todo add <text> [high|medium|low] [due=YYYY-MM-DD]`,
 * `/todo done <id>`, `/todo help`; anything else opens the list.
 */
export function parseTodoCommand(input: string): TodoCommand {
  const trimmed = input.trim()
  if (/^init$/i.test(trimmed)) return { action: "init" }
  if (/^import$/i.test(trimmed)) return { action: "import" }
  if (/^renumber$/i.test(trimmed)) return { action: "renumber" }
  if (/^settings$/i.test(trimmed)) return { action: "settings" }
  if (/^(help|-h|\?)$/i.test(trimmed)) return { action: "help" }
  const done = /^done\s+#?(\d+)$/i.exec(trimmed)
  if (done) return { action: "done", id: Number(done[1]) }
  const add = /^add\s+([\s\S]+)$/i.exec(trimmed)
  if (!add) return { action: "list" }
  const words = add[1].trim().split(/\s+/)
  let due: string | undefined
  const dueWord = words[words.length - 1]?.toLowerCase() ?? ""
  const dueMatch = /^due=(\d{4}-\d{2}-\d{2})$/.exec(dueWord)
  if (words.length > 1 && dueMatch) {
    due = dueMatch[1]
    words.pop()
  }
  const last = words[words.length - 1]?.toLowerCase()
  if (words.length > 1 && TODO_PRIORITIES.includes(last as TodoPriority)) {
    return { action: "add", text: words.slice(0, -1).join(" "), priority: last as TodoPriority, ...(due ? { due } : {}) }
  }
  return { action: "add", text: words.join(" "), ...(due ? { due } : {}) }
}

/** Local listeners, so mounted strips refresh at once instead of waiting for their 2s poll. */
const listeners = new Set<() => void>()

export function onTodosChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Every write goes through here: file first, then the strips. */
function commit(file: string, text: string): void {
  writeFileSync(file, text)
  for (const listener of listeners) listener()
}

/** Writes the whole list back, preserving every non-checkbox line. */
function save(loaded: { file: string; text: string }, todos: Array<Todo>): void {
  commit(loaded.file, applyChecklist(loaded.text, todos))
}

/** `/todo init`: creates TODO.md at the session root, so a new project has a file to fill. Never overwrites. */
export function initTodo(context: DialogContext, sessionID: string): boolean {
  const loaded = readFile(directoryOf(context, sessionID))
  if (!loaded) return false
  if (existsSync(loaded.file)) {
    context.ui.toast.show({ message: STRINGS.toasts.exists, variant: "info" })
    return false
  }
  commit(loaded.file, "# TODO\n\n## To do\n\n## Done\n")
  context.ui.toast.show({ message: STRINGS.toasts.created(loaded.file), variant: "success" })
  return true
}

/**
 * `/todo import`: adopts a hand-written list by turning its plain bullets into
 * checkboxes, once, after showing how many items it would touch.
 */
export async function importTodo(context: DialogContext, sessionID: string): Promise<boolean> {
  const loaded = readFile(directoryOf(context, sessionID))
  if (!loaded) return false
  const { text, converted } = importBullets(loaded.text)
  if (converted === 0) {
    context.ui.toast.show({ message: STRINGS.toasts.noneToImport, variant: "info" })
    return false
  }
  const ok = await context.ui.dialog.confirm({ title: STRINGS.prompts.import, message: STRINGS.prompts.importMessage(converted) })
  if (!ok) return false
  commit(loaded.file, text)
  context.ui.toast.show({ message: STRINGS.toasts.imported(converted), variant: "success" })
  return true
}

/** `/todo add <text> [priority] [due=YYYY-MM-DD]`: skip the dialogs. */
export function addTodo(
  context: DialogContext,
  sessionID: string,
  content: string,
  priority?: TodoPriority,
  due?: string,
): boolean {
  const text = content.trim()
  if (!text) return false
  const loaded = readFile(directoryOf(context, sessionID))
  if (!loaded) return false
  save(loaded, [...loaded.todos, { content: text, status: "pending", ...(priority ? { priority } : {}), ...(due ? { due } : {}) }])
  context.ui.toast.show({ message: STRINGS.toasts.added, variant: "success" })
  return true
}

/** `/todo done <id>`: closes a task by its stable id, without dialogs. */
export function completeTodo(context: DialogContext, sessionID: string, id: number): boolean {
  const loaded = readFile(directoryOf(context, sessionID))
  if (!loaded) return false
  const index = loaded.todos.findIndex((todo) => todo.id === id)
  if (index < 0) {
    context.ui.toast.show({ message: STRINGS.toasts.noTask(id), variant: "error" })
    return false
  }
  if (loaded.todos[index].status === "completed") {
    context.ui.toast.show({ message: STRINGS.toasts.alreadyCompleted(id), variant: "info" })
    return false
  }
  save(
    loaded,
    loaded.todos.map((todo, position) => (position === index ? { ...todo, status: "completed" as const } : todo)),
  )
  context.ui.toast.show({ message: STRINGS.toasts.completed(id), variant: "success" })
  return true
}

/** Resolves an option value back to the task: `#<id>` when it has one, `t<index>` for files written before ids. */
function loadSelected(context: DialogContext, sessionID: string, value: string) {
  const loaded = readFile(directoryOf(context, sessionID))
  if (!loaded) return
  const index = value.startsWith("#")
    ? loaded.todos.findIndex((todo) => todo.id === Number(value.slice(1)))
    : Number(value.slice(1))
  const selected = loaded.todos[index]
  if (!selected) return
  return { loaded, index, selected }
}

/** Edits text, priority and due date of one task together, keeping its status and creation date. */
export function updateTodo(
  context: DialogContext,
  sessionID: string,
  value: string,
  changes: { content: string; priority?: TodoPriority; due?: string },
): boolean {
  const found = loadSelected(context, sessionID, value)
  if (!found) return false
  const { loaded, index } = found
  const content = changes.content.trim()
  if (!content) return false
  const next = { ...found.selected, content }
  // Only the keys the caller sent are touched: a due-only change must not clear the priority.
  if ("priority" in changes) next.priority = changes.priority
  if ("due" in changes) next.due = changes.due
  save(
    loaded,
    loaded.todos.map((todo, position) => (position === index ? next : todo)),
  )
  context.ui.toast.show({ message: STRINGS.toasts.updated, variant: "success" })
  return true
}

/** Opens the plugin's edit dialog; the TUI supplies it, since only the TUI can render JSX. */
export type EditHandler = (value: string) => Promise<void>

/** Removes one task after a confirm; the line is dropped as-is, so other lines and metadata stay untouched. */
export async function deleteTodo(context: DialogContext, sessionID: string, value: string): Promise<boolean> {
  const found = loadSelected(context, sessionID, value)
  if (!found) return false
  const { loaded, index, selected } = found
  const ok = await context.ui.dialog.confirm({ title: STRINGS.prompts.delete, message: selected.content })
  if (!ok) return false
  commit(loaded.file, removeChecklistItem(loaded.text, index))
  context.ui.toast.show({ message: STRINGS.toasts.deleted, variant: "success" })
  return true
}

/** The exact line a delete removed, and where it was, for an undo. */
export type DeletedTodo = { line: string; index: number }

/** Puts back the line the last delete removed; the caller keeps the snapshot. */
export function restoreTodo(context: DialogContext, sessionID: string, deleted: DeletedTodo): boolean {
  const loaded = readFile(directoryOf(context, sessionID))
  if (!loaded) return false
  commit(loaded.file, insertChecklistItem(loaded.text, deleted.index, deleted.line))
  context.ui.toast.show({ message: STRINGS.toasts.restored, variant: "success" })
  return true
}

/** Removes one task without asking; the TUI uses it for the double ctrl+d shortcut. */
export function removeTodo(context: DialogContext, sessionID: string, value: string): boolean {
  const found = loadSelected(context, sessionID, value)
  if (!found) return false
  commit(found.loaded.file, removeChecklistItem(found.loaded.text, found.index))
  context.ui.toast.show({ message: STRINGS.toasts.deleted, variant: "success" })
  return true
}

const PRIORITY_OPTIONS: Array<SelectOption> = [
  { title: STRINGS.prompts.noPriority, value: "" },
  { title: "High", value: "high" },
  { title: "Medium", value: "medium" },
  { title: "Low", value: "low" },
]

const isClosed = (todo: Todo) => todo.status === "completed" || todo.status === "cancelled"

/** Open tasks first by priority and due date; completed and cancelled go to the bottom. */
export function renumberOrder(todos: Array<Todo>): Array<number> {
  return todos
    .map((todo, index) => ({ todo, index }))
    .sort((a, b) => {
      const state = Number(isClosed(a.todo)) - Number(isClosed(b.todo))
      if (state !== 0) return state
      return byPriorityThenDue(a.todo, b.todo) || a.index - b.index
    })
    .map((entry) => entry.index)
}

/** Rewrites every id as 1..N after a confirm: ids are stable by design, so this invalidates old references. */
export async function renumberTodo(context: DialogContext, sessionID: string): Promise<boolean> {
  const loaded = readFile(directoryOf(context, sessionID))
  if (!loaded || loaded.todos.length === 0) return false
  const ok = await context.ui.dialog.confirm({
    title: STRINGS.prompts.renumber,
    message: STRINGS.prompts.renumberMessage(loaded.todos.length),
  })
  if (!ok) return false
  commit(loaded.file, renumberChecklist(loaded.text, renumberOrder(loaded.todos)))
  context.ui.toast.show({ message: STRINGS.toasts.renumbered, variant: "success" })
  return true
}

/** Changes or clears the priority of one task, keeping the rest of its line. */
export async function changePriority(context: DialogContext, sessionID: string, value: string): Promise<void> {
  const found = loadSelected(context, sessionID, value)
  if (!found) return
  const { loaded, index, selected } = found
  const chosen = await context.ui.dialog.select({
    title: STRINGS.prompts.priority,
    current: selected.priority ?? "",
    options: PRIORITY_OPTIONS,
  })
  if (chosen === undefined) return
  const priority = (chosen || undefined) as TodoPriority | undefined
  if (priority === selected.priority) return
  save(loaded, loaded.todos.map((todo, position) => (position === index ? { ...todo, priority } : todo)))
  context.ui.toast.show({ message: STRINGS.toasts.priority, variant: "success" })
}

/** Prompts for an arbitrary ISO date; an empty answer clears it. */
export async function changeDue(context: DialogContext, sessionID: string, value: string): Promise<void> {
  const found = loadSelected(context, sessionID, value)
  if (!found) return
  const answer = await context.ui.dialog.prompt({
    title: STRINGS.prompts.due,
    placeholder: STRINGS.prompts.duePlaceholder,
    value: found.selected.due ?? "",
  })
  if (answer === undefined) return
  const due = answer.trim()
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    context.ui.toast.show({ message: STRINGS.prompts.invalidDue, variant: "error" })
    return
  }
  // Always send the key: an empty string means "remove the due date".
  updateTodo(context, sessionID, value, { content: found.selected.content, due: due || undefined })
}

/** One row per state filter: the host returns a whole row, so each label needs its own line. */
export function filterRows(current: TodoFilter = "all"): Array<SelectOption> {
  return FILTER_ORDER.map((value) => ({
    title: `${value === current ? "●" : "○"} ${FILTER_LABEL[value]}`,
    value: `filter:${value}`,
  }))
}

/** Same for priority: one row each, `●` marking the active one. */
export function priorityRows(current?: TodoPriority): Array<SelectOption> {
  const all: Array<TodoPriority | undefined> = [undefined, "high", "medium", "low"]
  return all.map((value) => ({
    title: `${value === current ? "●" : "○"} ${value ?? "tutte"}`,
    value: `prio:${value ?? ""}`,
  }))
}

/** Cycles pending -> in progress -> completed -> pending for one task, resolved by `#id` or `t<index>`. */
export function cycleTodo(context: DialogContext, sessionID: string, value: string): boolean {
  const found = loadSelected(context, sessionID, value)
  if (!found) return false
  const todos = found.loaded.todos.map((todo, position) => {
    if (position !== found.index) return todo
    const status = todo.status === "pending" ? "in_progress" : todo.status === "in_progress" ? "completed" : "pending"
    return { ...todo, status }
  })
  save(found.loaded, todos)
  context.ui.toast.show({ message: STRINGS.toasts.updated, variant: "success" })
  return true
}

/** Adds a task through the host prompt, then asks for the priority; the custom list stays open underneath. */
export async function newTodo(context: DialogContext, sessionID: string): Promise<boolean> {
  const content = await context.ui.dialog.prompt({ title: STRINGS.prompts.newTask, placeholder: STRINGS.prompts.newTaskPlaceholder })
  if (!content?.trim()) return false
  const priority = await context.ui.dialog.select({ title: STRINGS.prompts.priority, options: PRIORITY_OPTIONS })
  const loaded = readFile(directoryOf(context, sessionID))
  if (!loaded) return false
  const todo: Todo = { content: content.trim(), status: "pending" }
  if (priority) todo.priority = priority as TodoPriority
  save(loaded, [...loaded.todos, todo])
  context.ui.toast.show({ message: STRINGS.toasts.added, variant: "success" })
  return true
}
