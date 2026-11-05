import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { tagsOf } from "./command.ts"

export type Note = {
  id: number
  content: string
  created: string
  remind?: string
}

type ParsedNote = { note: Note; index: number; prefix: string }

const NOTES_FILE = "opencode-notes.md"
const META = /\s*<!--\s*([^>]*?)\s*-->\s*$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

export function notesFile(directory: string): string {
  return join(directory, NOTES_FILE)
}

/** Local `YYYY-MM-DDTHH:MM`, the only reminder format stored in the file. */
export function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function today(date = new Date()): string {
  return stamp(date).slice(0, 10)
}

function parseMeta(raw: string): { id?: number; created?: string; remind?: string } {
  const fields: { id?: number; created?: string; remind?: string } = {}
  for (const part of raw.split(/\s+/)) {
    const [key, value = ""] = part.split("=")
    if (key === "id" && /^\d+$/.test(value)) fields.id = Number(value)
    if (key === "created" && ISO_DATE.test(value)) fields.created = value
    if (key === "remind" && ISO_MINUTE.test(value)) fields.remind = value
  }
  return fields
}

/** Every `- text <!-- id=.. -->` line becomes a note; any other line is left untouched. */
export function parseNotes(text: string): { notes: Array<Note>; items: Array<ParsedNote>; lines: Array<string> } {
  const lines = text.split("\n")
  const items: Array<ParsedNote> = []
  lines.forEach((line, index) => {
    const bullet = line.match(/^(\s*-\s+)(.*)$/)
    if (!bullet) return
    const rest = bullet[2]
    const meta = rest.match(META)
    if (!meta) return
    const fields = parseMeta(meta[1])
    if (fields.id === undefined) return
    items.push({
      note: {
        id: fields.id,
        content: rest.replace(META, "").trim(),
        created: fields.created ?? "",
        remind: fields.remind,
      },
      index,
      prefix: bullet[1],
    })
  })
  return { notes: items.map((item) => item.note), items, lines }
}

export function renderNote(note: Note): string {
  const meta = [`id=${note.id}`]
  if (note.created) meta.push(`created=${note.created}`)
  if (note.remind) meta.push(`remind=${note.remind}`)
  return `- ${note.content} <!-- ${meta.join(" ")} -->`
}

function nextId(notes: Array<Note>): number {
  return notes.reduce((max, note) => Math.max(max, note.id), 0) + 1
}

export function appendNote(
  text: string,
  content: string,
  options: { created?: string; remind?: string } = {},
): { text: string; note: Note } {
  const { notes } = parseNotes(text)
  const note: Note = {
    id: nextId(notes),
    content: content.trim(),
    created: options.created ?? today(),
    remind: options.remind,
  }
  const body = text.trim() ? text.replace(/\n+$/, "") : "# Notes"
  const gap = body === "# Notes" ? "\n\n" : "\n"
  return { text: `${body}${gap}${renderNote(note)}\n`, note }
}

export function updateNote(
  text: string,
  id: number,
  patch: { content?: string; remind?: string | null },
): { text: string; note?: Note } {
  const { items, lines } = parseNotes(text)
  const item = items.find((entry) => entry.note.id === id)
  if (!item) return { text }
  const note: Note = {
    ...item.note,
    content: patch.content?.trim() || item.note.content,
    remind: patch.remind === null ? undefined : patch.remind ?? item.note.remind,
  }
  const out = [...lines]
  out[item.index] = `${item.prefix}${renderNote(note).replace(/^-\s+/, "")}`
  return { text: out.join("\n"), note }
}

export function deleteNote(text: string, id: number): { text: string; note?: Note } {
  const { items, lines } = parseNotes(text)
  const item = items.find((entry) => entry.note.id === id)
  if (!item) return { text }
  return { text: lines.filter((_, index) => index !== item.index).join("\n"), note: item.note }
}

export function snoozeNote(
  text: string,
  id: number,
  minutes: number,
  now = new Date(),
): { text: string; note?: Note } {
  return updateNote(text, id, { remind: stamp(new Date(now.getTime() + minutes * 60_000)) })
}

/** Relative `15m`, `2h`, `1d` or an absolute `YYYY-MM-DDTHH:MM`; empty input clears the reminder. */
export function parseRemind(input: string, now = new Date()): { ok: boolean; remind?: string } {
  const value = input.trim()
  if (!value) return { ok: true }
  const relative = value.match(/^(\d+)([mhd])$/i)
  if (relative) {
    const amount = Number(relative[1])
    const unit = relative[2].toLowerCase()
    const minutes = unit === "m" ? amount : unit === "h" ? amount * 60 : amount * 1440
    return { ok: true, remind: stamp(new Date(now.getTime() + minutes * 60_000)) }
  }
  if (!ISO_MINUTE.test(value)) return { ok: false }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || stamp(parsed) !== value) return { ok: false }
  return { ok: true, remind: value }
}

export function isNoteDue(note: Note, now = new Date()): boolean {
  return !!note.remind && note.remind <= stamp(now)
}

/** Filter used by the notes panel: all, reminders that are due, or one @tag. */
export function filterNotes(notes: Array<Note>, filter: string, now = new Date()): Array<Note> {
  if (filter === "all") return notes
  if (filter === "due") return notes.filter((note) => isNoteDue(note, now))
  return notes.filter((note) => tagsOf(note.content).includes(filter))
}

export function readNotes(directory: string): { file: string; text: string; notes: Array<Note> } {
  const file = notesFile(directory)
  const text = existsSync(file) ? readFileSync(file, "utf8") : "# Notes\n"
  return { file, text, notes: parseNotes(text).notes }
}

const listeners = new Set<() => void>()

/** Lets the sidebar and the dialog refresh as soon as a note is written. */
export function onNotesChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function saveNotes(file: string, text: string): void {
  writeFileSync(file, text)
  for (const listener of listeners) listener()
}
