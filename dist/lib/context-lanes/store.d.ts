import type { ContextLane, ContextSnapshotRecord, ContextSwitchEvent, LaneEventRecord, MessageContextMembership, MessageIntentBucketAssignment, MessageProgressionStep } from "./types.js";
export interface SessionActivity {
    sessionID: string;
    lastActivityAt: number;
}
export interface ContextMembershipEvent {
    messageID: string;
    contextID: string;
    relevance: number;
    isPrimary: boolean;
    createdAt: number;
}
export interface IntentBucketDeltaChange {
    contextID: string;
    previousScore: number;
    currentScore: number;
    previousRank: number;
    currentRank: number;
    previousBucketType: string;
    currentBucketType: string;
}
export interface MessageIntentBucketDelta {
    previousMessageID: string | null;
    previousPrimaryContextID: string | null;
    currentPrimaryContextID: string | null;
    primaryChanged: boolean;
    addedContextIDs: string[];
    removedContextIDs: string[];
    changedContexts: IntentBucketDeltaChange[];
}
export interface MessageIntentBucketDebug {
    currentBuckets: MessageIntentBucketAssignment[];
    previousBuckets: MessageIntentBucketAssignment[];
    delta: MessageIntentBucketDelta;
}
export declare class ContextLaneStore {
    private readonly db;
    private readonly fallbackContexts;
    private readonly fallbackMemberships;
    private readonly fallbackSwitches;
    private readonly fallbackOverrides;
    private readonly fallbackIntentBuckets;
    private readonly fallbackProgressionSteps;
    private readonly fallbackContextSnapshots;
    private readonly fallbackLaneEvents;
    private fallbackLaneEventSeq;
    constructor(baseDirectory: string, dbPath: string);
    private ensureSchema;
    countActiveContexts(sessionID: string): number;
    listSessions(limit: number): SessionActivity[];
    listActiveContexts(sessionID: string, limit: number): ContextLane[];
    listContexts(sessionID: string, limit: number): ContextLane[];
    getContext(sessionID: string, contextID: string): ContextLane | null;
    createContext(sessionID: string, title: string, summary: string, now: number, preferredContextID?: string, ownerSessionID?: string): ContextLane;
    updateContextSummary(sessionID: string, contextID: string, summary: string, now: number): void;
    latestPrimaryContextID(sessionID: string): string | null;
    saveMemberships(sessionID: string, messageID: string, memberships: MessageContextMembership[], now: number): void;
    getMembershipContextMap(sessionID: string, messageIDs: string[]): Map<string, Set<string>>;
    recordSwitch(sessionID: string, messageID: string, fromContextID: string | null, toContextID: string, confidence: number, reason: string, now: number): void;
    listMembershipEvents(sessionID: string, limit: number): ContextMembershipEvent[];
    listSwitchEvents(sessionID: string, limit: number): ContextSwitchEvent[];
    saveIntentBucketAssignments(sessionID: string, messageID: string, assignments: Omit<MessageIntentBucketAssignment, "sessionID" | "messageID" | "createdAt">[], now: number): void;
    listIntentBucketAssignments(sessionID: string, messageID: string, limit: number): MessageIntentBucketAssignment[];
    private previousIntentBucketMessageID;
    listIntentBucketAssignmentsWithDelta(sessionID: string, messageID: string, limit: number): MessageIntentBucketDebug;
    appendProgressionStep(sessionID: string, messageID: string, stepType: string, detailJSON: string, now: number): MessageProgressionStep;
    listProgressionSteps(sessionID: string, messageID: string, limit: number): MessageProgressionStep[];
    saveContextSnapshot(sessionID: string, messageID: string, snapshotKind: string, snapshotIndex: number, payloadJSON: string, now: number): ContextSnapshotRecord;
    listContextSnapshots(sessionID: string, messageID: string, snapshotKind: string | null, limit: number): ContextSnapshotRecord[];
    appendLaneEvent(sessionID: string, messageID: string, eventType: string, payloadJSON: string, now: number): LaneEventRecord;
    listLaneEventsAfter(sessionID: string, afterSeq: number, limit: number): LaneEventRecord[];
    setManualOverride(sessionID: string, contextID: string, expiresAt: number): void;
    clearManualOverride(sessionID: string): void;
    getManualOverride(sessionID: string, now: number): string | null;
}
