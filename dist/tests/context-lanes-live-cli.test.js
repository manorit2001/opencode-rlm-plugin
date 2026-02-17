import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const LIVE_TEST_FLAG = "RLM_PLUGIN_LIVE_LANE_CLI_TEST";
const MODEL_ID = "openai/gpt-5.1-codex-mini";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
function parseEvents(output) {
    const events = [];
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) {
            continue;
        }
        try {
            const parsed = JSON.parse(trimmed);
            events.push(parsed);
        }
        catch {
            continue;
        }
    }
    return events;
}
function extractSessionID(events) {
    for (const event of events) {
        if (typeof event.sessionID === "string" && event.sessionID.length > 0) {
            return event.sessionID;
        }
    }
    assert.fail("Could not find a sessionID in opencode JSON output");
}
function extractToolOutput(events, toolName) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const part = events[index]?.part;
        if (!part || part.type !== "tool" || part.tool !== toolName) {
            continue;
        }
        if (typeof part.state?.output === "string") {
            return part.state.output;
        }
    }
    assert.fail(`Could not find completed tool output for ${toolName}`);
}
function runTurn(prompt, env, sessionID) {
    const args = ["run", "--format", "json", "--model", MODEL_ID];
    if (sessionID) {
        args.push("--session", sessionID);
    }
    args.push(prompt);
    const completed = spawnSync("opencode", args, {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            ...env,
        },
        encoding: "utf8",
        timeout: 240_000,
        maxBuffer: 20 * 1024 * 1024,
    });
    if (completed.error) {
        assert.fail(`Failed to run opencode: ${completed.error.message}`);
    }
    const stdout = completed.stdout ?? "";
    const stderr = completed.stderr ?? "";
    if (completed.status !== 0) {
        assert.fail(`opencode exited with ${completed.status}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
    }
    const events = parseEvents(stdout);
    assert.ok(events.length > 0, `No JSON events were parsed from output:\n${stdout}`);
    const resolvedSessionID = sessionID ?? extractSessionID(events);
    return {
        sessionID: resolvedSessionID,
        events,
        combinedOutput: `${stdout}\n${stderr}`,
    };
}
function parseContextsOutput(output) {
    const primaryMatch = output.match(/Primary context:\s*([0-9a-f-]{36})/i);
    const contextIDs = Array.from(new Set(Array.from(output.matchAll(UUID_PATTERN), (match) => match[0])));
    return {
        primaryContextID: primaryMatch?.[1] ?? null,
        contextIDs,
    };
}
function escapeForRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const liveSkip = process.env[LIVE_TEST_FLAG] === "1"
    ? false
    : `Set ${LIVE_TEST_FLAG}=1 to run live lane-switch CLI integration test.`;
test("Live OpenCode session records manual lane switch using gpt-5.1-codex-mini", {
    skip: liveSkip,
    timeout: 600_000,
}, () => {
    const laneDir = mkdtempSync(join(tmpdir(), "rlm-lanes-live-cli-"));
    const env = {
        RLM_PLUGIN_DEBUG: "1",
        RLM_PLUGIN_LANES_ENABLED: "1",
        RLM_PLUGIN_LANES_DB_PATH: join(laneDir, "rlm-context-lanes.sqlite"),
        RLM_PLUGIN_LANE_MIN_TOKENS: "1",
        RLM_PLUGIN_LANE_PRIMARY_THRESHOLD: "0.2",
        RLM_PLUGIN_LANE_CREATION_THRESHOLD: "0.4",
        RLM_PLUGIN_LANE_SWITCH_MARGIN: "0.03",
    };
    try {
        const firstTurn = runTurn("Explain the CAP theorem in one short paragraph.", env);
        assert.match(firstTurn.combinedOutput, /RLM context lanes: using (node|bun):sqlite backend/);
        assert.doesNotMatch(firstTurn.combinedOutput, /sqlite backends unavailable, using in-memory store/i);
        const sessionID = firstTurn.sessionID;
        runTurn("Now write a tiny two-line poem about monsoon rain.", env, sessionID);
        let contextsTurn = runTurn("Use the contexts tool, then reply with exactly: contexts done", env, sessionID);
        let contextsOutput = extractToolOutput(contextsTurn.events, "contexts");
        let contextsSnapshot = parseContextsOutput(contextsOutput);
        if (contextsSnapshot.contextIDs.length < 2) {
            runTurn("Unrelated topic: list three JavaScript array methods.", env, sessionID);
            contextsTurn = runTurn("Use the contexts tool, then reply with exactly: contexts done", env, sessionID);
            contextsOutput = extractToolOutput(contextsTurn.events, "contexts");
            contextsSnapshot = parseContextsOutput(contextsOutput);
        }
        assert.ok(contextsSnapshot.primaryContextID, `Could not parse primary context from:\n${contextsOutput}`);
        assert.ok(contextsSnapshot.contextIDs.length >= 2, `Expected at least two contexts from:\n${contextsOutput}`);
        const primaryContextID = contextsSnapshot.primaryContextID;
        if (!primaryContextID) {
            assert.fail(`Primary context was missing from:\n${contextsOutput}`);
        }
        const switchTarget = contextsSnapshot.contextIDs.find((id) => id !== primaryContextID);
        assert.ok(switchTarget, `Could not find non-primary context in:\n${contextsOutput}`);
        if (!switchTarget) {
            assert.fail(`Could not determine switch target from:\n${contextsOutput}`);
        }
        const switchTurn = runTurn(`Use contexts-switch with contextID='${switchTarget}' and ttlMinutes=10, then reply with exactly: switch done`, env, sessionID);
        const switchOutput = extractToolOutput(switchTurn.events, "contexts-switch");
        assert.match(switchOutput, /override set/i);
        runTurn("Follow-up: summarize CAP theorem in one sentence.", env, sessionID);
        const eventsTurn = runTurn("Use contexts-events with limit=10, then reply with exactly: events done", env, sessionID);
        const eventsOutput = extractToolOutput(eventsTurn.events, "contexts-events");
        assert.match(eventsOutput, /reason=manual-override/);
        assert.match(eventsOutput, new RegExp(`->\\s*${escapeForRegex(switchTarget)}\\b`));
    }
    finally {
        rmSync(laneDir, { recursive: true, force: true });
    }
});
