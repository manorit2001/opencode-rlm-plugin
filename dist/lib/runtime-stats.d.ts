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
    lastPressure: number;
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
