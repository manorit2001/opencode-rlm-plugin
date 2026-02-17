import type { ChatMessage, RecursiveConfig } from "../types.js";
export type ContextStatus = "active" | "archived";
export interface ContextLane {
    id: string;
    sessionID: string;
    title: string;
    summary: string;
    status: ContextStatus;
    msgCount: number;
    lastActiveAt: number;
    createdAt: number;
    updatedAt: number;
}
export interface ContextLaneScore {
    contextID: string;
    score: number;
    title: string;
}
export interface ContextLaneSelection {
    primaryContextID: string;
    secondaryContextIDs: string[];
    scores: ContextLaneScore[];
    createdNewContext: boolean;
}
export interface MessageContextMembership {
    contextID: string;
    relevance: number;
    isPrimary: boolean;
}
export interface ContextRoutingInput {
    sessionID: string;
    messageID: string;
    latestUserText: string;
    history: ChatMessage[];
    config: RecursiveConfig;
    now: number;
}
export interface ContextRoutingResult {
    selection: ContextLaneSelection;
    laneHistory: ChatMessage[];
    activeContextCount: number;
}
export interface ContextSwitchEvent {
    fromContextID: string | null;
    toContextID: string;
    confidence: number;
    reason: string;
    createdAt: number;
}
