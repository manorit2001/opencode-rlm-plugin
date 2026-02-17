import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextLaneStore } from "../lib/context-lanes/store.js";
import { ContextLaneOrchestrator } from "../lib/context-lanes/orchestrator.js";
import { scoreContextsForMessage, selectContextLanes } from "../lib/context-lanes/router.js";
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
    laneSemanticEnabled: false,
    laneSemanticTopK: 4,
    laneSemanticWeight: 0.2,
    laneSemanticAmbiguityTopScore: 0.62,
    laneSemanticAmbiguityGap: 0.08,
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
function withStore(testBody, fetchImpl) {
    const dir = mkdtempSync(join(tmpdir(), "rlm-lanes-"));
    const store = new ContextLaneStore(dir, "lane-state.sqlite");
    const orchestrator = new ContextLaneOrchestrator(store, fetchImpl);
    return testBody(store, orchestrator).finally(() => {
        rmSync(dir, { recursive: true, force: true });
    });
}
function embeddingForText(text) {
    const normalized = text.toLowerCase();
    if (normalized.includes("regression tests") || normalized.includes("coverage")) {
        return [1, 0];
    }
    if (normalized.includes("auth cleanup") || normalized.includes("token refresh")) {
        return [0, 1];
    }
    return [1, 0];
}
function semanticMockFetch() {
    return async (_input, init) => {
        const bodyRaw = typeof init?.body === "string" ? init.body : "{}";
        const body = JSON.parse(bodyRaw);
        if (Array.isArray(body.input)) {
            const embeddings = body.input.map((text) => embeddingForText(text));
            return new Response(JSON.stringify({ embeddings }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }
        const embedding = embeddingForText(body.prompt ?? "");
        return new Response(JSON.stringify({ embedding }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
}
test("orchestrator creates first context lane when no lane matches", async () => {
    await withStore(async (_store, orchestrator) => {
        const now = Date.now();
        const history = [
            textMessage("m1", "assistant", "Legacy log line"),
            textMessage("m2", "user", "Need backend migration updates"),
        ];
        const routed = await orchestrator.route({
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
        const routed = await orchestrator.route({
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
        const routeA = await orchestrator.route({
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
        const routeB = await orchestrator.route({
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
        const duringOverride = await orchestrator.route({
            sessionID: "session-d",
            messageID: "d2",
            latestUserText: "Update regression tests and bridge checks.",
            history,
            config: BASE_CONFIG,
            now: now + 15_000,
        });
        assert.equal(duringOverride.selection.primaryContextID, backend.id);
        const afterExpiry = await orchestrator.route({
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
        const routed = await orchestrator.route({
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
test("orchestrator applies semantic rerank for ambiguous lexical candidates", async () => {
    await withStore(async (store, orchestrator) => {
        const now = Date.now();
        const authLane = store.createContext("session-f", "Auth Cleanup", "- auth cleanup token refresh and migration checklist", now - 60_000);
        const testsLane = store.createContext("session-f", "Regression Tests", "- regression tests coverage migration checklist", now - 60_000);
        const history = [
            textMessage("f1", "assistant", "We need migration checklist updates."),
            textMessage("f2", "user", "Finalize migration checklist and coverage updates."),
        ];
        const routed = await orchestrator.route({
            sessionID: "session-f",
            messageID: "f2",
            latestUserText: "Finalize migration checklist and coverage updates.",
            history,
            config: {
                ...BASE_CONFIG,
                laneSemanticEnabled: true,
                laneSemanticWeight: 0.5,
                laneSemanticAmbiguityTopScore: 0.99,
                laneSemanticAmbiguityGap: 0.2,
            },
            now,
        });
        assert.equal(routed.selection.primaryContextID, testsLane.id);
        assert.notEqual(routed.selection.primaryContextID, authLane.id);
    }, semanticMockFetch());
});
test("orchestrator falls back to lexical selection when semantic embedding fails", async () => {
    let fetchCalls = 0;
    const failingFetch = async () => {
        fetchCalls += 1;
        throw new Error("embedding service unavailable");
    };
    await withStore(async (store, orchestrator) => {
        const now = Date.now();
        const backendLane = store.createContext("session-g", "Backend Migration", "- backend migration and bridge cleanup in finally", now - 40_000);
        store.createContext("session-g", "Regression Tests", "- regression tests and ci updates", now - 40_000);
        const latestUserText = "Finalize backend migration and cleanup in finally";
        const history = [textMessage("g1", "user", latestUserText)];
        const config = {
            ...BASE_CONFIG,
            laneSemanticEnabled: true,
            laneSemanticAmbiguityTopScore: 0.99,
            laneSemanticAmbiguityGap: 0.3,
            lanePrimaryThreshold: 0.2,
        };
        const contexts = store.listActiveContexts("session-g", config.laneMaxActive);
        const lexicalScores = scoreContextsForMessage(latestUserText, contexts, now);
        const expected = selectContextLanes(lexicalScores, null, config);
        const routed = await orchestrator.route({
            sessionID: "session-g",
            messageID: "g1",
            latestUserText,
            history,
            config,
            now,
        });
        assert.equal(fetchCalls > 0, true);
        assert.equal(routed.selection.primaryContextID, expected.primaryContextID);
        assert.equal(routed.selection.primaryContextID, backendLane.id);
    }, failingFetch);
});
