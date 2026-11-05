import { readFileSync } from "node:fs"

const version = process.argv[2]?.replace(/^v/, "")
if (!version) {
  console.error("usage: bun scripts/release-body.ts <version>")
  process.exit(1)
}

const doc = readFileSync("ANNOUNCE.md", "utf8")
const heading = `## What's new in ${version}`
const start = doc.indexOf(heading)
if (start === -1) {
  console.error(`ANNOUNCE.md has no "${heading}" section`)
  process.exit(1)
}

const rest = doc.slice(start + heading.length)
const end = rest.search(/\n## |\nStatus:/)
const notes = rest.slice(0, end === -1 ? undefined : end).trim()
if (!notes) {
  console.error(`The "${heading}" section is empty`)
  process.exit(1)
}

const status = doc.match(/Status: v([\d.]+), (\d+) unit tests/)
if (!status || status[1] !== version) {
  console.error(`ANNOUNCE.md status does not mention v${version}`)
  process.exit(1)
}

// The notes live in ANNOUNCE.md only: everything else is the fixed footer every release shares.
const body = [
  heading,
  "",
  notes,
  "",
  "![The /todo dialog](https://raw.githubusercontent.com/LeonVeganMan/opencode-todo-md/master/screen/todo.png)",
  "",
  "## Install",
  "",
  "```json",
  '{ "plugins": ["opencode-todo-md"] }',
  "```",
  "",
  "The TUI half (sidebar strip and `/todo`) loads at TUI startup: restart `opencode`, or run `/reload`.",
  "",
  `${status[2]} unit tests. MIT.`,
]
console.log(body.join("\n"))
