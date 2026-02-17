import test from "node:test";
import assert from "node:assert/strict";
import { computeFocusedContext } from "../lib/transform.js";
const BASE_CONFIG = {
    enabled: true,
    pressureThreshold: 0.72,
    deepPressureThreshold: 0.86,
    deepGoalMinChars: 120,
    keepRecentMessages: 2,
    maxArchiveChars: 5000,
    maxFocusedContextChars: 400,
    pythonBin: "python3",
    backend: "opencode",
    model: "gpt-4.1-mini",
    environment: "local",
    shallowMaxDepth: 1,
    shallowMaxIterations: 2,
    maxDepth: 3,
    maxIterations: 8,
    timeoutMs: 10000,
};
function textMessage(role, text) {
    return {
        role,
        parts: [{ type: "text", text }],
    };
}
test("computeFocusedContext skips compaction when pressure is low", async () => {
    const messages = [
        textMessage("user", "Short prompt"),
        textMessage("assistant", "Short reply"),
    ];
    let called = false;
    const run = await computeFocusedContext(messages, BASE_CONFIG, 1_000_000, async () => {
        called = true;
        return { focusedContext: "unexpected" };
    });
    assert.equal(run.compacted, false);
    assert.equal(run.focusedContext, null);
    assert.equal(called, false);
});
test("computeFocusedContext uses shallow recursion for moderate pressure", async () => {
    const messages = [
        textMessage("assistant", "[RLM_FOCUSED_CONTEXT]\nstale summary"),
        textMessage("user", "Old constraint: preserve file layout."),
        textMessage("assistant", "Old finding: parser fails on null metadata."),
        textMessage("user", "Implement retry handling"),
        textMessage("assistant", "Acknowledged"),
    ];
    let archiveArg = "";
    let goalArg = "";
    let maxDepthArg = -1;
    let maxIterationsArg = -1;
    const run = await computeFocusedContext(messages, { ...BASE_CONFIG, pressureThreshold: 0.1, deepPressureThreshold: 0.9 }, 100, async function (archiveContext, latestGoal) {
        const runtimeConfig = arguments[2];
        archiveArg = archiveContext;
        goalArg = latestGoal;
        maxDepthArg = typeof runtimeConfig?.maxDepth === "number" ? runtimeConfig.maxDepth : -1;
        maxIterationsArg =
            typeof runtimeConfig?.maxIterations === "number" ? runtimeConfig.maxIterations : -1;
        return { focusedContext: "Focused: retry handling with backoff." };
    });
    assert.equal(run.compacted, true);
    assert.equal(run.focusedContext, "Focused: retry handling with backoff.");
    assert.equal(goalArg, "Implement retry handling");
    assert.equal(archiveArg.includes("stale summary"), false);
    assert.equal(archiveArg.includes("Old constraint: preserve file layout."), true);
    assert.equal(maxDepthArg, 1);
    assert.equal(maxIterationsArg, 2);
});
test("computeFocusedContext uses deep recursion for dense goals under high pressure", async () => {
    const denseGoal = "Refactor the command execution pipeline to split planner and executor responsibilities, add retry-aware telemetry fields, preserve existing API compatibility, and include migration notes for plugin consumers.";
    const messages = [
        textMessage("assistant", "Historical observation A"),
        textMessage("assistant", "Historical observation B"),
        textMessage("user", denseGoal),
    ];
    let maxDepthArg = -1;
    let maxIterationsArg = -1;
    const run = await computeFocusedContext(messages, {
        ...BASE_CONFIG,
        keepRecentMessages: 1,
        pressureThreshold: 0.1,
        deepPressureThreshold: 0.2,
        deepGoalMinChars: 40,
    }, 10, async function (_archiveContext, latestGoal) {
        const runtimeConfig = arguments[2];
        maxDepthArg = typeof runtimeConfig?.maxDepth === "number" ? runtimeConfig.maxDepth : -1;
        maxIterationsArg =
            typeof runtimeConfig?.maxIterations === "number" ? runtimeConfig.maxIterations : -1;
        assert.equal(latestGoal, denseGoal);
        return { focusedContext: "Focused: preserve API compatibility and add telemetry fields." };
    });
    assert.equal(run.compacted, true);
    assert.equal(maxDepthArg, BASE_CONFIG.maxDepth);
    assert.equal(maxIterationsArg, BASE_CONFIG.maxIterations);
});
test("computeFocusedContext returns no-op when generator throws", async () => {
    const messages = [
        textMessage("user", "Historic context A"),
        textMessage("assistant", "Historic context B"),
        textMessage("user", "Current goal"),
    ];
    const run = await computeFocusedContext(messages, { ...BASE_CONFIG, pressureThreshold: 0.1, keepRecentMessages: 1 }, 10, async () => {
        throw new Error("bridge failure");
    });
    assert.equal(run.compacted, false);
    assert.equal(run.focusedContext, null);
});
