import test from "node:test";
import assert from "node:assert/strict";
import { INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG, generateFocusedContextWithOpenCodeAuth, } from "../lib/opencode-bridge.js";
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
    lanePrimaryThreshold: 0.38,
    laneSecondaryThreshold: 0.3,
    laneSwitchMargin: 0.06,
    laneMaxActive: 8,
    laneSummaryMaxChars: 1200,
    laneSemanticEnabled: false,
    laneSemanticTopK: 4,
    laneSemanticWeight: 0.2,
    laneSemanticAmbiguityTopScore: 0.62,
    laneSemanticAmbiguityGap: 0.08,
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
test("generateFocusedContextWithOpenCodeAuth parses JSON and cleans up temp session", async () => {
    let parentSessionID = "";
    let promptSessionID = "";
    let deleteSessionID = "";
    let promptText = "";
    let providerID = "";
    let modelID = "";
    const client = {
        session: {
            create: async ({ body }) => {
                parentSessionID = body?.parentID ?? "";
                return { data: { id: "tmp-session" } };
            },
            prompt: async ({ path, body }) => {
                promptSessionID = path.id;
                promptText = body?.parts[0]?.text ?? "";
                providerID = body?.model?.providerID ?? "";
                modelID = body?.model?.modelID ?? "";
                return {
                    data: {
                        parts: [{ type: "text", text: '{"focused_context":"Use src/index.ts and keep retries."}' }],
                    },
                };
            },
            delete: async ({ path }) => {
                deleteSessionID = path.id;
                return { data: true };
            },
        },
    };
    const run = await generateFocusedContextWithOpenCodeAuth({
        client,
        sessionID: "main-session",
        archiveContext: "[assistant]\nHistoric note",
        latestGoal: "Implement retries",
        config: {
            ...BASE_CONFIG,
            opencodeProviderID: "openai",
            opencodeModelID: "gpt-4.1-mini",
        },
    });
    assert.equal(parentSessionID, "main-session");
    assert.equal(promptSessionID, "tmp-session");
    assert.equal(deleteSessionID, "tmp-session");
    assert.ok(promptText.startsWith(INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG));
    assert.equal(providerID, "openai");
    assert.equal(modelID, "gpt-4.1-mini");
    assert.equal(run.focusedContext, "Use src/index.ts and keep retries.");
});
test("generateFocusedContextWithOpenCodeAuth falls back to raw text and truncates", async () => {
    const client = {
        session: {
            create: async () => ({ data: { id: "tmp-session" } }),
            prompt: async () => ({ data: { parts: [{ type: "text", text: "abcdefghijklmnopqrstuvwxyz" }] } }),
            delete: async () => ({ data: true }),
        },
    };
    const run = await generateFocusedContextWithOpenCodeAuth({
        client,
        sessionID: "main-session",
        archiveContext: "[user]\nlarge context",
        latestGoal: "Short goal",
        config: { ...BASE_CONFIG, maxFocusedContextChars: 10 },
    });
    assert.equal(run.focusedContext, "abcdefghij");
});
test("generateFocusedContextWithOpenCodeAuth defaults to current session model when override is unset", async () => {
    let capturedModel = "unset";
    const client = {
        session: {
            create: async () => ({ data: { id: "tmp-session" } }),
            prompt: async ({ body }) => {
                capturedModel = body?.model;
                return { data: { parts: [{ type: "text", text: '{"focused_context":"Keep only active blockers."}' }] } };
            },
            delete: async () => ({ data: true }),
        },
    };
    const run = await generateFocusedContextWithOpenCodeAuth({
        client,
        sessionID: "main-session",
        archiveContext: "[assistant]\nold notes",
        latestGoal: "Ship a fix",
        config: { ...BASE_CONFIG, opencodeProviderID: undefined, opencodeModelID: undefined },
    });
    assert.equal(capturedModel, undefined);
    assert.equal(run.focusedContext, "Keep only active blockers.");
});
test("generateFocusedContextWithOpenCodeAuth deletes temp session after prompt failure", async () => {
    let deleteSessionID = "";
    const client = {
        session: {
            create: async () => ({ data: { id: "tmp-session" } }),
            prompt: async () => {
                throw new Error("prompt failed");
            },
            delete: async ({ path }) => {
                deleteSessionID = path.id;
                return { data: true };
            },
        },
    };
    await assert.rejects(async () => generateFocusedContextWithOpenCodeAuth({
        client,
        sessionID: "main-session",
        archiveContext: "[assistant]\nold",
        latestGoal: "Do thing",
        config: BASE_CONFIG,
    }), /prompt failed/);
    assert.equal(deleteSessionID, "tmp-session");
});
