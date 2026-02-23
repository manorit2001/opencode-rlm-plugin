import { type LaneVisualizationOptions, type LaneVisualizationSnapshot } from "./visualization.js";
import type { ContextSnapshotRecord, LaneEventRecord, MessageIntentBucketAssignment, MessageProgressionStep } from "./types.js";
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
    getMessageDebug: (sessionID: string, messageID: string, limit: number) => {
        intentBuckets: MessageIntentBucketAssignment[];
        progression: MessageProgressionStep[];
        snapshots: ContextSnapshotRecord[];
    };
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
