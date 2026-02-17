import test from "node:test";
import assert from "node:assert/strict";
import { computeDriftScore, detectContextDriftWithEmbeddings } from "../lib/drift-embeddings.js";
const BASE_CONFIG = {
    enabled: true,
    pressureThreshold: 0.72,
    deepPressureThreshold: 0.86,
    deepGoalMinChars: 120,
    driftEmbeddingsEnabled: true,
    driftMinPressure: 0.35,
    driftThreshold: 0.58,
    driftEmbeddingProvider: "ollama",
    driftEmbeddingModel: "embeddinggemma",
    driftEmbeddingBaseURL: "http://127.0.0.1:11434",
    driftEmbeddingTimeoutMs: 5000,
    driftEmbeddingMaxChars: 8000,
    laneRoutingEnabled: true,
    lanePrimaryThreshold: 0.38,
    laneSecondaryThreshold: 0.3,
    laneSwitchMargin: 0.06,
    laneMaxActive: 8,
    laneSummaryMaxChars: 1200,
    laneDbPath: ".opencode/rlm-context-lanes.sqlite",
    keepRecentMessages: 8,
    maxArchiveChars: 60000,
    maxFocusedContextChars: 400,
    pythonBin: "python3",
    backend: "opencode",
    model: "gpt-4.1-mini",
    environment: "local",
    shallowMaxDepth: 1,
    shallowMaxIterations: 2,
    maxDepth: 3,
    maxIterations: 8,
    timeoutMs: 30000,
};
function jsonResponse(payload) {
    return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => payload,
    };
}
test("computeDriftScore increases for stronger drift signatures", () => {
    const low = computeDriftScore({
        goalToArchive: 0.52,
        goalToRecent: 0.49,
        archiveToRecent: 0.58,
    });
    const high = computeDriftScore({
        goalToArchive: 0.94,
        goalToRecent: 0.21,
        archiveToRecent: 0.32,
    });
    assert.ok(high > low);
    assert.ok(high <= 1);
    assert.ok(low >= 0);
});
test("detectContextDriftWithEmbeddings detects drift with /api/embed response", async () => {
    const fetchMock = async (_url, _init) => {
        return jsonResponse({
            embeddings: [
                [1, 0],
                [0, 1],
                [0.98, 0.02],
            ],
        });
    };
    const drift = await detectContextDriftWithEmbeddings("archive mentions migration and opencode backend", "recent discusses unrelated ui color polishing", "finalize opencode auth migration", { ...BASE_CONFIG, driftThreshold: 0.45 }, fetchMock);
    assert.equal(drift.drifted, true);
    assert.ok(drift.score >= 0.45);
    assert.ok(drift.similarities.goalToArchive > drift.similarities.goalToRecent);
});
test("detectContextDriftWithEmbeddings falls back to /api/embeddings when /api/embed fails", async () => {
    let embedCalls = 0;
    let legacyCalls = 0;
    const fetchMock = async (url, _init) => {
        if (url.endsWith("/api/embed")) {
            embedCalls += 1;
            throw new Error("embed endpoint unavailable");
        }
        legacyCalls += 1;
        if (legacyCalls === 1) {
            return jsonResponse({ embedding: [1, 0] });
        }
        if (legacyCalls === 2) {
            return jsonResponse({ embedding: [0, 1] });
        }
        return jsonResponse({ embedding: [0.97, 0.03] });
    };
    const drift = await detectContextDriftWithEmbeddings("archive keeps backend migration constraints", "recent asks for unrelated css updates", "finish backend migration", { ...BASE_CONFIG, driftThreshold: 0.4 }, fetchMock);
    assert.equal(embedCalls, 1);
    assert.equal(legacyCalls, 3);
    assert.equal(drift.drifted, true);
});
test("detectContextDriftWithEmbeddings returns no-drift when disabled or provider is unsupported", async () => {
    let calls = 0;
    const fetchMock = async (_url, _init) => {
        calls += 1;
        return jsonResponse({ embeddings: [[1, 0], [1, 0], [1, 0]] });
    };
    const disabled = await detectContextDriftWithEmbeddings("archive", "recent", "goal", { ...BASE_CONFIG, driftEmbeddingsEnabled: false }, fetchMock);
    const unsupported = await detectContextDriftWithEmbeddings("archive", "recent", "goal", { ...BASE_CONFIG, driftEmbeddingProvider: "none" }, fetchMock);
    assert.equal(disabled.drifted, false);
    assert.equal(unsupported.drifted, false);
    assert.equal(calls, 0);
});
