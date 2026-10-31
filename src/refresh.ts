/** Refresh plumbing for the strip: a slow fallback interval plus coalesced event pushes. */
export interface Refresher {
  /** Queue one refresh; bursts inside `delayMs` collapse into a single call. */
  push(): void
  stop(): void
}

export function createRefresher(
  refresh: () => void,
  { intervalMs = 60_000, delayMs = 200 }: { intervalMs?: number; delayMs?: number } = {},
): Refresher {
  const interval = setInterval(refresh, intervalMs)
  let queued: ReturnType<typeof setTimeout> | undefined
  return {
    push() {
      if (queued) clearTimeout(queued)
      queued = setTimeout(() => {
        queued = undefined
        refresh()
      }, delayMs)
    },
    stop() {
      clearInterval(interval)
      if (queued) clearTimeout(queued)
      queued = undefined
    },
  }
}
