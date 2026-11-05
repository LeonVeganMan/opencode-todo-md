import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendNote,
  deleteNote,
  filterNotes,
  isNoteDue,
  onNotesChanged,
  parseNotes,
  parseRemind,
  renderNote,
  saveNotes,
  snoozeNote,
  stamp,
  updateNote,
} from "../src/notes.ts"

const NOW = new Date(2026, 10, 5, 14, 0)
const TEXT = "# Notes\n\n- idea @api <!-- id=2 created=2026-11-01 remind=2026-11-02T09:30 -->\n- plain bullet\n- [ ] not a note\n"

describe("notes", () => {
  test("parses managed lines and leaves the others alone", () => {
    const { notes, items, lines } = parseNotes(TEXT)
    expect(notes).toEqual([{ id: 2, content: "idea @api", created: "2026-11-01", remind: "2026-11-02T09:30" }])
    expect(items).toHaveLength(1)
    expect(lines).toHaveLength(6)
  })

  test("a note without metadata is not a note", () => {
    expect(parseNotes("- just a bullet\n").notes).toEqual([])
  })

  test("appends notes with max+1 ids", () => {
    const first = appendNote("# Notes\n", "first", { created: "2026-11-05" })
    expect(first.note.id).toBe(1)
    expect(first.text).toBe("# Notes\n\n- first <!-- id=1 created=2026-11-05 -->\n")

    const second = appendNote(first.text, "second", { created: "2026-11-05" })
    expect(second.note.id).toBe(2)
    expect(second.text).toContain("- second <!-- id=2 created=2026-11-05 -->")

    const removed = deleteNote(second.text, 1)
    const third = appendNote(removed.text, "third", { created: "2026-11-05" })
    expect(third.note.id).toBe(3)
  })

  test("updates the text, sets and clears the reminder in place", () => {
    const set = updateNote(TEXT, 2, { content: "idea revised", remind: "2026-11-05T14:30" })
    expect(set.text).toContain("- idea revised <!-- id=2 created=2026-11-01 remind=2026-11-05T14:30 -->")
    expect(set.note?.content).toBe("idea revised")

    const cleared = updateNote(set.text, 2, { remind: null })
    expect(cleared.text).toContain("- idea revised <!-- id=2 created=2026-11-01 -->")
    expect(cleared.text).not.toContain("remind=")
  })

  test("updates keep the original bullet prefix", () => {
    const text = "  - indented <!-- id=1 created=2026-11-05 -->\n"
    expect(updateNote(text, 1, { content: "done" }).text).toBe("  - done <!-- id=1 created=2026-11-05 -->\n")
  })

  test("snooze moves the reminder from now", () => {
    const snoozed = snoozeNote(TEXT, 2, 30, NOW)
    expect(snoozed.note?.remind).toBe("2026-11-05T14:30")
    expect(snoozed.text).toContain("remind=2026-11-05T14:30")
  })

  test("render and parse round trip", () => {
    const note = { id: 7, content: "keep @tag", created: "2026-11-05", remind: "2026-11-06T08:00" }
    const parsed = parseNotes(renderNote(note)).notes[0]
    expect(parsed).toEqual(note)
  })

  test("relative, absolute and invalid reminders", () => {
    expect(parseRemind("15m", NOW)).toEqual({ ok: true, remind: "2026-11-05T14:15" })
    expect(parseRemind("2h", NOW)).toEqual({ ok: true, remind: "2026-11-05T16:00" })
    expect(parseRemind("1d", NOW)).toEqual({ ok: true, remind: "2026-11-06T14:00" })
    expect(parseRemind("2026-12-01T09:00", NOW)).toEqual({ ok: true, remind: "2026-12-01T09:00" })
    expect(parseRemind("", NOW)).toEqual({ ok: true })
    expect(parseRemind("soon", NOW).ok).toBe(false)
    expect(parseRemind("2026-02-30T09:00", NOW).ok).toBe(false)
  })

  test("due only when the reminder has passed", () => {
    expect(isNoteDue({ id: 1, content: "a", created: "", remind: "2026-11-05T14:00" }, NOW)).toBe(true)
    expect(isNoteDue({ id: 1, content: "a", created: "", remind: "2026-11-05T14:01" }, NOW)).toBe(false)
    expect(isNoteDue({ id: 1, content: "a", created: "" }, NOW)).toBe(false)
  })

  test("stamp is local and minute-precision", () => {
    expect(stamp(NOW)).toBe("2026-11-05T14:00")
  })
})

test("filters notes by due state and tag", () => {
  const notes = [
    { id: 1, content: "deploy @infra", created: "2026-11-05", remind: "2026-11-05T10:00" },
    { id: 2, content: "read @docs", created: "2026-11-05" },
  ]
  expect(filterNotes(notes, "all")).toHaveLength(2)
  expect(filterNotes(notes, "due", new Date("2026-11-05T11:00")).map((note) => note.id)).toEqual([1])
  expect(filterNotes(notes, "@infra").map((note) => note.id)).toEqual([1])
  expect(filterNotes(notes, "@missing")).toEqual([])
})

describe("notes change listeners", () => {
  test("saveNotes notifies subscribers until they unsubscribe", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-notes-"))
    try {
      let calls = 0
      const stop = onNotesChanged(() => {
        calls += 1
      })
      const file = join(dir, "opencode-notes.md")
      saveNotes(file, "# Notes\n")
      expect(calls).toBe(1)
      stop()
      saveNotes(file, "# Notes\n- done\n")
      expect(calls).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
