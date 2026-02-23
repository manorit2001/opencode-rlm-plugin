import type { ContextLaneOrchestrator } from "./orchestrator.js";
import type { ContextMembershipEvent, ContextLaneStore } from "./store.js";
import type { ContextLane } from "./types.js";
interface LaneSwitchRecord {
    from: string | null;
    to: string;
    confidence: number;
    reason: string;
    at: number;
}
export interface LaneVisualizationOptions {
    sessionID?: string;
    sessionLimit?: number;
    contextLimit?: number;
    switchLimit?: number;
    membershipLimit?: number;
}
export interface LaneTimelineEvent {
    at: number;
    kind: "context-created" | "membership" | "switch";
    contextID?: string;
    messageID?: string;
    label: string;
    detail: string;
}
export interface LaneVisualizationSession {
    sessionID: string;
    lastActivityAt: number;
    activeContextCount: number;
    primaryContextID: string | null;
    contexts: ContextLane[];
    switches: LaneSwitchRecord[];
    memberships: ContextMembershipEvent[];
    timeline: LaneTimelineEvent[];
}
export interface LaneVisualizationSnapshot {
    generatedAt: number;
    sessions: LaneVisualizationSession[];
}
export interface LaneVisualizationRenderOptions {
    apiPath?: string;
    eventsPath?: string;
    messagePath?: string;
}
export declare function buildLaneVisualizationSnapshot(laneStore: ContextLaneStore, laneOrchestrator: ContextLaneOrchestrator, options?: LaneVisualizationOptions): LaneVisualizationSnapshot;
export declare function formatLaneVisualizationText(snapshot: LaneVisualizationSnapshot): string;
export declare function renderLaneVisualizationHTML(snapshot: LaneVisualizationSnapshot, options?: LaneVisualizationRenderOptions): string;
export {};
