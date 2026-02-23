import { ContextLaneStore } from "./store.js";
import type { ContextLane, ContextRoutingInput, ContextRoutingResult } from "./types.js";
export interface CreateContextLaneSessionInput {
    rootSessionID: string;
    laneTitle: string;
    latestUserText: string;
    now: number;
}
export interface CreateContextLaneSessionResult {
    contextID?: string;
    laneTitle?: string;
}
type CreateContextLaneSessionHook = (input: CreateContextLaneSessionInput) => Promise<CreateContextLaneSessionResult | null>;
export declare class ContextLaneOrchestrator {
    private readonly store;
    private readonly fetchImpl;
    private readonly createContextLaneSession?;
    constructor(store: ContextLaneStore, fetchImpl?: typeof fetch, createContextLaneSession?: CreateContextLaneSessionHook | undefined);
    currentPrimaryContextID(sessionID: string): string | null;
    activeContextCount(sessionID: string): number;
    route(input: ContextRoutingInput): Promise<ContextRoutingResult>;
    listContexts(sessionID: string, limit?: number): ContextLane[];
    listSwitchEvents(sessionID: string, limit?: number): Array<{
        from: string | null;
        to: string;
        confidence: number;
        reason: string;
        at: number;
    }>;
    switchContext(sessionID: string, contextID: string, ttlMinutes: number, now: number): boolean;
    clearManualOverride(sessionID: string): void;
}
export {};
