import { type LaneVisualizationOptions, type LaneVisualizationSnapshot } from "./visualization.js";
import type { ContextSnapshotRecord, LaneEventRecord, MessageIntentBucketAssignment, MessageProgressionStep } from "./types.js";
export interface LaneCacheRiskInputs {
    primaryChanged: boolean;
    addedContextCount: number;
    removedContextCount: number;
    changedContextCount: number;
    latestUserTextChars: number;
    historyMessages: number;
    focusedContextApplied: boolean;
    stablePrefixPresent: boolean;
    scaffoldStages: number;
}
export interface LaneCacheRisk {
    score: number;
    level: "low" | "medium" | "high";
    reasons: string[];
    inputs: LaneCacheRiskInputs;
}
export interface LaneMessageDebugPayload {
    intentBuckets: MessageIntentBucketAssignment[];
    progression: MessageProgressionStep[];
    snapshots: ContextSnapshotRecord[];
    previousIntentBuckets?: MessageIntentBucketAssignment[];
    bucketDelta?: unknown;
    rawRequestScaffold?: unknown;
    cacheRisk?: LaneCacheRisk;
}
interface LaneVisualizationSnapshotDefaults {
    sessionID: string;
    sessionLimit: number;
    contextLimit: number;
    switchLimit: number;
    membershipLimit: number;
}
export interface StartLaneVisualizationWebServerOptions {
    host: string;
    port: number;
    basePath?: string;
    defaults: LaneVisualizationSnapshotDefaults;
    buildSnapshot: (options: LaneVisualizationOptions) => LaneVisualizationSnapshot;
    listEventsAfter: (sessionID: string, afterSeq: number, limit: number) => LaneEventRecord[];
    getMessageDebug: (sessionID: string, messageID: string, limit: number) => LaneMessageDebugPayload;
}
export interface LaneVisualizationWebServerHandle {
    host: string;
    port: number;
    basePath: string;
    url: string;
    close: () => Promise<void>;
}
export declare function startLaneVisualizationWebServer(options: StartLaneVisualizationWebServerOptions): Promise<LaneVisualizationWebServerHandle>;
export {};
