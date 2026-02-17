export interface SessionRuntimeStats {
  firstSeenAt: number
  lastSeenAt: number
  messagesSeen: number
  historyFetchFailures: number
  laneRoutingRuns: number
  laneNewContextCount: number
  transformRuns: number
  compactionsApplied: number
  compactionsSkipped: number
  lastPressure: number
  lastTokenEstimate: number
  lastFocusedChars: number
  lastDecision: string
}

export function createSessionRuntimeStats(now: number): SessionRuntimeStats {
  return {
    firstSeenAt: now,
    lastSeenAt: now,
    messagesSeen: 0,
    historyFetchFailures: 0,
    laneRoutingRuns: 0,
    laneNewContextCount: 0,
    transformRuns: 0,
    compactionsApplied: 0,
    compactionsSkipped: 0,
    lastPressure: 0,
    lastTokenEstimate: 0,
    lastFocusedChars: 0,
    lastDecision: "none",
  }
}

function toPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return "0.0%"
  }

  return `${((100 * numerator) / denominator).toFixed(1)}%`
}

export function formatRuntimeStats(
  stats: SessionRuntimeStats,
  details: {
    activeContextCount: number
    primaryContextID: string | null
    switchEventsCount: number
  },
): string {
  const lines = [
    "RLM Runtime Stats (current plugin process)",
    `Messages seen: ${stats.messagesSeen}`,
    `History fetch failures: ${stats.historyFetchFailures}`,
    `Lane routing runs: ${stats.laneRoutingRuns}`,
    `Lane new contexts: ${stats.laneNewContextCount}`,
    `Active contexts: ${details.activeContextCount}`,
    `Primary context: ${details.primaryContextID ?? "none"}`,
    `Recent switch events (last 50): ${details.switchEventsCount}`,
    `Transform runs: ${stats.transformRuns}`,
    `Compactions applied: ${stats.compactionsApplied}`,
    `Compactions skipped: ${stats.compactionsSkipped}`,
    `Compaction hit rate: ${toPercent(stats.compactionsApplied, stats.transformRuns)}`,
    `Last pressure: ${stats.lastPressure.toFixed(4)}`,
    `Last token estimate: ${stats.lastTokenEstimate}`,
    `Last focused chars: ${stats.lastFocusedChars}`,
    `Last decision: ${stats.lastDecision}`,
    `First seen at (ms): ${stats.firstSeenAt}`,
    `Last seen at (ms): ${stats.lastSeenAt}`,
  ]

  return lines.join("\n")
}
