import type { ContextLane, ContextSwitchEvent, MessageContextMembership } from "./types.js";
export declare class ContextLaneStore {
    private readonly db;
    private readonly fallbackContexts;
    private readonly fallbackMemberships;
    private readonly fallbackSwitches;
    private readonly fallbackOverrides;
    constructor(baseDirectory: string, dbPath: string);
    private ensureSchema;
    countActiveContexts(sessionID: string): number;
    listActiveContexts(sessionID: string, limit: number): ContextLane[];
    listContexts(sessionID: string, limit: number): ContextLane[];
    getContext(sessionID: string, contextID: string): ContextLane | null;
    createContext(sessionID: string, title: string, summary: string, now: number): ContextLane;
    updateContextSummary(sessionID: string, contextID: string, summary: string, now: number): void;
    latestPrimaryContextID(sessionID: string): string | null;
    saveMemberships(sessionID: string, messageID: string, memberships: MessageContextMembership[], now: number): void;
    getMembershipContextMap(sessionID: string, messageIDs: string[]): Map<string, Set<string>>;
    recordSwitch(sessionID: string, messageID: string, fromContextID: string | null, toContextID: string, confidence: number, reason: string, now: number): void;
    listSwitchEvents(sessionID: string, limit: number): ContextSwitchEvent[];
    setManualOverride(sessionID: string, contextID: string, expiresAt: number): void;
    clearManualOverride(sessionID: string): void;
    getManualOverride(sessionID: string, now: number): string | null;
}
