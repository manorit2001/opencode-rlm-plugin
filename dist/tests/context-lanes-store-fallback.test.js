import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextLaneStore } from "../lib/context-lanes/store.js";
const require = createRequire(import.meta.url);
function hasNodeSqlite() {
    try {
        const loaded = require("node:sqlite");
        return typeof loaded.DatabaseSync === "function";
    }
    catch {
        return false;
    }
}
test("ContextLaneStore works with in-memory fallback when node:sqlite is disabled", () => {
    const previousDisableNode = process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE;
    const previousDisableGeneric = process.env.RLM_PLUGIN_DISABLE_SQLITE;
    process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE = "1";
    process.env.RLM_PLUGIN_DISABLE_SQLITE = "1";
    try {
        const dir = mkdtempSync(join(tmpdir(), "rlm-lanes-fallback-"));
        const store = new ContextLaneStore(dir, "lane-state.sqlite");
        const now = Date.now();
        const created = store.createContext("session-fallback", "Fallback Lane", "Initial fallback summary", now);
        const secondary = store.createContext("session-fallback", "Fallback Lane Secondary", "Secondary fallback summary", now + 250).id;
        store.createContext("session-alt", "Other Lane", "Alternative lane summary", now + 500);
        assert.equal(store.countActiveContexts("session-fallback"), 2);
        store.updateContextSummary("session-fallback", created.id, "Updated fallback summary", now + 1_000);
        const loaded = store.getContext("session-fallback", created.id);
        assert.ok(loaded);
        assert.equal(loaded?.summary, "Updated fallback summary");
        store.saveMemberships("session-fallback", "msg-1", [
            {
                contextID: created.id,
                relevance: 0.8,
                isPrimary: true,
            },
        ], now + 2_000);
        assert.equal(store.latestPrimaryContextID("session-fallback"), created.id);
        const membershipMap = store.getMembershipContextMap("session-fallback", ["msg-1"]);
        assert.equal(membershipMap.get("msg-1")?.has(created.id), true);
        const membershipEvents = store.listMembershipEvents("session-fallback", 10);
        assert.equal(membershipEvents.length, 1);
        assert.equal(membershipEvents[0]?.messageID, "msg-1");
        assert.equal(membershipEvents[0]?.contextID, created.id);
        assert.equal(membershipEvents[0]?.isPrimary, true);
        store.recordSwitch("session-fallback", "msg-1", null, created.id, 0.9, "created-new-context", now + 3_000);
        const switches = store.listSwitchEvents("session-fallback", 10);
        assert.equal(switches.length, 1);
        assert.equal(switches[0]?.toContextID, created.id);
        const sessions = store.listSessions(10);
        assert.equal(sessions.length, 2);
        assert.equal(sessions[0]?.sessionID, "session-fallback");
        assert.equal(sessions[1]?.sessionID, "session-alt");
        store.setManualOverride("session-fallback", created.id, now + 10_000);
        assert.equal(store.getManualOverride("session-fallback", now + 5_000), created.id);
        assert.equal(store.getManualOverride("session-fallback", now + 20_000), null);
        store.saveIntentBucketAssignments("session-fallback", "msg-1", [
            {
                bucketType: "primary",
                contextID: created.id,
                score: 0.91,
                bucketRank: 0,
                reason: "selected-primary",
            },
        ], now + 4_000);
        const intents = store.listIntentBucketAssignments("session-fallback", "msg-1", 10);
        assert.equal(intents.length, 1);
        assert.equal(intents[0]?.contextID, created.id);
        const firstIntentDebug = store.listIntentBucketAssignmentsWithDelta("session-fallback", "msg-1", 10);
        assert.equal(firstIntentDebug.previousBuckets.length, 0);
        assert.equal(firstIntentDebug.delta.previousMessageID, null);
        store.saveIntentBucketAssignments("session-fallback", "msg-2", [
            {
                bucketType: "primary",
                contextID: secondary,
                score: 0.94,
                bucketRank: 0,
                reason: "selected-primary",
            },
            {
                bucketType: "secondary",
                contextID: created.id,
                score: 0.9,
                bucketRank: 1,
                reason: "selected-secondary",
            },
        ], now + 4_200);
        const secondIntentDebug = store.listIntentBucketAssignmentsWithDelta("session-fallback", "msg-2", 10);
        assert.equal(secondIntentDebug.currentBuckets.length, 2);
        assert.equal(secondIntentDebug.previousBuckets.length, 1);
        assert.equal(secondIntentDebug.delta.previousMessageID, "msg-1");
        assert.equal(secondIntentDebug.delta.primaryChanged, true);
        assert.deepEqual(secondIntentDebug.delta.addedContextIDs, [secondary]);
        assert.deepEqual(secondIntentDebug.delta.removedContextIDs, []);
        assert.equal(secondIntentDebug.delta.changedContexts.length, 1);
        assert.equal(secondIntentDebug.delta.changedContexts[0]?.contextID, created.id);
        assert.equal(secondIntentDebug.delta.changedContexts[0]?.previousRank, 0);
        assert.equal(secondIntentDebug.delta.changedContexts[0]?.currentRank, 1);
        store.appendProgressionStep("session-fallback", "msg-1", "routing.completed", JSON.stringify({ primaryContextID: created.id }), now + 4_500);
        const steps = store.listProgressionSteps("session-fallback", "msg-1", 10);
        assert.equal(steps.length, 1);
        assert.equal(steps[0]?.stepType, "routing.completed");
        store.saveContextSnapshot("session-fallback", "msg-1", "model-input", 0, JSON.stringify({ historyMessages: 3 }), now + 5_000);
        const snapshots = store.listContextSnapshots("session-fallback", "msg-1", null, 10);
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0]?.snapshotKind, "model-input");
        store.appendLaneEvent("session-fallback", "msg-1", "context.prepared", JSON.stringify({ historyMessages: 3 }), now + 5_500);
        const events = store.listLaneEventsAfter("session-fallback", 0, 10);
        assert.equal(events.length, 1);
        assert.equal(events[0]?.eventType, "context.prepared");
    }
    finally {
        if (previousDisableNode === undefined) {
            delete process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE;
        }
        else {
            process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE = previousDisableNode;
        }
        if (previousDisableGeneric === undefined) {
            delete process.env.RLM_PLUGIN_DISABLE_SQLITE;
        }
        else {
            process.env.RLM_PLUGIN_DISABLE_SQLITE = previousDisableGeneric;
        }
    }
});
test("ContextLaneStore persists data when sqlite backend is available", { skip: !hasNodeSqlite() }, () => {
    const previousDisableNode = process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE;
    const previousDisableGeneric = process.env.RLM_PLUGIN_DISABLE_SQLITE;
    delete process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE;
    delete process.env.RLM_PLUGIN_DISABLE_SQLITE;
    const dir = mkdtempSync(join(tmpdir(), "rlm-lanes-sqlite-"));
    try {
        const store = new ContextLaneStore(dir, "lane-state.sqlite");
        const now = Date.now();
        const created = store.createContext("session-sqlite", "SQLite Lane", "Persisted summary", now, "child-session-sqlite", "child-session-sqlite");
        store.saveMemberships("session-sqlite", "msg-sqlite", [
            {
                contextID: created.id,
                relevance: 0.88,
                isPrimary: true,
            },
        ], now + 1_000);
        assert.equal(store.countActiveContexts("session-sqlite"), 1);
        const reopened = new ContextLaneStore(dir, "lane-state.sqlite");
        assert.equal(reopened.countActiveContexts("session-sqlite"), 1);
        const loaded = reopened.getContext("session-sqlite", created.id);
        assert.ok(loaded);
        assert.equal(loaded.summary, "Persisted summary");
        assert.equal(loaded.ownerSessionID, "child-session-sqlite");
        const secondary = reopened.createContext("session-sqlite", "SQLite Lane Secondary", "Secondary persisted summary", now + 1_500).id;
        const sessions = reopened.listSessions(10);
        assert.equal(sessions[0]?.sessionID, "session-sqlite");
        const membershipEvents = reopened.listMembershipEvents("session-sqlite", 10);
        assert.equal(membershipEvents.length, 1);
        assert.equal(membershipEvents[0]?.messageID, "msg-sqlite");
        assert.equal(membershipEvents[0]?.contextID, created.id);
        reopened.saveIntentBucketAssignments("session-sqlite", "msg-sqlite", [
            {
                bucketType: "primary",
                contextID: created.id,
                score: 0.88,
                bucketRank: 0,
                reason: "selected-primary",
            },
        ], now + 2_000);
        reopened.saveIntentBucketAssignments("session-sqlite", "msg-sqlite-2", [
            {
                bucketType: "primary",
                contextID: secondary,
                score: 0.92,
                bucketRank: 0,
                reason: "selected-primary",
            },
            {
                bucketType: "secondary",
                contextID: created.id,
                score: 0.89,
                bucketRank: 1,
                reason: "selected-secondary",
            },
        ], now + 2_100);
        reopened.appendProgressionStep("session-sqlite", "msg-sqlite", "routing.completed", JSON.stringify({ primaryContextID: created.id }), now + 2_500);
        reopened.saveContextSnapshot("session-sqlite", "msg-sqlite", "model-input", 0, JSON.stringify({ historyMessages: 2 }), now + 3_000);
        reopened.appendLaneEvent("session-sqlite", "msg-sqlite", "context.prepared", JSON.stringify({ historyMessages: 2 }), now + 3_500);
        const intents = reopened.listIntentBucketAssignments("session-sqlite", "msg-sqlite", 10);
        assert.equal(intents.length, 1);
        assert.equal(intents[0]?.bucketType, "primary");
        const intentDebug = reopened.listIntentBucketAssignmentsWithDelta("session-sqlite", "msg-sqlite-2", 10);
        assert.equal(intentDebug.previousBuckets.length, 1);
        assert.equal(intentDebug.delta.previousMessageID, "msg-sqlite");
        assert.equal(intentDebug.delta.primaryChanged, true);
        assert.deepEqual(intentDebug.delta.addedContextIDs, [secondary]);
        const steps = reopened.listProgressionSteps("session-sqlite", "msg-sqlite", 10);
        assert.equal(steps.length, 1);
        assert.equal(steps[0]?.stepOrder, 1);
        const snapshots = reopened.listContextSnapshots("session-sqlite", "msg-sqlite", null, 10);
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0]?.snapshotKind, "model-input");
        const events = reopened.listLaneEventsAfter("session-sqlite", 0, 10);
        assert.equal(events.length, 1);
        assert.equal(events[0]?.eventType, "context.prepared");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
        if (previousDisableNode === undefined) {
            delete process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE;
        }
        else {
            process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE = previousDisableNode;
        }
        if (previousDisableGeneric === undefined) {
            delete process.env.RLM_PLUGIN_DISABLE_SQLITE;
        }
        else {
            process.env.RLM_PLUGIN_DISABLE_SQLITE = previousDisableGeneric;
        }
    }
});
