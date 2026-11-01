/** One line per task: leave space for tabs, actions, search, header, pager and hint. */
export function pageSize(rows = process.stdout.rows ?? 40): number {
  // Cap at 12 tasks: the dialog must stay a panel, not take over the screen.
  return Math.max(4, Math.min(12, rows - 16))
}
