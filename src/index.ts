import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { TODO_PRIORITIES, TODO_STATUSES, isOverdue, readTodos, type Todo } from "./checklist.ts"
import { writeTodos } from "./write.ts"

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
    mode: {
      type: "string",
      enum: ["replace"],
      description: "Only to delete tasks: the list replaces the whole file; an empty list clears it. Omit it to add and update without deleting anything.",
    },
    todos: {
      type: "array",
      description:
        "Items to add (no `id`) or update (with `id`). Nothing is deleted unless `mode: 'replace'` is set.",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", minimum: 1, description: "Stable id printed by todo_read. Required to patch an existing task." },
          content: { type: "string", description: "Imperative description of the task. Omit when patching by id." },
          status: { type: "string", enum: [...TODO_STATUSES], description: "Current state of the task. Optional: a new task defaults to pending." },
          priority: { type: "string", enum: [...TODO_PRIORITIES], description: "Optional priority of the task." },
          due: { type: "string", description: "Optional due date, ISO YYYY-MM-DD." },
        },
        anyOf: [{ required: ["content"] }, { required: ["id"] }],
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
          "Add or update the project todo list stored in TODO.md at the project root.",
          "The file is shared by every session of this project, so it is the project plan, not a private scratchpad.",
          "Merging is the default and never deletes: an item with an `id` updates that task, an item without `id` is appended.",
          "Deleting tasks requires `mode: 'replace'` with the complete list, or an empty list to clear the file; without it, omitted tasks stay in the file.",
          "Ids are stable and never reused; read them with todo_read before patching.",
          "Priority, due date and creation date are stored as an invisible HTML comment on the same line; omit them to keep the previous values.",
          "Keep exactly one task in_progress while working, mark tasks completed as soon as they are done, and cancel tasks that are no longer needed.",
        ].join(" "),
        input: INPUT_SCHEMA,
        options: { codemode: true },
        execute: async (input, context) => {
          const file = await todoFile(ctx, context.sessionID)
          const stored = writeTodos(file, input)
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
