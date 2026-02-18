export function createSessionRuntimeStats(now) {
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
        lastTokenEstimate: 0,
        lastFocusedChars: 0,
        lastDecision: "none",
    };
}
function toPercent(numerator, denominator) {
    if (denominator <= 0) {
        return "0.0%";
    }
    return `${((100 * numerator) / denominator).toFixed(1)}%`;
}
function toFixedRatio(numerator, denominator) {
    if (denominator <= 0) {
        return "0.00";
    }
    return (numerator / denominator).toFixed(2);
}
function countSwitchReasons(switchEvents) {
    const counters = {
        "created-new-context": 0,
        "manual-override": 0,
        "score-switch": 0,
    };
    for (const event of switchEvents) {
        if (event.reason === "created-new-context" || event.reason === "manual-override" || event.reason === "score-switch") {
            counters[event.reason] += 1;
        }
    }
    return counters;
}
export function formatRuntimeStats(stats, details) {
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
    ];
    return lines.join("\n");
}
export function formatTokenEfficiencyStats(stats, details) {
    const reasonCounts = countSwitchReasons(details.switchEvents);
    const totalSwitches = details.switchEvents.length;
    const avgBaseline = toFixedRatio(stats.totalBaselineTokens, stats.laneRoutingSamples);
    const avgLaneScoped = toFixedRatio(stats.totalLaneScopedTokens, stats.laneRoutingSamples);
    const avgSaved = toFixedRatio(stats.totalLaneSavedTokens, stats.laneRoutingSamples);
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
        `Switch events sampled: ${totalSwitches}`,
        `Switch reasons: score-switch=${reasonCounts["score-switch"]}, manual-override=${reasonCounts["manual-override"]}, created-new-context=${reasonCounts["created-new-context"]}`,
    ];
    return lines.join("\n");
}
