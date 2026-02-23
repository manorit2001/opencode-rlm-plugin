export interface LaneTelemetrySample {
    at: number;
    baselineTokens: number;
    laneScopedTokens: number;
    laneRatio: number;
    laneRatioDelta: number;
    historyMessages: number;
    laneHistoryMessages: number;
    primaryContextID: string | null;
    createdNewContext: boolean;
}
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
    lastLaneTokenRatio: number;
    lastLaneTokenRatioDelta: number;
    minLaneTokenRatio: number;
    maxLaneTokenRatio: number;
    abruptLaneDropCount: number;
    laneTelemetry: LaneTelemetrySample[];
    lastTokenEstimate: number;
    lastFocusedChars: number;
    lastDecision: string;
}
interface LaneTelemetryInput {
    at: number;
    baselineTokens: number;
    laneScopedTokens: number;
    historyMessages: number;
    laneHistoryMessages: number;
    primaryContextID: string | null;
    createdNewContext: boolean;
}
export declare function createSessionRuntimeStats(now: number): SessionRuntimeStats;
export declare function recordLaneTelemetry(stats: SessionRuntimeStats, sample: LaneTelemetryInput, abruptDropThreshold?: number): void;
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
export {};
