import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import { TODO_PRIORITIES, TODO_STATUSES, isOverdue, readTodos, type Todo } from "./checklist.ts"
import {
  appendNote,
  deleteNote,
  isNoteDue,
  notesFile,
  parseNotes,
  parseRemind,
  readNotes,
  saveNotes,
  updateNote,
  type Note,
} from "./notes.ts"
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

function renderNotes(notes: Array<Note>): string {
  if (notes.length === 0) return "(no notes)"
  return notes
    .map((note) => {
      const detail = [
        note.created ? `created ${note.created}` : "",
        note.remind ? (isNoteDue(note) ? `reminder ${note.remind} (due)` : `reminder ${note.remind}`) : "",
      ]
        .filter(Boolean)
        .join(", ")
      return `#${note.id} ${note.content}${detail ? ` — ${detail}` : ""}`
    })
    .join("\n")
}

/** TODO.md and opencode-notes.md live in the session's project directory, never in the process cwd. */
async function projectDirectory(ctx: Plugin.Context, sessionID: string): Promise<string> {
  const info = (await ctx.session.get({ sessionID })) as { directory?: string } | undefined
  return info?.directory || ctx.location.directory
}

async function todoFile(ctx: Plugin.Context, sessionID: string): Promise<string> {
  return join(await projectDirectory(ctx, sessionID), "TODO.md")
}

const NOTE_ADD_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", description: "Note text; @tags are allowed." },
    remind: {
      type: "string",
      description: "Optional reminder: relative 15m, 2h, 1d, or local YYYY-MM-DDTHH:MM.",
    },
  },
  required: ["content"],
  additionalProperties: false,
} as const

const NOTE_WRITE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: 1, description: "Id of the note to update, from note_read." },
    content: { type: "string", description: "New text; omit to keep the current text." },
    remind: {
      type: "string",
      description: "Optional reminder: relative 15m, 2h, 1d, or local YYYY-MM-DDTHH:MM. An empty string clears it.",
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const

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
          id: { type: "integer", minimum: 0, description: "Stable id printed by todo_read. Omit (or pass 0) to append a new task. Required to patch an existing task." },
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

      editor.add({
        name: "note_read",
        description:
          "Read the project notes from opencode-notes.md: id, text, tags, creation date and optional reminder. Use it to recall ideas and reminders from earlier sessions.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: true },
        execute: async (_input, context) => {
          const directory = await projectDirectory(ctx, context.sessionID)
          const { notes } = readNotes(directory)
          return { content: `Project notes (opencode-notes.md):\n${renderNotes(notes)}` }
        },
      })

      editor.add({
        name: "note_add",
        description: [
          "Add one note to opencode-notes.md at the project root, with an optional reminder.",
          "Use note_write to change an existing note: this tool always appends and never touches the others.",
          "`remind` accepts a relative 15m, 2h, 1d or a local YYYY-MM-DDTHH:MM.",
          "Notes are plain markdown lines shared by every session of the project, so keep them short and self-contained.",
        ].join(" "),
        input: NOTE_ADD_SCHEMA,
        options: { codemode: true },
        execute: async (input, context) => {
          const directory = await projectDirectory(ctx, context.sessionID)
          const file = notesFile(directory)
          const { text } = readNotes(directory)
          const parsed = input.remind === undefined ? { ok: true as const, remind: undefined } : parseRemind(input.remind)
          if (!parsed.ok) {
            return { content: `Invalid reminder "${input.remind}": use 15m, 2h, 1d or YYYY-MM-DDTHH:MM.` }
          }
          if (!input.content?.trim()) return { content: "A note needs content." }
          const added = appendNote(text, input.content, { remind: parsed.remind })
          saveNotes(file, added.text)
          return { content: `Added note #${added.note.id}:\n${renderNotes(parseNotes(added.text).notes)}` }
        },
      })

      editor.add({
        name: "note_write",
        description: [
          "Update an existing note in opencode-notes.md at the project root.",
          "Pass the `id` printed by note_read; use note_add to create a new note.",
          "`content` replaces the text (omit it to keep the current text); `remind` accepts a relative 15m, 2h, 1d or a local YYYY-MM-DDTHH:MM, and an empty string clears it.",
          "Notes are plain markdown lines shared by every session of the project.",
        ].join(" "),
        input: NOTE_WRITE_SCHEMA,
        options: { codemode: true },
        execute: async (input, context) => {
          const directory = await projectDirectory(ctx, context.sessionID)
          const file = notesFile(directory)
          const { text } = readNotes(directory)
          const parsed = input.remind === undefined ? { ok: true as const, remind: undefined } : parseRemind(input.remind)
          if (!parsed.ok) {
            return { content: `Invalid reminder "${input.remind}": use 15m, 2h, 1d or YYYY-MM-DDTHH:MM.` }
          }
          const updated = updateNote(text, input.id, {
            content: input.content,
            remind: input.remind === "" ? null : parsed.remind,
          })
          if (!updated.note) return { content: `No note with id ${input.id}.` }
          saveNotes(file, updated.text)
          return { content: `Updated note #${updated.note.id}:\n${renderNotes(parseNotes(updated.text).notes)}` }
        },
      })

      editor.add({
        name: "note_delete",
        description: "Delete one project note from opencode-notes.md by id. Use note_read first to find the id.",
        input: {
          type: "object",
          properties: { id: { type: "integer", minimum: 1, description: "Id of the note to delete." } },
          required: ["id"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input, context) => {
          const directory = await projectDirectory(ctx, context.sessionID)
          const file = notesFile(directory)
          const { text } = readNotes(directory)
          const removed = deleteNote(text, input.id)
          if (!removed.note) return { content: `No note with id ${input.id}.` }
          saveNotes(file, removed.text)
          return { content: `Deleted note #${removed.note.id}:\n${renderNotes(parseNotes(removed.text).notes)}` }
        },
      })
    })

    return async () => {
      await tools.dispose()
    }
  },
})
