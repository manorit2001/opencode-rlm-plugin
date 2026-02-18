export interface SessionRuntimeStats {
    firstSeenAt: number;
    lastSeenAt: number;
    messagesSeen: number;
    historyFetchFailures: number;
    laneRoutingRuns: number;
    laneNewContextCount: number;
    transformRuns: number;
    compactionsApplied: number;
    compactionsSkipped: number;
    laneRoutingSamples: number;
    totalBaselineTokens: number;
    totalLaneScopedTokens: number;
    totalLaneSavedTokens: number;
    lastPressure: number;
    lastBaselineTokenEstimate: number;
    lastLaneScopedTokenEstimate: number;
    lastLaneSavedTokens: number;
    lastTokenEstimate: number;
    lastFocusedChars: number;
    lastDecision: string;
}
export declare function createSessionRuntimeStats(now: number): SessionRuntimeStats;
export declare function formatRuntimeStats(stats: SessionRuntimeStats, details: {
    activeContextCount: number;
    primaryContextID: string | null;
    switchEventsCount: number;
}): string;
export declare function formatTokenEfficiencyStats(stats: SessionRuntimeStats, details: {
    activeContextCount: number;
    switchEvents: Array<{
        reason: string;
    }>;
}): string;
