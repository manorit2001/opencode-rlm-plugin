import test from "node:test";
import assert from "node:assert/strict";
import { createSessionRuntimeStats, formatRuntimeStats, formatTokenEfficiencyStats } from "../lib/runtime-stats.js";
test("formatRuntimeStats reports zero-safe rates", () => {
    const stats = createSessionRuntimeStats(1000);
    const text = formatRuntimeStats(stats, {
        activeContextCount: 0,
        primaryContextID: null,
        switchEventsCount: 0,
    });
    assert.ok(text.includes("RLM Runtime Stats (current plugin process)"));
    assert.ok(text.includes("Messages seen: 0"));
    assert.ok(text.includes("Compaction hit rate: 0.0%"));
    assert.ok(text.includes("Primary context: none"));
});
test("formatRuntimeStats reports updated counters", () => {
    const stats = createSessionRuntimeStats(2000);
    stats.messagesSeen = 7;
    stats.historyFetchFailures = 1;
    stats.laneRoutingRuns = 6;
    stats.laneNewContextCount = 2;
    stats.transformRuns = 5;
    stats.compactionsApplied = 3;
    stats.compactionsSkipped = 2;
    stats.lastPressure = 0.8132;
    stats.lastTokenEstimate = 17777;
    stats.lastFocusedChars = 960;
    stats.lastDecision = "compacted";
    stats.lastSeenAt = 4000;
    const text = formatRuntimeStats(stats, {
        activeContextCount: 3,
        primaryContextID: "lane-1",
        switchEventsCount: 4,
    });
    assert.ok(text.includes("Messages seen: 7"));
    assert.ok(text.includes("History fetch failures: 1"));
    assert.ok(text.includes("Lane routing runs: 6"));
    assert.ok(text.includes("Lane new contexts: 2"));
    assert.ok(text.includes("Active contexts: 3"));
    assert.ok(text.includes("Primary context: lane-1"));
    assert.ok(text.includes("Recent switch events (last 50): 4"));
    assert.ok(text.includes("Transform runs: 5"));
    assert.ok(text.includes("Compactions applied: 3"));
    assert.ok(text.includes("Compactions skipped: 2"));
    assert.ok(text.includes("Compaction hit rate: 60.0%"));
    assert.ok(text.includes("Last pressure: 0.8132"));
    assert.ok(text.includes("Last token estimate: 17777"));
    assert.ok(text.includes("Last focused chars: 960"));
    assert.ok(text.includes("Last decision: compacted"));
});
test("formatTokenEfficiencyStats reports zero-safe token savings", () => {
    const stats = createSessionRuntimeStats(3000);
    const text = formatTokenEfficiencyStats(stats, {
        activeContextCount: 0,
        switchEvents: [],
    });
    assert.ok(text.includes("RLM Token Efficiency (estimated, current plugin process)"));
    assert.ok(text.includes("Estimated tokens saved by routing: 0"));
    assert.ok(text.includes("Estimated routing savings rate: 0.0%"));
    assert.ok(text.includes("Switch events sampled: 0"));
});
test("formatTokenEfficiencyStats reports route savings and switch reasons", () => {
    const stats = createSessionRuntimeStats(4000);
    stats.laneRoutingRuns = 8;
    stats.laneRoutingSamples = 7;
    stats.totalBaselineTokens = 21000;
    stats.totalLaneScopedTokens = 13650;
    stats.totalLaneSavedTokens = 7350;
    stats.lastBaselineTokenEstimate = 3600;
    stats.lastLaneScopedTokenEstimate = 2500;
    stats.lastLaneSavedTokens = 1100;
    const text = formatTokenEfficiencyStats(stats, {
        activeContextCount: 4,
        switchEvents: [
            { reason: "score-switch" },
            { reason: "manual-override" },
            { reason: "score-switch" },
            { reason: "created-new-context" },
            { reason: "score-switch" },
        ],
    });
    assert.ok(text.includes("Lane routing runs: 8"));
    assert.ok(text.includes("Lane routing samples (with token comparison): 7"));
    assert.ok(text.includes("Active contexts: 4"));
    assert.ok(text.includes("Total baseline tokens (full history): 21000"));
    assert.ok(text.includes("Total lane-scoped tokens (routed history): 13650"));
    assert.ok(text.includes("Estimated tokens saved by routing: 7350"));
    assert.ok(text.includes("Estimated routing savings rate: 35.0%"));
    assert.ok(text.includes("Avg baseline tokens per routed run: 3000.00"));
    assert.ok(text.includes("Avg lane-scoped tokens per routed run: 1950.00"));
    assert.ok(text.includes("Avg tokens saved per routed run: 1050.00"));
    assert.ok(text.includes("Last baseline token estimate: 3600"));
    assert.ok(text.includes("Last lane-scoped token estimate: 2500"));
    assert.ok(text.includes("Last estimated route savings: 1100"));
    assert.ok(text.includes("Switch events sampled: 5"));
    assert.ok(text.includes("Switch reasons: score-switch=3, manual-override=1, created-new-context=1"));
});
