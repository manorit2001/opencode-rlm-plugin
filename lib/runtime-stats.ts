export interface LaneTelemetrySample {
  at: number
  baselineTokens: number
  laneScopedTokens: number
  laneRatio: number
  laneRatioDelta: number
  historyMessages: number
  laneHistoryMessages: number
  primaryContextID: string | null
  createdNewContext: boolean
}

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
  laneRoutingSamples: number
  totalBaselineTokens: number
  totalLaneScopedTokens: number
  totalLaneSavedTokens: number
  lastPressure: number
  lastBaselineTokenEstimate: number
  lastLaneScopedTokenEstimate: number
  lastLaneSavedTokens: number
  lastLaneTokenRatio: number
  lastLaneTokenRatioDelta: number
  minLaneTokenRatio: number
  maxLaneTokenRatio: number
  abruptLaneDropCount: number
  laneTelemetry: LaneTelemetrySample[]
  lastTokenEstimate: number
  lastFocusedChars: number
  lastDecision: string
}

interface LaneTelemetryInput {
  at: number
  baselineTokens: number
  laneScopedTokens: number
  historyMessages: number
  laneHistoryMessages: number
  primaryContextID: string | null
  createdNewContext: boolean
}

const DEFAULT_ABRUPT_DROP_THRESHOLD = 0.2
const MAX_LANE_TELEMETRY_SAMPLES = 20

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
    laneRoutingSamples: 0,
    totalBaselineTokens: 0,
    totalLaneScopedTokens: 0,
    totalLaneSavedTokens: 0,
    lastPressure: 0,
    lastBaselineTokenEstimate: 0,
    lastLaneScopedTokenEstimate: 0,
    lastLaneSavedTokens: 0,
    lastLaneTokenRatio: 0,
    lastLaneTokenRatioDelta: 0,
    minLaneTokenRatio: 0,
    maxLaneTokenRatio: 0,
    abruptLaneDropCount: 0,
    laneTelemetry: [],
    lastTokenEstimate: 0,
    lastFocusedChars: 0,
    lastDecision: "none",
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }

  return Math.max(min, Math.min(max, value))
}

export function recordLaneTelemetry(
  stats: SessionRuntimeStats,
  sample: LaneTelemetryInput,
  abruptDropThreshold = DEFAULT_ABRUPT_DROP_THRESHOLD,
): void {
  const ratio = sample.baselineTokens <= 0 ? 1 : sample.laneScopedTokens / sample.baselineTokens
  const laneRatio = clamp(ratio, 0, 1)

  const hasPrevious = stats.laneTelemetry.length > 0
  const previousRatio = hasPrevious ? stats.lastLaneTokenRatio : laneRatio
  const laneRatioDelta = laneRatio - previousRatio

  if (hasPrevious) {
    stats.minLaneTokenRatio = Math.min(stats.minLaneTokenRatio, laneRatio)
    stats.maxLaneTokenRatio = Math.max(stats.maxLaneTokenRatio, laneRatio)
  } else {
    stats.minLaneTokenRatio = laneRatio
    stats.maxLaneTokenRatio = laneRatio
  }

  stats.lastLaneTokenRatio = laneRatio
  stats.lastLaneTokenRatioDelta = laneRatioDelta

  const threshold = clamp(abruptDropThreshold, 0, 1)
  if (hasPrevious && laneRatioDelta <= -threshold) {
    stats.abruptLaneDropCount += 1
  }

  stats.laneTelemetry.push({
    at: sample.at,
    baselineTokens: sample.baselineTokens,
    laneScopedTokens: sample.laneScopedTokens,
    laneRatio,
    laneRatioDelta,
    historyMessages: sample.historyMessages,
    laneHistoryMessages: sample.laneHistoryMessages,
    primaryContextID: sample.primaryContextID,
    createdNewContext: sample.createdNewContext,
  })

  if (stats.laneTelemetry.length > MAX_LANE_TELEMETRY_SAMPLES) {
    stats.laneTelemetry.splice(0, stats.laneTelemetry.length - MAX_LANE_TELEMETRY_SAMPLES)
  }
}

function toPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return "0.0%"
  }

  return `${((100 * numerator) / denominator).toFixed(1)}%`
}

function toFixedRatio(numerator: number, denominator: number): string {
  if (denominator <= 0) {
    return "0.00"
  }

  return (numerator / denominator).toFixed(2)
}

type SwitchReason = "created-new-context" | "manual-override" | "score-switch"

function countSwitchReasons(switchEvents: Array<{ reason: string }>): Record<SwitchReason, number> {
  const counters: Record<SwitchReason, number> = {
    "created-new-context": 0,
    "manual-override": 0,
    "score-switch": 0,
  }

  for (const event of switchEvents) {
    if (event.reason === "created-new-context" || event.reason === "manual-override" || event.reason === "score-switch") {
      counters[event.reason] += 1
    }
  }

  return counters
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

export function formatTokenEfficiencyStats(
  stats: SessionRuntimeStats,
  details: {
    activeContextCount: number
    switchEvents: Array<{ reason: string }>
  },
): string {
  const reasonCounts = countSwitchReasons(details.switchEvents)
  const totalSwitches = details.switchEvents.length
  const avgBaseline = toFixedRatio(stats.totalBaselineTokens, stats.laneRoutingSamples)
  const avgLaneScoped = toFixedRatio(stats.totalLaneScopedTokens, stats.laneRoutingSamples)
  const avgSaved = toFixedRatio(stats.totalLaneSavedTokens, stats.laneRoutingSamples)
  const hasTelemetry = stats.laneTelemetry.length > 0
  const minRatio = hasTelemetry ? stats.minLaneTokenRatio : 0
  const maxRatio = hasTelemetry ? stats.maxLaneTokenRatio : 0
  const recentTelemetry = stats.laneTelemetry
    .slice(-5)
    .map((sample) => {
      const ratio = (sample.laneRatio * 100).toFixed(1)
      const delta = (sample.laneRatioDelta * 100).toFixed(1)
      const primary = sample.primaryContextID ?? "none"
      const newFlag = sample.createdNewContext ? "yes" : "no"
      return `t=${sample.at} ratio=${ratio}% delta=${delta}pp baseline=${sample.baselineTokens} lane=${sample.laneScopedTokens} msgs=${sample.laneHistoryMessages}/${sample.historyMessages} primary=${primary} new=${newFlag}`
    })

  const lines = [
    "RLM Token Efficiency (estimated, current plugin process)",
    `Lane routing runs: ${stats.laneRoutingRuns}`,
    `Lane routing samples (with token comparison): ${stats.laneRoutingSamples}`,
    `Active contexts: ${details.activeContextCount}`,
    `Total baseline tokens (full history): ${stats.totalBaselineTokens}`,
    `Total lane-scoped tokens (routed history): ${stats.totalLaneScopedTokens}`,
    `Estimated tokens saved by routing: ${stats.totalLaneSavedTokens}`,
    `Estimated routing savings rate: ${toPercent(stats.totalLaneSavedTokens, stats.totalBaselineTokens)}`,
    `Avg baseline tokens per routed run: ${avgBaseline}`,
    `Avg lane-scoped tokens per routed run: ${avgLaneScoped}`,
    `Avg tokens saved per routed run: ${avgSaved}`,
    `Last baseline token estimate: ${stats.lastBaselineTokenEstimate}`,
    `Last lane-scoped token estimate: ${stats.lastLaneScopedTokenEstimate}`,
    `Last estimated route savings: ${stats.lastLaneSavedTokens}`,
    `Last lane token ratio: ${(stats.lastLaneTokenRatio * 100).toFixed(1)}%`,
    `Last lane ratio delta: ${(stats.lastLaneTokenRatioDelta * 100).toFixed(1)}pp`,
    `Lane token ratio range: ${(minRatio * 100).toFixed(1)}%..${(maxRatio * 100).toFixed(1)}%`,
    `Abrupt lane drops (>=${(DEFAULT_ABRUPT_DROP_THRESHOLD * 100).toFixed(1)}pp): ${stats.abruptLaneDropCount}`,
    `Switch events sampled: ${totalSwitches}`,
    `Switch reasons: score-switch=${reasonCounts["score-switch"]}, manual-override=${reasonCounts["manual-override"]}, created-new-context=${reasonCounts["created-new-context"]}`,
  ]

  if (recentTelemetry.length > 0) {
    lines.push(`Recent lane telemetry: ${recentTelemetry.join(" | ")}`)
  }

  return lines.join("\n")
}
