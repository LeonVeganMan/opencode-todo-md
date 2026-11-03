import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { SortKey, TodoFilter } from "./command.ts"

export type Palette = "theme" | "fixed"
export type DeleteMode = "double" | "dialog"
export type SortOption = SortKey | "status"
export type SaveScope = "project" | "global"

export type Settings = {
  padding: number
  palette: Palette
  showCreated: boolean
  showDone: boolean
  showTags: boolean
  descriptionWidth: number
  stripMax: number
  stripCollapse: number
  stripCompleted: boolean
  stripHeaderColor: boolean
  pageRows: number
  initialFilter: TodoFilter
  initialSort: SortOption
  deleteMode: DeleteMode
  renumberAfterDone: boolean
  autoInit: boolean
  saveTo: SaveScope
}

export const DEFAULT_SETTINGS: Settings = {
  padding: 1,
  palette: "theme",
  showCreated: true,
  showDone: true,
  showTags: true,
  descriptionWidth: 50,
  stripMax: 30,
  stripCollapse: 3,
  stripCompleted: false,
  stripHeaderColor: true,
  pageRows: 0,
  initialFilter: "all",
  initialSort: "status",
  deleteMode: "double",
  renumberAfterDone: false,
  autoInit: false,
  saveTo: "global",
}

const FILTERS: ReadonlyArray<TodoFilter> = ["all", "open", "closed", "overdue"]
const SORTS: ReadonlyArray<SortOption> = ["status", "due", "priority", "created", "done", "id"]

const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
  const number = typeof value === "number" ? Math.round(value) : Number.NaN
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback
}

const pick = <T extends string>(value: unknown, allowed: ReadonlyArray<T>, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback

/**
 * Settings are merged over the defaults one key at a time: a hand-edited file with a
 * typo must not break the panel, so every value is validated instead of trusted.
 */
export function mergeSettings(base: Settings, patch: unknown): Settings {
  const raw = (patch ?? {}) as Partial<Record<keyof Settings, unknown>>
  return {
    padding: clamp(raw.padding, 0, 2, base.padding),
    palette: pick(raw.palette, ["theme", "fixed"] as const, base.palette),
    showCreated: bool(raw.showCreated, base.showCreated),
    showDone: bool(raw.showDone, base.showDone),
    showTags: bool(raw.showTags, base.showTags),
    descriptionWidth: clamp(raw.descriptionWidth, 20, 80, base.descriptionWidth),
    stripMax: clamp(raw.stripMax, 10, 80, base.stripMax),
    stripCollapse: clamp(raw.stripCollapse, 1, 20, base.stripCollapse),
    stripCompleted: bool(raw.stripCompleted, base.stripCompleted),
    stripHeaderColor: bool(raw.stripHeaderColor, base.stripHeaderColor),
    pageRows: clamp(raw.pageRows, 0, 30, base.pageRows),
    initialFilter: pick(raw.initialFilter, FILTERS, base.initialFilter),
    initialSort: pick(raw.initialSort, SORTS, base.initialSort),
    deleteMode: pick(raw.deleteMode, ["double", "dialog"] as const, base.deleteMode),
    renumberAfterDone: bool(raw.renumberAfterDone, base.renumberAfterDone),
    autoInit: bool(raw.autoInit, base.autoInit),
    saveTo: pick(raw.saveTo, ["project", "global"] as const, base.saveTo),
  }
}

export function globalSettingsFile(): string {
  const config = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? ".", ".config")
  return join(config, "opencode", "todo-md.json")
}

export function projectSettingsFile(directory: string): string {
  return join(directory, ".opencode", "todo-md.json")
}

const readJson = (file: string): unknown => {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    // A broken settings file must not take the panel down with it.
    return undefined
  }
}

/** Global file first, project file on top: the project wins key by key. */
export function loadSettings(directory: string): Settings {
  const global = mergeSettings(DEFAULT_SETTINGS, readJson(globalSettingsFile()))
  return mergeSettings(global, readJson(projectSettingsFile(directory)))
}

export function saveSettings(directory: string, settings: Settings): string {
  const file = settings.saveTo === "project" ? projectSettingsFile(directory) : globalSettingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
  return file
}
