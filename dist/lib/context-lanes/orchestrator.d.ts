import { ContextLaneStore } from "./store.js";
import type { ContextLane, ContextRoutingInput, ContextRoutingResult } from "./types.js";
export declare class ContextLaneOrchestrator {
    private readonly store;
    private readonly fetchImpl;
    constructor(store: ContextLaneStore, fetchImpl?: typeof fetch);
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
