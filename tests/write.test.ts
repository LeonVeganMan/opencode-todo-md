import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nextTodos, normalize, writeTodos } from "../src/write.ts"
import type { Todo } from "../src/checklist.ts"

const current: Array<Todo> = [
  { content: "uno", status: "pending", id: 1, priority: "high" },
  { content: "due", status: "in_progress", id: 2 },
]

describe("todo_write modes", () => {
  // The regression that wiped a project list: one new item must never drop the others.
  test("a plain write merges: new item is appended, existing tasks stay", () => {
    const write = normalize({ todos: [{ content: "tre", status: "pending" }] })
    expect(write.mode).toBe("merge")
    expect(nextTodos(current, write).map((todo) => todo.content)).toEqual(["uno", "due", "tre"])
  })

  test("an id-only write patches and keeps everything else", () => {
    const write = normalize({ todos: [{ id: 2, status: "completed" }] })
    expect(write.mode).toBe("patch")
    const next = nextTodos(current, write)
    expect(next.map((todo) => todo.status)).toEqual(["pending", "completed"])
    expect(next[0]).toEqual(current[0])
  })

  test("a mixed write updates by id and appends the rest", () => {
    const write = normalize({ todos: [{ id: 1, priority: "low" }, { content: "tre" }] })
    expect(write.mode).toBe("merge")
    const next = nextTodos(current, write)
    expect(next.map((todo) => todo.content)).toEqual(["uno", "due", "tre"])
    expect(next[0].priority).toBe("low")
    expect(next[2].status).toBe("pending")
  })

  test("only mode: replace drops the tasks that are missing", () => {
    const write = normalize({ mode: "replace", todos: [{ content: "solo", status: "pending" }] })
    expect(write.mode).toBe("replace")
    expect(nextTodos(current, write).map((todo) => todo.content)).toEqual(["solo"])
  })

  // A model sent replace without status and the whole write was rejected; merge already defaulted.
  test("replace without a status defaults to pending", () => {
    const write = normalize({ mode: "replace", todos: [{ content: "solo" }] })
    expect(write.mode).toBe("replace")
    if (write.mode !== "replace") return
    expect(write.todos[0]).toEqual({ content: "solo", status: "pending" })
  })

  test("an unknown mode is rejected instead of guessed", () => {
    expect(() => normalize({ mode: "delete", todos: [] })).toThrow('`mode` accepts only "replace"')
  })
})

describe("writeTodos end to end", () => {
  test("adding one task keeps the tasks already in TODO.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-"))
    const file = join(dir, "TODO.md")
    writeFileSync(file, "# TODO\n\n- [ ] uno <!-- id=1 -->\n- [ ] due <!-- id=2 -->\n")
    const stored = writeTodos(file, { todos: [{ content: "nuovo" }] })
    expect(stored.map((todo) => todo.content)).toEqual(["uno", "due", "nuovo"])
    const text = readFileSync(file, "utf8")
    expect(text).toContain("- [ ] uno")
    expect(text).toContain("- [ ] due")
    expect(text).toContain("- [ ] nuovo")
    rmSync(dir, { recursive: true, force: true })
  })

  test("id 0 appends like a missing id", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-"))
    const file = join(dir, "TODO.md")
    writeFileSync(file, "# TODO\n\n- [ ] uno <!-- id=1 -->\n")
    const stored = writeTodos(file, { todos: [{ id: 0, content: "nuovo" }] })
    expect(stored.map((todo) => todo.content)).toEqual(["uno", "nuovo"])
    const text = readFileSync(file, "utf8")
    expect(text).toContain("- [ ] nuovo")
    expect(text).toContain("id=2")
    rmSync(dir, { recursive: true, force: true })
  })

  test("replace with an empty list clears the tasks but keeps the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-"))
    const file = join(dir, "TODO.md")
    writeFileSync(file, "# TODO\n\nNota.\n\n- [ ] uno <!-- id=1 -->\n- [x] due <!-- id=2 -->\n")
    const stored = writeTodos(file, { mode: "replace", todos: [] })
    expect(stored).toEqual([])
    const text = readFileSync(file, "utf8")
    expect(text).toBe("# TODO\n\nNota.\n\n")
    rmSync(dir, { recursive: true, force: true })
  })
})
