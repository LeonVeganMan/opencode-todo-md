import { existsSync, readFileSync, writeFileSync } from "node:fs"
import {
  TODO_PRIORITIES,
  TODO_STATUSES,
  applyChecklist,
  patchTodos,
  readTodos,
  type Todo,
  type TodoPatch,
  type TodoPriority,
  type TodoStatus,
} from "./checklist.ts"

const MAX_TODOS = 100
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

type Entry = {
  id?: number
  content?: string
  status?: TodoStatus
  priority?: TodoPriority
  due?: string
}

function entries(input: unknown): Array<Entry> {
  if (input === null || typeof input !== "object" || !("todos" in input)) {
    throw new Error("todo_write requires a `todos` array")
  }
  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos)) throw new Error("`todos` must be an array")
  if (todos.length > MAX_TODOS) throw new Error(`at most ${MAX_TODOS} todos (got ${todos.length})`)
  return todos.map((entry, index) => {
    if (entry === null || typeof entry !== "object") throw new Error(`todo #${index + 1} must be an object`)
    const item = entry as { id?: unknown; content?: unknown; status?: unknown; priority?: unknown; due?: unknown }
    const result: Entry = {}
    if (item.id !== undefined) {
      if (typeof item.id !== "number" || !Number.isInteger(item.id) || item.id < 1) {
        throw new Error(`todo #${index + 1} has invalid \`id\` (expected a positive integer read from todo_read)`)
      }
      result.id = item.id
    }
    if (item.content !== undefined) {
      if (typeof item.content !== "string" || !item.content.trim()) {
        throw new Error(`todo #${index + 1} has invalid \`content\` (expected a non-empty string)`)
      }
      result.content = item.content.trim()
    }
    if (item.status !== undefined) {
      if (!TODO_STATUSES.includes(item.status as TodoStatus)) {
        throw new Error(`todo #${index + 1} has invalid \`status\` (expected: ${TODO_STATUSES.join(", ")})`)
      }
      result.status = item.status as TodoStatus
    }
    if (item.priority !== undefined) {
      if (!TODO_PRIORITIES.includes(item.priority as TodoPriority)) {
        throw new Error(`todo #${index + 1} has invalid \`priority\` (expected: ${TODO_PRIORITIES.join(", ")})`)
      }
      result.priority = item.priority as TodoPriority
    }
    if (item.due !== undefined) {
      if (typeof item.due !== "string" || !ISO_DATE.test(item.due)) {
        throw new Error(`todo #${index + 1} has invalid \`due\` (expected YYYY-MM-DD)`)
      }
      result.due = item.due
    }
    if (result.id === undefined && result.content === undefined) {
      throw new Error(`todo #${index + 1} requires \`content\` (or \`id\` to patch an existing task)`)
    }
    return result
  })
}

export type Write =
  | { mode: "replace"; todos: Array<Todo> }
  | { mode: "patch"; patches: Array<TodoPatch> }
  | { mode: "merge"; patches: Array<TodoPatch>; added: Array<Todo> }

const toPatch = (entry: Entry): TodoPatch => ({
  id: entry.id as number,
  ...(entry.content !== undefined ? { content: entry.content } : {}),
  ...(entry.status !== undefined ? { status: entry.status } : {}),
  ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
  ...(entry.due !== undefined ? { due: entry.due } : {}),
})

/**
 * Only an explicit `mode: "replace"` may drop tasks. Everything else merges: an
 * item with `id` updates that task, an item without `id` is appended. This is
 * deliberate - a one-item write once wiped a whole project list.
 */
export function normalize(input: unknown): Write {
  const requested = (input as { mode?: unknown }).mode
  if (requested !== undefined && requested !== "replace") throw new Error('`mode` accepts only "replace"')
  const list = entries(input)
  if (requested === "replace") {
    return {
      mode: "replace",
      todos: list.map((entry, index) => {
        if (entry.content === undefined) throw new Error(`todo #${index + 1} requires a non-empty \`content\` string`)
        if (entry.status === undefined) throw new Error(`todo #${index + 1} requires a \`status\``)
        const todo: Todo = { content: entry.content, status: entry.status }
        if (entry.id !== undefined) todo.id = entry.id
        if (entry.priority !== undefined) todo.priority = entry.priority
        if (entry.due !== undefined) todo.due = entry.due
        return todo
      }),
    }
  }
  if (list.length > 0 && list.every((entry) => entry.id !== undefined && entry.content === undefined)) {
    return { mode: "patch", patches: list.map(toPatch) }
  }
  const patched = list.filter((entry) => entry.id !== undefined) as Array<Entry & { id: number }>
  const added = list.filter((entry) => entry.id === undefined)
  return {
    mode: "merge",
    patches: patched.map(toPatch),
    added: added.map((entry) => {
      const todo: Todo = { content: entry.content as string, status: entry.status ?? "pending" }
      if (entry.priority !== undefined) todo.priority = entry.priority
      if (entry.due !== undefined) todo.due = entry.due
      return todo
    }),
  }
}

/** Applies a write to the current list. Extracted so tests can pin the merge/patch/replace rules. */
export function nextTodos(current: Array<Todo>, write: Write): Array<Todo> {
  if (write.mode === "replace") return write.todos
  const patched = patchTodos(current, write.patches)
  return write.mode === "patch" ? patched : [...patched, ...write.added]
}

/** Reads TODO.md, applies one write and returns the list actually stored. */
export function writeTodos(file: string, input: unknown): Array<Todo> {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "# TODO\n"
  const next = applyChecklist(text, nextTodos(readTodos(text), normalize(input)))
  writeFileSync(file, next)
  return readTodos(next)
}
