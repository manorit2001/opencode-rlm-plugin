import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextLaneStore } from "../lib/context-lanes/store.js";
import { ContextLaneOrchestrator } from "../lib/context-lanes/orchestrator.js";
const BASE_CONFIG = {
    enabled: true,
    pressureThreshold: 0.72,
    deepPressureThreshold: 0.86,
    deepGoalMinChars: 120,
    driftEmbeddingsEnabled: false,
    driftMinPressure: 0.35,
    driftThreshold: 0.58,
    driftEmbeddingProvider: "ollama",
    driftEmbeddingModel: "embeddinggemma",
    driftEmbeddingBaseURL: "http://127.0.0.1:11434",
    driftEmbeddingTimeoutMs: 5000,
    driftEmbeddingMaxChars: 8000,
    laneRoutingEnabled: true,
    lanePrimaryThreshold: 0.25,
    laneSecondaryThreshold: 0.16,
    laneSwitchMargin: 0.06,
    laneMaxActive: 8,
    laneSummaryMaxChars: 1200,
    laneDbPath: "rlm-context-lanes.sqlite",
    keepRecentMessages: 2,
    maxArchiveChars: 60000,
    maxFocusedContextChars: 4500,
    pythonBin: "python3",
    backend: "opencode",
    model: "gpt-4.1-mini",
    environment: "local",
    opencodeProviderID: undefined,
    opencodeModelID: undefined,
    shallowMaxDepth: 1,
    shallowMaxIterations: 2,
    maxDepth: 3,
    maxIterations: 8,
    timeoutMs: 30000,
};
function textMessage(id, role, text) {
    return {
        id,
        role,
        parts: [{ type: "text", text }],
    };
}
function withStore(testBody) {
    const dir = mkdtempSync(join(tmpdir(), "rlm-lanes-"));
    const store = new ContextLaneStore(dir, "lane-state.sqlite");
    const orchestrator = new ContextLaneOrchestrator(store);
    return testBody(store, orchestrator).finally(() => {
        rmSync(dir, { recursive: true, force: true });
    });
}
test("orchestrator creates first context lane when no lane matches", async () => {
    await withStore(async (_store, orchestrator) => {
        const now = Date.now();
        const history = [
            textMessage("m1", "assistant", "Legacy log line"),
            textMessage("m2", "user", "Need backend migration updates"),
        ];
        const routed = orchestrator.route({
            sessionID: "session-a",
            messageID: "m2",
            latestUserText: "Need backend migration updates",
            history,
            config: BASE_CONFIG,
            now,
        });
        assert.equal(routed.selection.createdNewContext, true);
        assert.equal(routed.activeContextCount, 1);
        assert.equal(routed.selection.primaryContextID.length > 0, true);
        const contexts = orchestrator.listContexts("session-a", 10);
        assert.equal(contexts.length, 1);
        assert.ok(contexts[0].title.toLowerCase().includes("backend"));
    });
});
test("orchestrator supports multi-lane relevance and lane-scoped history", async () => {
    await withStore(async (store, orchestrator) => {
        const now = Date.now();
        const backend = store.createContext("session-b", "Backend Migration", "- keep opencode backend default and preserve cleanup in finally", now - 60_000);
        const tests = store.createContext("session-b", "Regression Tests", "- backend migration tests and bridge checks for keyless mode", now - 55_000);
        store.saveMemberships("session-b", "m1", [{ contextID: backend.id, relevance: 0.9, isPrimary: true }], now - 50_000);
        store.saveMemberships("session-b", "m2", [{ contextID: tests.id, relevance: 0.9, isPrimary: true }], now - 45_000);
        const history = [
            textMessage("m1", "assistant", "Keep backend default opencode and cleanup in finally."),
            textMessage("m2", "assistant", "Update bridge tests and migration checks for keyless mode."),
            textMessage("m3", "user", "Finalize backend migration and update bridge tests."),
        ];
        const routed = orchestrator.route({
            sessionID: "session-b",
            messageID: "m3",
            latestUserText: "Finalize backend migration and update bridge tests.",
            history,
            config: {
                ...BASE_CONFIG,
                laneSecondaryThreshold: 0.05,
            },
            now,
        });
        assert.equal(routed.selection.createdNewContext, false);
        assert.equal(routed.selection.secondaryContextIDs.length >= 1, true);
        const laneHistoryIDs = new Set(routed.laneHistory.map((message) => message.id).filter((id) => typeof id === "string"));
        assert.equal(laneHistoryIDs.has("m1"), true);
        assert.equal(laneHistoryIDs.has("m2"), true);
        assert.equal(laneHistoryIDs.has("m3"), true);
    });
});
test("orchestrator tracks active lane switches and emits switch events", async () => {
    await withStore(async (store, orchestrator) => {
        const now = Date.now();
        const backend = store.createContext("session-c", "Backend Migration", "- keep opencode backend default and preserve cleanup in finally", now - 120_000);
        const tests = store.createContext("session-c", "Regression Tests", "- update bridge tests and migration checks for keyless mode", now - 110_000);
        const historyA = [
            textMessage("c1", "assistant", "Keep backend default opencode and preserve cleanup in finally."),
            textMessage("c2", "user", "Finalize backend migration now."),
        ];
        const routeA = orchestrator.route({
            sessionID: "session-c",
            messageID: "c2",
            latestUserText: "Finalize backend migration now.",
            history: historyA,
            config: BASE_CONFIG,
            now,
        });
        assert.equal(routeA.selection.primaryContextID, backend.id);
        assert.equal(routeA.activeContextCount, 2);
        const historyB = [
            ...historyA,
            textMessage("c3", "assistant", "Bridge tests should cover keyless migration behavior."),
            textMessage("c4", "user", "Update regression tests and bridge checks before merge."),
        ];
        const routeB = orchestrator.route({
            sessionID: "session-c",
            messageID: "c4",
            latestUserText: "Update regression tests and bridge checks before merge.",
            history: historyB,
            config: {
                ...BASE_CONFIG,
                laneSwitchMargin: 0.02,
            },
            now: now + 20_000,
        });
        assert.equal(routeB.selection.primaryContextID, tests.id);
        const events = orchestrator.listSwitchEvents("session-c", 10);
        assert.ok(events.length >= 2);
        assert.equal(events[0].to, tests.id);
        assert.equal(events[0].from, backend.id);
        assert.equal(events[0].reason, "score-switch");
        assert.equal(events[1].to, backend.id);
    });
});
test("manual override pins primary lane until expiry", async () => {
    await withStore(async (store, orchestrator) => {
        const now = Date.now();
        const backend = store.createContext("session-d", "Backend Migration", "- keep backend default and cleanup", now - 60_000);
        const tests = store.createContext("session-d", "Regression Tests", "- update bridge tests and migration checks", now - 55_000);
        const pinned = orchestrator.switchContext("session-d", backend.id, 1, now);
        assert.equal(pinned, true);
        const history = [
            textMessage("d1", "assistant", "Bridge tests should be expanded."),
            textMessage("d2", "user", "Update regression tests and bridge checks."),
        ];
        const duringOverride = orchestrator.route({
            sessionID: "session-d",
            messageID: "d2",
            latestUserText: "Update regression tests and bridge checks.",
            history,
            config: BASE_CONFIG,
            now: now + 15_000,
        });
        assert.equal(duringOverride.selection.primaryContextID, backend.id);
        const afterExpiry = orchestrator.route({
            sessionID: "session-d",
            messageID: "d3",
            latestUserText: "Update regression tests and bridge checks.",
            history: [...history, textMessage("d3", "user", "Update regression tests and bridge checks.")],
            config: BASE_CONFIG,
            now: now + 80_000,
        });
        assert.equal(afterExpiry.selection.primaryContextID, tests.id);
    });
});
test("orchestrator falls back to full history when lane-specific history is too small", async () => {
    await withStore(async (store, orchestrator) => {
        const now = Date.now();
        const backend = store.createContext("session-e", "Backend Migration", "- keep backend default and cleanup", now - 60_000);
        const history = [
            textMessage("e1", "assistant", "Random unrelated note 1."),
            textMessage("e2", "assistant", "Random unrelated note 2."),
            textMessage("e3", "assistant", "Random unrelated note 3."),
            textMessage("e4", "user", "Finalize backend migration."),
        ];
        store.saveMemberships("session-e", "e4", [{ contextID: backend.id, relevance: 0.8, isPrimary: true }], now - 5_000);
        const routed = orchestrator.route({
            sessionID: "session-e",
            messageID: "e4",
            latestUserText: "Finalize backend migration.",
            history,
            config: { ...BASE_CONFIG, keepRecentMessages: 1 },
            now,
        });
        const routedIDs = routed.laneHistory
            .map((message) => message.id)
            .filter((id) => typeof id === "string");
        assert.deepEqual(routedIDs, ["e1", "e2", "e3", "e4"]);
    });
});
