export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"
export type TodoPriority = "high" | "medium" | "low"
export type Todo = {
  content: string
  status: TodoStatus
  /** Stable id, assigned once and never reused: it is what `/todo done <id>` and the agent refer to. */
  id?: number
  priority?: TodoPriority
  /** ISO date (YYYY-MM-DD) of the first time this item appeared in TODO.md. */
  created?: string
  /** ISO date (YYYY-MM-DD) the task is due; overdue tasks are flagged in the strip and list. */
  due?: string
  /** Completion date, set automatically when the task is marked completed and dropped when reopened. */
  done?: string
}

export const TODO_STATUSES: ReadonlyArray<TodoStatus> = ["pending", "in_progress", "completed", "cancelled"]
export const TODO_PRIORITIES: ReadonlyArray<TodoPriority> = ["high", "medium", "low"]

/** Checkbox glyphs used inside TODO.md. Only keys/values matter, not GFM compliance. */
export const MARK: Record<TodoStatus, string> = { pending: " ", in_progress: "•", completed: "x", cancelled: "-" }
const STATUS: Record<string, TodoStatus> = {
  " ": "pending",
  "•": "in_progress",
  "~": "in_progress",
  "x": "completed",
  "X": "completed",
  "-": "cancelled",
}

/** `- [ ] text`, keeping the original indent and bullet so untouched lines stay byte-identical. */
const CHECKBOX = /^(\s*[-*+]\s+)\[([ xX•~-])\]\s+(.+?)\s*$/
/** Trailing metadata, invisible when the markdown is rendered: `<!-- priority=high created=2026-10-30 -->`. */
const META = /\s*<!--\s*([^>]*?)\s*-->\s*$/

export type ChecklistItem = { index: number; prefix: string; todo: Todo }

export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function parseMeta(raw: string): Pick<Todo, "id" | "priority" | "created" | "due" | "done"> {
  const meta: Pick<Todo, "id" | "priority" | "created" | "due" | "done"> = {}
  for (const part of raw.split(/\s+/)) {
    const [key, value] = part.split("=")
    if (key === "id" && /^\d+$/.test(value)) meta.id = Number(value)
    if (key === "priority" && TODO_PRIORITIES.includes(value as TodoPriority)) meta.priority = value as TodoPriority
    if (key === "created" && ISO_DATE.test(value)) meta.created = value
    if (key === "due" && ISO_DATE.test(value)) meta.due = value
    if (key === "done" && ISO_DATE.test(value)) meta.done = value
  }
  return meta
}

function renderMeta(todo: Todo): string {
  const parts: Array<string> = []
  if (todo.id !== undefined) parts.push(`id=${todo.id}`)
  if (todo.priority) parts.push(`priority=${todo.priority}`)
  if (todo.due) parts.push(`due=${todo.due}`)
  if (todo.done) parts.push(`done=${todo.done}`)
  if (todo.created) parts.push(`created=${todo.created}`)
  return parts.length === 0 ? "" : ` <!-- ${parts.join(" ")} -->`
}

export function parseChecklist(text: string): { items: Array<ChecklistItem>; lines: Array<string> } {
  const lines = text.split("\n")
  const items: Array<ChecklistItem> = []
  lines.forEach((line, index) => {
    const match = CHECKBOX.exec(line)
    if (!match) return
    let content = match[3]
    const meta = META.exec(content)
    if (meta) content = content.slice(0, meta.index).trimEnd()
    items.push({
      index,
      prefix: match[1],
      todo: { content, status: STATUS[match[2]] ?? "pending", ...(meta ? parseMeta(meta[1]) : {}) },
    })
  })
  return { items, lines }
}

export function readTodos(text: string): Array<Todo> {
  return parseChecklist(text).items.map((item) => item.todo)
}

export function renderItem(todo: Todo): string {
  return `- [${MARK[todo.status]}] ${todo.content}${renderMeta(todo)}`
}

/**
 * Turns plain markdown bullets and numbered items into checkboxes, so a hand-written
 * TODO.md can be adopted once. Checkboxes and fenced code blocks are left alone.
 */
export function importBullets(text: string): { text: string; converted: number } {
  const lines = text.split("\n")
  const out: Array<string> = []
  let fence = false
  let converted = 0
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      out.push(line)
      continue
    }
    if (fence || CHECKBOX.test(line)) {
      out.push(line)
      continue
    }
    const match = /^(\s*)(?:[-*+]|\d+\.)\s+(.+?)\s*$/.exec(line)
    if (!match) {
      out.push(line)
      continue
    }
    converted++
    out.push(`${match[1]}- [ ] ${match[2]}`)
  }
  return { text: out.join("\n"), converted }
}

/** Drops exactly one checkbox line, leaving every other line byte-identical. */
export function removeChecklistItem(text: string, index: number): string {
  const { items, lines } = parseChecklist(text)
  const item = items[index]
  if (!item) return text
  return lines.filter((_, position) => position !== item.index).join("\n")
}

/** Puts a line back where it was, so an undo does not touch the rest of the file. */
export function insertChecklistItem(text: string, index: number, line: string): string {
  const lines = text.split("\n")
  lines.splice(Math.max(0, Math.min(index, lines.length)), 0, line)
  return lines.join("\n")
}

/**
 * Rewrites ids as 1..N following `order` (indices into the parsed items).
 * Written directly instead of going through applyChecklist: reusing existing
 * ids would make that function hand a task the metadata of another one.
 */
export function renumberChecklist(text: string, order: Array<number>): string {
  const { items, lines } = parseChecklist(text)
  const out = [...lines]
  order.forEach((itemIndex, position) => {
    const item = items[itemIndex]
    if (!item) return
    const todo = { ...item.todo, id: position + 1 }
    out[item.index] = `${item.prefix}[${MARK[todo.status]}] ${todo.content}${renderMeta(todo)}`
  })
  return out.join("\n")
}

/** True when the task is still open and its due date is before today. */
export function isOverdue(todo: Todo): boolean {
  if (!todo.due) return false
  if (todo.status === "completed" || todo.status === "cancelled") return false
  return todo.due < today()
}

/** True when the task is open, not late yet and due within the next `days` days (today included). */
export function isDueSoon(todo: Todo, days = 2): boolean {
  if (!todo.due || todo.status === "completed" || todo.status === "cancelled") return false
  if (isOverdue(todo)) return false
  const limit = new Date()
  limit.setUTCDate(limit.getUTCDate() + days)
  return todo.due <= limit.toISOString().slice(0, 10)
}

/**
 * Rewrites the checkboxes that already exist, in place, and only adds or drops
 * lines at the end of the parsed sequence. Headings, notes and any non-checkbox
 * line are never touched. Priority, due date, id and creation date survive a
 * write that does not repeat them.
 *
 * Ids are stable: reused from the same task found by id or by content (so a
 * reordered list keeps them), otherwise a fresh number is handed out.
 */
export function applyChecklist(text: string, todos: Array<Todo>): string {
  const { items, lines } = parseChecklist(text)
  const out = [...lines]

  const byId = new Map<number, Todo>()
  const byContent = new Map<string, Todo>()
  const duplicatedContent = new Set<string>()
  let nextId = 1
  for (const { todo } of items) {
    if (todo.id !== undefined) {
      byId.set(todo.id, todo)
      nextId = Math.max(nextId, todo.id + 1)
    }
    const key = todo.content.toLowerCase()
    if (byContent.has(key)) duplicatedContent.add(key)
    byContent.set(key, todo)
  }
  // Ambiguous text cannot identify a task: only unique contents carry metadata over a reorder.
  for (const key of duplicatedContent) byContent.delete(key)

  const used = new Set<number>()
  const withMetadata = (todo: Todo, position: number): Todo => {
    const previous = (todo.id !== undefined ? byId.get(todo.id) : undefined) ?? byContent.get(todo.content.toLowerCase()) ?? items[position]?.todo
    // An explicit `priority: undefined` clears it; an absent key keeps the old one. Same for `due`.
    const hasPriority = Object.prototype.hasOwnProperty.call(todo, "priority")
    const hasDue = Object.prototype.hasOwnProperty.call(todo, "due")
    let id = todo.id ?? previous?.id
    if (id === undefined || used.has(id)) id = nextId++
    used.add(id)
    // The completion date follows the status: stamped on completion, dropped when the task is reopened or cancelled.
    const done = todo.status === "completed" ? (previous?.done ?? today()) : undefined
    return {
      content: todo.content,
      status: todo.status,
      id,
      priority: hasPriority ? todo.priority : previous?.priority,
      due: hasDue ? todo.due : previous?.due,
      done,
      created: todo.created ?? previous?.created ?? today(),
    }
  }

  const shared = Math.min(items.length, todos.length)
  for (let index = 0; index < shared; index++) {
    const next = withMetadata(todos[index], index)
    out[items[index].index] = `${items[index].prefix}[${MARK[next.status]}] ${next.content}${renderMeta(next)}`
  }
  if (todos.length > items.length) {
    const anchor = items.length > 0 ? items[items.length - 1].index : out.length - 1
    const extra = todos.slice(items.length).map((todo, offset) => renderItem(withMetadata(todo, items.length + offset)))
    out.splice(anchor + 1, 0, ...extra)
  } else if (todos.length < items.length) {
    const drop = new Set(items.slice(todos.length).map((item) => item.index))
    return out.filter((_, index) => !drop.has(index)).join("\n")
  }
  return out.join("\n")
}

/** Fields a patch may change; `undefined` means "leave it as it is". */
export type TodoPatch = { id: number; content?: string; status?: TodoStatus; priority?: TodoPriority; due?: string }

/** Updates tasks by id, without resending the whole list. Unknown ids are an error, not a silent skip. */
export function patchTodos(todos: Array<Todo>, patches: Array<TodoPatch>): Array<Todo> {
  const out = todos.map((todo) => ({ ...todo }))
  for (const patch of patches) {
    const index = out.findIndex((todo) => todo.id === patch.id)
    if (index < 0) throw new Error(`no todo with id ${patch.id}`)
    const next = { ...out[index] }
    if (patch.content !== undefined) next.content = patch.content
    if (patch.status !== undefined) next.status = patch.status
    if (patch.priority !== undefined) next.priority = patch.priority
    if (patch.due !== undefined) next.due = patch.due
    out[index] = next
  }
  return out
}
