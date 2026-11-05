import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyChecklist, importBullets, insertChecklistItem, isDueSoon, isOverdue, parseChecklist, patchTodos, readTodos, removeChecklistItem, renumberChecklist, today } from "../src/checklist.ts"
import { MARKERS, STRINGS } from "../src/strings.ts"
import { SHORTCUTS } from "../src/shortcuts.ts"
import { pageSize } from "../src/page.ts"
import { DEFAULT_SETTINGS, loadSettings, mergeSettings, projectSettingsFile, saveSettings } from "../src/settings.ts"
import { TABLE_HEADER, addTodo, changeDue, completeTodo, cycleTodo, filterByPriority, filterByTag, filterOptions, filterRows, importTodo, initTodo, matchesQuery, nextFilter, nextSort, onTodosChanged, parseTodoCommand, priorityRows, removeTodo, sortBy, summaryTitle, tableHeader, tableRow, descriptionOf, tagWidthOf, tagsOf, todosFor, updateTodo } from "../src/command.ts"

const NOTE = "# TODO\n\nNota da preservare.\n\n- [ ] uno\n- [ ] due\n"

describe("checklist", () => {
  test("updates in place, appends and drops only checkboxes", () => {
    const grown = applyChecklist(NOTE, [
      { content: "uno", status: "completed" },
      { content: "due", status: "in_progress" },
      { content: "tre", status: "pending" },
    ])
    expect(grown).toContain("Nota da preservare.")
    expect(grown).toContain(`- [x] uno <!-- id=1 done=${today()} created=${today()} -->`)
    expect(grown).toContain(`- [•] due <!-- id=2 created=${today()} -->`)
    expect(grown.trimEnd().endsWith(`- [ ] tre <!-- id=3 created=${today()} -->`)).toBe(true)

    const shrunk = applyChecklist(grown, [{ content: "uno", status: "pending" }])
    expect(shrunk).toContain("Nota da preservare.")
    expect(shrunk).not.toContain("tre")
    expect(shrunk).not.toContain("due")
  })

  test("priority and created survive a write that omits them", () => {
    const first = applyChecklist(NOTE, [{ content: "uno", status: "pending", priority: "high" }])
    const second = applyChecklist(first, [{ content: "uno", status: "completed" }])
    expect(second).toContain("- [x] uno <!-- id=1 priority=high")
    expect(parseChecklist(second).items[0].todo.priority).toBe("high")
    expect(parseChecklist(second).items[0].todo.created).toBe(today())
  })

  test("editing the text keeps status, priority and created date", () => {
    const first = applyChecklist(NOTE, [{ content: "uno", status: "in_progress", priority: "high" }])
    const edited = applyChecklist(first, [{ content: "uno, ma meglio", status: "in_progress", priority: "high" }])
    expect(edited).toContain(`- [•] uno, ma meglio <!-- id=1 priority=high created=${today()} -->`)
  })

  test("removing a task drops only its line, metadata of the others stays", () => {
    const original = "# TODO\n\n- [ ] uno <!-- priority=high created=2026-10-01 -->\n- [ ] due <!-- created=2026-10-02 -->\n- [ ] tre <!-- created=2026-10-03 -->\n"
    const left = removeChecklistItem(original, 1)
    expect(left).toContain("- [ ] uno <!-- priority=high created=2026-10-01 -->")
    expect(left).toContain("- [ ] tre <!-- created=2026-10-03 -->")
    expect(left).not.toContain("due")
    expect(parseChecklist(left).items.map((item) => item.todo.content)).toEqual(["uno", "tre"])
  })

  test("an undo puts the removed line back in its place, byte for byte", () => {
    const original = "# TODO\n\n- [ ] uno <!-- priority=high created=2026-10-01 -->\n- [ ] due <!-- created=2026-10-02 -->\n- [ ] tre <!-- created=2026-10-03 -->\n"
    const left = removeChecklistItem(original, 1)
    expect(insertChecklistItem(left, 3, "- [ ] due <!-- created=2026-10-02 -->")).toBe(original)
  })

  test("hand-written items without metadata stay readable", () => {
    expect(parseChecklist(NOTE).items.map((item) => item.todo.content)).toEqual(["uno", "due"])
  })
})

describe("command filters", () => {
  const sorted = [
    { todo: { content: "Fix login", status: "pending" as const, priority: "high" as const }, index: 0 },
    { todo: { content: "Docs", status: "pending" as const, priority: "low" as const }, index: 1 },
    { todo: { content: "Login test", status: "completed" as const }, index: 2 },
  ]
  const options = [
    { title: "＋ Nuovo task", value: "new" },
    ...sorted.map(({ index }) => ({ title: `task ${index}`, value: `t${index}` })),
  ]

  test("empty query keeps everything, including the add entry", () => {
    expect(filterOptions("", options, sorted)).toHaveLength(4)
  })

  test("words filter by status and priority, free text by content", () => {
    expect(filterOptions("open", options, sorted).map((option) => option.value)).toEqual(["new", "t0", "t1"])
    expect(filterOptions("high", options, sorted).map((option) => option.value)).toEqual(["new", "t0"])
    expect(filterOptions("login done", options, sorted).map((option) => option.value)).toEqual(["new", "t2"])
  })

  test("/todo add takes the rest of the line, bare /todo lists", () => {
    expect(parseTodoCommand("")).toEqual({ action: "list" })
    expect(parseTodoCommand("edit")).toEqual({ action: "list" })
    expect(parseTodoCommand("add  comprare latte ")).toEqual({ action: "add", text: "comprare latte" })
    expect(parseTodoCommand("add")).toEqual({ action: "list" })
    expect(parseTodoCommand("ls")).toEqual({ action: "list" })
    expect(parseTodoCommand("add comprare latte high")).toEqual({ action: "add", text: "comprare latte", priority: "high" })
    // A lone "high" is the task text, not a priority.
    expect(parseTodoCommand("add high")).toEqual({ action: "add", text: "high" })
    expect(parseTodoCommand(" init ")).toEqual({ action: "init" })
  })

  test("an explicit undefined priority clears it, an absent one keeps it", () => {
    const withPriority = applyChecklist(NOTE, [{ content: "uno", status: "pending", priority: "high" }])
    const kept = applyChecklist(withPriority, [{ content: "uno", status: "pending" }])
    expect(kept).toContain("priority=high")
    const cleared = applyChecklist(kept, [{ content: "uno", status: "pending", priority: undefined }])
    expect(cleared).not.toContain("priority=")
    expect(cleared).toContain("created=")
  })

  test("the title carries the counts once", () => {
    expect(summaryTitle(sorted.map((entry) => entry.todo))).toBe("Todo · 2 open · 1 completed")
    expect(summaryTitle([{ content: "done", status: "completed" }])).toBe("Todo · 0 open · 1 completed")
    expect(summaryTitle([{ content: "gone", status: "cancelled" }])).toBe("Todo · 0 open · 1 cancelled")
  })
})

describe("updateTodo", () => {
  test("changes text and priority together, and clears priority with an explicit undefined", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-"))
    writeFileSync(join(dir, "TODO.md"), "# TODO\n\n- [ ] uno <!-- priority=high created=2026-10-01 -->\n- [ ] due\n")
    const context = {
      data: { session: { get: () => ({ directory: dir }) } },
      ui: { dialog: {}, toast: { show: () => {} } },
    }

    expect(updateTodo(context as never, "ses_test", "t1", { content: "due fatta meglio", priority: "low" })).toBe(true)
    let text = readFileSync(join(dir, "TODO.md"), "utf8")
    expect(text).toContain("- [ ] due fatta meglio <!-- id=2 priority=low created=")

    expect(updateTodo(context as never, "ses_test", "t0", { content: "uno", priority: undefined })).toBe(true)
    text = readFileSync(join(dir, "TODO.md"), "utf8")
    expect(text).toContain("- [ ] uno <!-- id=1 created=2026-10-01 -->")
    expect(text).not.toContain("priority=high")

    expect(updateTodo(context as never, "ses_test", "t99", { content: "fantasma" })).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test("resolves #id, sets and clears the due date", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-"))
    writeFileSync(join(dir, "TODO.md"), "# TODO\n\n- [ ] uno <!-- id=7 created=2026-10-01 -->\n")
    const context = {
      data: { session: { get: () => ({ directory: dir }) } },
      ui: { dialog: {}, toast: { show: () => {} } },
    }

    expect(updateTodo(context as never, "ses_test", "#7", { content: "uno", due: "2026-11-05" })).toBe(true)
    let text = readFileSync(join(dir, "TODO.md"), "utf8")
    expect(text).toContain("- [ ] uno <!-- id=7 due=2026-11-05 created=2026-10-01 -->")

    expect(updateTodo(context as never, "ses_test", "#7", { content: "uno", due: undefined })).toBe(true)
    text = readFileSync(join(dir, "TODO.md"), "utf8")
    expect(text).toContain("- [ ] uno <!-- id=7 created=2026-10-01 -->")
    expect(text).not.toContain("due=")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("initTodo", () => {
  test("creates TODO.md once and never overwrites it", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-"))
    const messages: Array<string> = []
    const context = {
      data: { session: { get: () => ({ directory: dir }) } },
      ui: { dialog: {}, toast: { show: (input: { message: string }) => messages.push(input.message) } },
    }

    expect(initTodo(context as never, "ses_test")).toBe(true)
    expect(readFileSync(join(dir, "TODO.md"), "utf8")).toContain("## To do")

    writeFileSync(join(dir, "TODO.md"), "# TODO\n")
    expect(initTodo(context as never, "ses_test")).toBe(false)
    expect(readFileSync(join(dir, "TODO.md"), "utf8")).toBe("# TODO\n")
    expect(messages.at(-1)).toBe("TODO.md already exists")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("strip refresh", () => {
  test("a write notifies listeners once and lands in TODO.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-"))
    writeFileSync(join(dir, "TODO.md"), "# TODO\n")
    const context = {
      data: { session: { get: () => ({ directory: dir }) } },
      ui: { dialog: {}, toast: { show: () => {} } },
    }
    let hits = 0
    const stop = onTodosChanged(() => hits++)
    addTodo(context as never, "ses_test", "comprare latte", "high")
    stop()
    addTodo(context as never, "ses_test", "dopo lo stop", "low")

    expect(hits).toBe(1)
    const text = readFileSync(join(dir, "TODO.md"), "utf8")
    expect(text).toContain("- [ ] comprare latte <!-- id=1 priority=high")
    expect(text).toContain("- [ ] dopo lo stop")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("ids, due dates and patches", () => {
  test("ids are assigned once and follow the task, never the position", () => {
    const first = applyChecklist("# TODO\n", [
      { content: "uno", status: "pending" },
      { content: "due", status: "pending" },
    ])
    expect(first).toContain("<!-- id=1 created=")
    expect(first).toContain("<!-- id=2 created=")

    // Same tasks, swapped order: the id must stay with the content.
    const reordered = applyChecklist(first, [
      { content: "due", status: "completed" },
      { content: "uno", status: "pending" },
    ])
    expect(reordered).toContain("- [x] due <!-- id=2")
    expect(reordered).toContain("- [ ] uno <!-- id=1")

    const added = applyChecklist(reordered, [
      { content: "due", status: "completed" },
      { content: "uno", status: "pending" },
      { content: "tre", status: "pending" },
    ])
    expect(added).toContain("- [ ] tre <!-- id=3 created=")
  })

  test("due round-trips and overdue ignores closed tasks", () => {
    const [todo] = parseChecklist("- [ ] uno <!-- id=1 due=2020-01-01 created=2026-10-31 -->").items.map((item) => item.todo)
    expect(todo.due).toBe("2020-01-01")
    expect(isOverdue(todo)).toBe(true)
    expect(isOverdue({ ...todo, status: "completed" })).toBe(false)
    expect(isOverdue({ ...todo, due: undefined })).toBe(false)
  })

  test("due soon covers today up to two days ahead, never late or closed tasks", () => {
    const plus = (days: number) => {
      const date = new Date()
      date.setUTCDate(date.getUTCDate() + days)
      return date.toISOString().slice(0, 10)
    }
    const open = { content: "uno", status: "pending" as const }
    expect(isDueSoon({ ...open, due: today() })).toBe(true)
    expect(isDueSoon({ ...open, due: plus(2) })).toBe(true)
    expect(isDueSoon({ ...open, due: plus(3) })).toBe(false)
    expect(isDueSoon({ ...open, due: "2020-01-01" })).toBe(false)
    expect(isDueSoon({ ...open, status: "completed", due: today() })).toBe(false)
    expect(isDueSoon({ ...open, status: "cancelled", due: today() })).toBe(false)
    expect(isDueSoon(open)).toBe(false)
  })

  test("patchTodos changes only the given fields", () => {
    const todos = parseChecklist(
      "- [ ] uno <!-- id=1 priority=high created=2026-10-01 -->\n- [ ] due <!-- id=2 -->\n",
    ).items.map((item) => item.todo)
    const patched = patchTodos(todos, [{ id: 2, status: "completed" }])
    expect(patched[1].status).toBe("completed")
    expect(patched[1].content).toBe("due")
    expect(patched[0]).toEqual(todos[0])
    expect(() => patchTodos(todos, [{ id: 9, status: "completed" }])).toThrow("no todo with id 9")
  })

  test("done and due are parsed from the slash command", () => {
    expect(parseTodoCommand("done 3")).toEqual({ action: "done", id: 3 })
    expect(parseTodoCommand("done #3")).toEqual({ action: "done", id: 3 })
    expect(parseTodoCommand("add comprare latte due=2026-12-01")).toEqual({
      action: "add",
      text: "comprare latte",
      due: "2026-12-01",
    })
  })

  test("completeTodo closes the task by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-"))
    writeFileSync(join(dir, "TODO.md"), "# TODO\n\n- [ ] uno <!-- id=1 -->\n- [ ] due <!-- id=2 -->\n")
    const context = {
      data: { session: { get: () => ({ directory: dir }) } },
      ui: { dialog: {}, toast: { show: () => {} } },
    }
    expect(completeTodo(context as never, "ses_test", 2)).toBe(true)
    expect(completeTodo(context as never, "ses_test", 99)).toBe(false)
    const text = readFileSync(join(dir, "TODO.md"), "utf8")
    expect(text).toContain("- [x] due <!-- id=2")
    expect(text).toContain("- [ ] uno <!-- id=1")
    rmSync(dir, { recursive: true, force: true })
  })

  test("the list filter accepts @tag and #id", () => {
    const options = [
      { title: "uno", value: "t0" },
      { title: "due", value: "t1" },
    ]
    const todos = [
      { todo: { content: "fix @mobile", status: "pending" as const, id: 1 }, index: 0 },
      { todo: { content: "fix backend", status: "pending" as const, id: 2 }, index: 1 },
    ]
    expect(filterOptions("@mobile", options, todos).map((option) => option.value)).toEqual(["t0"])
    expect(filterOptions("#2", options, todos).map((option) => option.value)).toEqual(["t1"])
  })
})

describe("table, sorting and due prompt", () => {
  test("rows align with the header and clip long text", () => {
    const row = tableRow({
      content: "un titolo molto lungo che supera di sicuro la colonna della descrizione intera",
      status: "pending",
      id: 12,
      priority: "high",
      created: "2026-10-30",
      due: "2026-11-05",
    })
    expect(row.length).toBe(TABLE_HEADER.length)
    expect(row.startsWith("#12 ")).toBe(true)
    expect(row).toContain("2026-11-05")
    expect(row).toContain("…")
    expect(descriptionOf({ content: "un titolo\n  molto lungo", status: "pending" })).toBe("un titolo molto lungo")
  })

  test("tags are extracted once from the text", () => {
    expect(tagsOf("fix @api e @mobile @api")).toEqual(["@api", "@mobile"])
    expect(tagsOf("niente tag")).toEqual([])
  })

  test("sorts by due date, missing dates last", () => {
    const todos: Array<Todo> = [
      { content: "b", status: "pending", due: "2026-11-05" },
      { content: "a", status: "pending" },
      { content: "c", status: "pending", due: "2026-10-01" },
    ]
    expect(sortBy(todos, "due").map(({ todo }) => todo.content)).toEqual(["c", "b", "a"])
  })

  test("filters still match after rows switched to #id values", () => {
    const todos = [{ todo: { content: "fix @api", status: "pending" as const, id: 3 }, index: 0 }]
    const options = [{ title: "#3", value: "#3" }]
    expect(filterOptions("#3", options, todos)).toHaveLength(1)
    expect(filterOptions("@api", options, todos)).toHaveLength(1)
    expect(filterOptions("#9", options, todos)).toHaveLength(0)
  })

  test("changeDue accepts an ISO date, rejects garbage and clears on empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-"))
    writeFileSync(join(dir, "TODO.md"), "# TODO\n\n- [ ] uno <!-- id=5 priority=high created=2026-10-01 -->\n")
    let answer: string | undefined = "2026-12-01"
    const context = {
      data: { session: { get: () => ({ directory: dir }) } },
      ui: { dialog: { prompt: async () => answer }, toast: { show: () => {} } },
    }

    await changeDue(context as never, "ses_test", "#5")
    let text = readFileSync(join(dir, "TODO.md"), "utf8")
    expect(text).toContain("due=2026-12-01")
    expect(text).toContain("priority=high")

    answer = "domani"
    await changeDue(context as never, "ses_test", "#5")
    expect(readFileSync(join(dir, "TODO.md"), "utf8")).toContain("due=2026-12-01")

    answer = ""
    await changeDue(context as never, "ses_test", "#5")
    text = readFileSync(join(dir, "TODO.md"), "utf8")
    expect(text).not.toContain("due=")
    expect(text).toContain("priority=high")
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("filter cycle", () => {
  const todos: Array<Todo> = [
    { content: "aperto", status: "pending", id: 1 },
    { content: "in corso", status: "in_progress", id: 2 },
    { content: "fatto", status: "completed", id: 3 },
    { content: "annullato", status: "cancelled", id: 4 },
  ]

  test("todosFor keeps open, in progress, closed or everything", () => {
    expect(todosFor(todos, "open").map(({ id }) => id)).toEqual([1, 2])
    expect(todosFor(todos, "doing").map(({ id }) => id)).toEqual([2])
    expect(todosFor(todos, "closed").map(({ id }) => id)).toEqual([3, 4])
    expect(todosFor(todos, "all")).toHaveLength(4)
    expect(todosFor(todos)).toHaveLength(4)
  })

  test("nextFilter cycles all, open, in progress, closed, overdue", () => {
    expect(nextFilter()).toBe("open")
    expect(nextFilter("open")).toBe("doing")
    expect(nextFilter("doing")).toBe("closed")
    expect(nextFilter("closed")).toBe("due")
    expect(nextFilter("due")).toBe("all")
  })
})

describe("filters, tags and dynamic columns", () => {
  const items: Array<Todo> = [
    { content: "uno @android", status: "pending", due: "2020-01-01" },
    { content: "due @api", status: "in_progress" },
    { content: "tre @android", status: "completed", due: "2020-01-01" },
  ]

  test("due filter keeps only overdue open tasks", () => {
    expect(todosFor(items, "due").map(({ content }) => content)).toEqual(["uno @android"])
    expect(todosFor(items, "open")).toHaveLength(2)
    expect(todosFor(items, "closed")).toHaveLength(1)
    expect(todosFor(items)).toHaveLength(3)
  })

  test("tag filter matches whole @tag tokens only", () => {
    expect(filterByTag(items, "@android").map(({ content }) => content)).toEqual(["uno @android", "tre @android"])
    expect(filterByTag(items, "@and")).toHaveLength(0)
    expect(filterByTag(items)).toHaveLength(3)
  })

  test("tag column follows the longest tag, clamped", () => {
    expect(tagWidthOf([])).toBe(6)
    expect(tagWidthOf(items)).toBe(8)
    expect(tagWidthOf([{ content: "@uncaratteremoltolungo", status: "pending" }])).toBe(8)
  })

  test("each state filter is its own clickable row", () => {
    const rows = filterRows("open")
    expect(rows.map(({ title }) => title)).toEqual(["○ all", "● open", "○ in progress", "○ closed", "○ overdue"])
    expect(rows.map(({ value }) => value)).toEqual(["filter:all", "filter:open", "filter:doing", "filter:closed", "filter:due"])
    expect(filterRows().map(({ title }) => title)).toEqual(["● all", "○ open", "○ in progress", "○ closed", "○ overdue"])
  })

  test("priority filters are rows and filter the list", () => {
    const todos: Array<Todo> = [
      { content: "a", status: "pending", priority: "high" },
      { content: "b", status: "pending", priority: "low" },
      { content: "c", status: "pending" },
    ]
    expect(priorityRows("high").map(({ title }) => title)).toEqual(["○ tutte", "● high", "○ medium", "○ low"])
    expect(priorityRows("high")[3].value).toBe("prio:low")
    expect(priorityRows()[0].value).toBe("prio:")
    expect(filterByPriority(todos, "low").map(({ content }) => content)).toEqual(["b"])
    expect(filterByPriority(todos)).toHaveLength(3)
  })

  test("custom tag width keeps rows aligned with the header", () => {
    const row = tableRow({ content: "x", status: "pending", id: 1 }, 12)
    expect(row.length).toBe(tableHeader(12).length)
    expect(tableHeader(12)).toContain("tag")
  })
})

describe("custom dialog helpers", () => {
  test("cycleTodo walks pending, in progress, completed and back", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-"))
    const file = join(dir, "TODO.md")
    writeFileSync(file, "# TODO\n\n- [ ] uno <!-- id=1 -->\n- [ ] due <!-- id=2 -->\n- [-] tre <!-- id=3 -->\n")
    const context = {
      data: { session: { get: () => ({ directory: dir }) } },
      ui: { dialog: {}, toast: { show: () => {} } },
    }

    expect(cycleTodo(context as never, "ses_test", "#2")).toBe(true)
    expect(readFileSync(file, "utf8")).toContain("- [•] due <!-- id=2")
    expect(cycleTodo(context as never, "ses_test", "#2")).toBe(true)
    expect(readFileSync(file, "utf8")).toContain("- [x] due <!-- id=2")
    expect(cycleTodo(context as never, "ses_test", "#2")).toBe(true)
    expect(readFileSync(file, "utf8")).toContain("- [ ] due <!-- id=2")
    expect(readFileSync(file, "utf8")).toContain("- [ ] uno <!-- id=1")

    // A cancelled task reopens as pending: the cycle only walks the working states.
    expect(cycleTodo(context as never, "ses_test", "#3")).toBe(true)
    expect(readFileSync(file, "utf8")).toContain("- [ ] tre <!-- id=3")
    expect(cycleTodo(context as never, "ses_test", "#9")).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test("removeTodo drops one line and leaves the rest untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-"))
    writeFileSync(join(dir, "TODO.md"), "# TODO\n\nNota.\n\n- [ ] uno <!-- id=1 -->\n- [ ] due <!-- id=2 -->\n- [ ] tre <!-- id=3 -->\n")
    const context = {
      data: { session: { get: () => ({ directory: dir }) } },
      ui: { dialog: {}, toast: { show: () => {} } },
    }

    expect(removeTodo(context as never, "ses_test", "#2")).toBe(true)
    const text = readFileSync(join(dir, "TODO.md"), "utf8")
    expect(text).toContain("Nota.")
    expect(text).not.toContain("due")
    expect(text).toContain("- [ ] uno <!-- id=1")
    expect(text).toContain("- [ ] tre <!-- id=3")
    expect(removeTodo(context as never, "ses_test", "#9")).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test("matchesQuery understands words, ids, tags and free text", () => {
    const todo = { content: "fix login @android", status: "pending" as const, id: 3 }
    expect(matchesQuery(todo, "")).toBe(true)
    expect(matchesQuery(todo, "#3")).toBe(true)
    expect(matchesQuery(todo, "#4")).toBe(false)
    expect(matchesQuery(todo, "@android")).toBe(true)
    expect(matchesQuery(todo, "login")).toBe(true)
    expect(matchesQuery(todo, "open")).toBe(true)
    expect(matchesQuery(todo, "done")).toBe(false)
  })
})

describe("strings module", () => {
  test("renderables are ASCII apart from the known markers", () => {
    const walk = (value: unknown): Array<string> => {
      if (typeof value === "string") return [value]
      if (typeof value === "function") return []
      if (value && typeof value === "object") return Object.values(value).flatMap(walk)
      return []
    }
    const markers = new Set(MARKERS)
    const offenders = walk(STRINGS)
      .map((text) => [...text].filter((char) => !markers.has(char)).join(""))
      .filter((text) => !/^[\x20-\x7E]*$/.test(text))
    expect(offenders).toEqual([])
  })
})

describe("completion date", () => {
  test("is stamped on completion and cleared when reopened", () => {
    const text = "# TODO\n\n- [ ] uno <!-- id=1 -->\n- [x] due <!-- id=2 done=2026-10-01 -->\n"
    const next = applyChecklist(text, [
      { content: "uno", status: "completed", id: 1 },
      { content: "due", status: "pending", id: 2 },
    ])
    const todos = readTodos(next)
    expect(todos[0].done).toBe(today())
    expect(todos[1].done).toBeUndefined()
    expect(readTodos(applyChecklist(next, todos))[0].done).toBe(today())
  })
})

describe("page size", () => {
  test("clamps between 4 and 8 rows", () => {
    expect(pageSize(10)).toBe(4)
    expect(pageSize(20)).toBe(4)
    expect(pageSize(40)).toBe(12)
    expect(pageSize(100)).toBe(12)
  })
})

describe("done sort", () => {
  test("orders by completion date and leaves open tasks last", () => {
    const items: Array<Todo> = [
      { content: "a", status: "pending" },
      { content: "b", status: "completed", done: "2026-10-05" },
      { content: "c", status: "completed", done: "2026-10-01" },
    ]
    expect(sortBy(items, "done").map(({ todo }) => todo.content)).toEqual(["c", "b", "a"])
    expect(nextSort("created")).toBe("done")
  })
})

describe("package manifest", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"))

  test("ships the TUI runtime: node_modules is not transformed by the host", () => {
    // Without a real dependency the bare import of @opentui/solid cannot resolve from
    // the npm cache, and the sidebar slot fails to load.
    for (const name of ["@opentui/solid", "@opentui/core", "solid-js"]) {
      expect(manifest.dependencies?.[name]).toBeTruthy()
    }
  })
})

describe("import bullets", () => {
  const mixed = "# TODO\n\n- fix login\n* write docs\n1. deploy\n- [x] already done\n\n```\n- code, not a task\n```\n"

  test("plain bullets and numbered items become checkboxes, checkboxes and code stay", () => {
    const { text, converted } = importBullets(mixed)
    expect(converted).toBe(3)
    expect(text).toContain("- [ ] fix login")
    expect(text).toContain("- [ ] write docs")
    expect(text).toContain("- [ ] deploy")
    expect(text).toContain("- [x] already done")
    expect(text).toContain("- code, not a task")
  })

  test("nothing to import leaves the file untouched", () => {
    const text = "# TODO\n\n- [ ] already a checkbox\n"
    expect(importBullets(text)).toEqual({ text, converted: 0 })
  })

  test("/todo import writes only after confirm", async () => {
    expect(parseTodoCommand(" import ")).toEqual({ action: "import" })
    const dir = mkdtempSync(join(tmpdir(), "todo-import-"))
    try {
      const file = join(dir, "TODO.md")
      writeFileSync(file, "- first\n- second\n")
      let asked = 0
      const context = {
        data: { session: { get: () => ({ directory: dir }) } },
        ui: {
          dialog: { confirm: async () => { asked++; return true } },
          toast: { show() {} },
        },
      }
      expect(await importTodo(context as never, "ses_test")).toBe(true)
      expect(asked).toBe(1)
      expect(readFileSync(file, "utf8")).toBe("- [ ] first\n- [ ] second\n")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("help command", () => {
  test("help, -h and ? open the help dialog", () => {
    expect(parseTodoCommand("help")).toEqual({ action: "help" })
    expect(parseTodoCommand(" -h ")).toEqual({ action: "help" })
    expect(parseTodoCommand("?")).toEqual({ action: "help" })
  })

  test("every subcommand listed in the help dialog is dispatched", () => {
    const verbs = STRINGS.dialog.help.slice(1).map((line) => line.slice("/todo ".length).split(" ")[0])
    expect(verbs).toEqual(["add", "done", "init", "import", "renumber", "settings", "help"])
    for (const verb of verbs) {
      const input = verb === "add" ? "add buy milk" : verb === "done" ? "done 1" : verb
      expect(parseTodoCommand(input).action).toBe(verb)
    }
  })

  test("the help dialog documents every action parseTodoCommand can return", () => {
    // Send one input per action, then compare the two sets: neither a phantom command nor an undocumented one survives.
    const spoken = ["", "init", "import", "renumber", "settings", "help", "done 1", "add buy milk"].map((input) => parseTodoCommand(input).action)
    const verbs = ["add", "done", "init", "import", "renumber", "settings", "help"]
    const documented = STRINGS.dialog.help.map((line) => {
      const word = line.slice("/todo".length).trim().split(/\s+/)[0] ?? ""
      return verbs.includes(word) ? word : "list"
    })
    expect(spoken.sort()).toEqual(["add", "done", "help", "import", "init", "list", "renumber", "settings"])
    expect(documented.sort()).toEqual(spoken)
  })
})

describe("renumber", () => {
  test("rewrites ids 1..N in place and keeps every other field", () => {
    const text = "# TODO\n\nNota.\n\n- [ ] b <!-- id=7 priority=high due=2026-11-03 created=2026-10-01 -->\n- [x] a <!-- id=9 done=2026-10-30 created=2026-09-01 -->\n"
    const out = renumberChecklist(text)
    expect(out).toContain("Nota.")
    expect(out).toContain("- [ ] b <!-- id=1 priority=high due=2026-11-03 created=2026-10-01 -->")
    expect(out).toContain("- [x] a <!-- id=2 done=2026-10-30 created=2026-09-01 -->")
  })
})

describe("settings", () => {
  test("unknown and invalid values fall back to the defaults", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      padding: 99,
      palette: "neon",
      descriptionWidth: "wide",
      stripCollapse: 0,
      initialFilter: "mine",
      deleteMode: 7,
      extra: true,
    })
    expect(merged.padding).toBe(2)
    expect(merged.palette).toBe("theme")
    expect(merged.descriptionWidth).toBe(50)
    expect(merged.stripCollapse).toBe(1)
    expect(merged.initialFilter).toBe("all")
    expect(merged.deleteMode).toBe("double")
    expect(Object.keys(merged)).toEqual(Object.keys(DEFAULT_SETTINGS))
  })

  test("the project file wins over the global one and survives a round trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "todo-md-settings-"))
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = dir
    try {
      saveSettings(dir, { ...DEFAULT_SETTINGS, palette: "fixed", stripMax: 40, saveTo: "global" })
      expect(loadSettings(dir).palette).toBe("fixed")
      saveSettings(dir, { ...loadSettings(dir), palette: "theme", showTags: false, saveTo: "project" })
      const merged = loadSettings(dir)
      expect(merged.palette).toBe("theme")
      expect(merged.stripMax).toBe(40)
      expect(merged.showTags).toBe(false)
      expect(existsSync(projectSettingsFile(dir))).toBe(true)
      expect(parseTodoCommand(" settings ").action).toBe("settings")
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("help from the keymap", () => {
  test("the help list and the dialog bindings are the same set", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8")
    const start = source.indexOf("function TodoDialog(")
    const end = source.indexOf("function SettingsDialog(")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const binds = [...source.slice(start, end).matchAll(/bind: "([^"]+)"/g)].map((match) => match[1])
    // Both directions: a missing entry in the help or a stale entry in the list fails here.
    expect([...new Set(binds)].sort()).toEqual(SHORTCUTS.map((row) => row.bind).sort())
  })
})
