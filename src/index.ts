import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  TODO_PRIORITIES,
  TODO_STATUSES,
  applyChecklist,
  isOverdue,
  readTodos,
  patchTodos,
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

/**
 * Two shapes share this tool: a full list (each item has content + status, the
 * previous list is replaced) or a patch list (every item has an id and no
 * content, so only those tasks change). Mixing the two is rejected early.
 */
function normalize(input: unknown): { patches: Array<TodoPatch> } | { todos: Array<Todo> } {
  const list = entries(input)
  if (list.length > 0 && list.every((entry) => entry.id !== undefined && entry.content === undefined)) {
    return {
      patches: list.map((entry) => ({
        id: entry.id as number,
        ...(entry.status ? { status: entry.status } : {}),
        ...(entry.priority ? { priority: entry.priority } : {}),
        ...(entry.due ? { due: entry.due } : {}),
      })),
    }
  }
  return {
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

function render(todos: Array<Todo>): string {
  if (todos.length === 0) return "(the todo list is empty)"
  return todos
    .map((todo) => {
      const mark = todo.status === "in_progress" ? "•" : todo.status === "completed" ? "x" : todo.status === "cancelled" ? "-" : " "
      const detail = [
        todo.priority ? `${todo.priority} priority` : "",
        todo.due ? (isOverdue(todo) ? `overdue ${todo.due}` : `due ${todo.due}`) : "",
        todo.done ? `done ${todo.done}` : "",
        todo.created ? `created ${todo.created}` : "",
      ]
        .filter(Boolean)
        .join(", ")
      const label = todo.id !== undefined ? `#${todo.id} ` : ""
      return `${label}[${mark}] ${todo.content}${detail ? ` — ${detail}` : ""}`
    })
    .join("\n")
}

/** TODO.md lives in the session's project directory, never in the process cwd. */
async function todoFile(ctx: Plugin.Context, sessionID: string): Promise<string> {
  const info = (await ctx.session.get({ sessionID })) as { directory?: string } | undefined
  return join(info?.directory || ctx.location.directory, "TODO.md")
}

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description:
        "The complete todo list (replaces the previous one), or a patch list where every item has only an `id` plus the fields to change.",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1, description: "Stable id printed by todo_read. Required to patch an existing task." },
          content: { type: "string", description: "Imperative description of the task. Omit when patching by id." },
          status: { type: "string", enum: [...TODO_STATUSES], description: "Current state of the task." },
          priority: { type: "string", enum: [...TODO_PRIORITIES], description: "Optional priority of the task." },
          due: { type: "string", description: "Optional due date, ISO YYYY-MM-DD." },
        },
        anyOf: [{ required: ["content", "status"] }, { required: ["id"] }],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
} as const

export default Plugin.define({
  id: "opencode-todo-md",
  async setup(ctx) {
    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: "todo_write",
        description: [
          "Create or replace the project todo list stored in TODO.md at the project root.",
          "The file is shared by every session of this project, so it is the project plan, not a private scratchpad.",
          "Full mode: pass the complete list every time; existing checkboxes are updated in place and no other line of the file is touched.",
          "Patch mode: pass only items with an `id` plus the fields to change, e.g. [{ id: 3, status: 'completed' }]; the rest of the list is untouched.",
          "Ids are stable and never reused; read them with todo_read before patching.",
          "Priority, due date and creation date are stored as an invisible HTML comment on the same line; omit them to keep the previous values.",
          "Keep exactly one task in_progress while working, mark tasks completed as soon as they are done, and cancel tasks that are no longer needed.",
        ].join(" "),
        input: INPUT_SCHEMA,
        options: { codemode: true },
        execute: async (input, context) => {
          const parsed = normalize(input)
          const file = await todoFile(ctx, context.sessionID)
          const text = existsSync(file) ? readFileSync(file, "utf8") : "# TODO\n"
          const next = "patches" in parsed
            ? applyChecklist(text, patchTodos(readTodos(text), parsed.patches))
            : applyChecklist(text, parsed.todos)
          writeFileSync(file, next)
          // The list actually stored, not the input: patch mode sends only a few items.
          const stored = readTodos(next)
          return { content: `TODO.md updated (${stored.length} ${stored.length === 1 ? "item" : "items"}):\n${render(stored)}` }
        },
      })

      editor.add({
        name: "todo_read",
        description:
          "Read the project todo list from TODO.md, with id, priority, due date and creation date. Use it after compaction or before starting the next task.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async (_input, context) => {
          const file = await todoFile(ctx, context.sessionID)
          const todos = existsSync(file) ? readTodos(readFileSync(file, "utf8")) : []
          return { content: `Project todo list (TODO.md):\n${render(todos)}` }
        },
      })
    })

    return async () => {
      await tools.dispose()
    }
  },
})
