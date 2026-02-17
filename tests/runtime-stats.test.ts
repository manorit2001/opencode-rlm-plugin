import test from "node:test"
import assert from "node:assert/strict"
import { createSessionRuntimeStats, formatRuntimeStats } from "../lib/runtime-stats.js"

test("formatRuntimeStats reports zero-safe rates", () => {
  const stats = createSessionRuntimeStats(1000)
  const text = formatRuntimeStats(stats, {
    activeContextCount: 0,
    primaryContextID: null,
    switchEventsCount: 0,
  })

  assert.ok(text.includes("RLM Runtime Stats (current plugin process)"))
  assert.ok(text.includes("Messages seen: 0"))
  assert.ok(text.includes("Compaction hit rate: 0.0%"))
  assert.ok(text.includes("Primary context: none"))
})

test("formatRuntimeStats reports updated counters", () => {
  const stats = createSessionRuntimeStats(2000)
  stats.messagesSeen = 7
  stats.historyFetchFailures = 1
  stats.laneRoutingRuns = 6
  stats.laneNewContextCount = 2
  stats.transformRuns = 5
  stats.compactionsApplied = 3
  stats.compactionsSkipped = 2
  stats.lastPressure = 0.8132
  stats.lastTokenEstimate = 17777
  stats.lastFocusedChars = 960
  stats.lastDecision = "compacted"
  stats.lastSeenAt = 4000

  const text = formatRuntimeStats(stats, {
    activeContextCount: 3,
    primaryContextID: "lane-1",
    switchEventsCount: 4,
  })

  assert.ok(text.includes("Messages seen: 7"))
  assert.ok(text.includes("History fetch failures: 1"))
  assert.ok(text.includes("Lane routing runs: 6"))
  assert.ok(text.includes("Lane new contexts: 2"))
  assert.ok(text.includes("Active contexts: 3"))
  assert.ok(text.includes("Primary context: lane-1"))
  assert.ok(text.includes("Recent switch events (last 50): 4"))
  assert.ok(text.includes("Transform runs: 5"))
  assert.ok(text.includes("Compactions applied: 3"))
  assert.ok(text.includes("Compactions skipped: 2"))
  assert.ok(text.includes("Compaction hit rate: 60.0%"))
  assert.ok(text.includes("Last pressure: 0.8132"))
  assert.ok(text.includes("Last token estimate: 17777"))
  assert.ok(text.includes("Last focused chars: 960"))
  assert.ok(text.includes("Last decision: compacted"))
})
