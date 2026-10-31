import { describe, expect, test } from "bun:test"
import { createRefresher } from "../src/refresh.ts"

describe("createRefresher", () => {
  test("a burst of pushes collapses into one refresh", async () => {
    let hits = 0
    const refresher = createRefresher(() => hits++, { intervalMs: 60_000, delayMs: 10 })
    refresher.push()
    refresher.push()
    refresher.push()
    await Bun.sleep(40)
    refresher.stop()
    expect(hits).toBe(1)
  })

  test("the fallback interval fires and stop clears it", async () => {
    let hits = 0
    const refresher = createRefresher(() => hits++, { intervalMs: 15, delayMs: 10 })
    await Bun.sleep(40)
    const before = hits
    refresher.stop()
    await Bun.sleep(40)
    expect(before).toBeGreaterThan(0)
    expect(hits).toBe(before)
  })
})
