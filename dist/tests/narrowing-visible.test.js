import test from "node:test";
import assert from "node:assert/strict";
import { computeFocusedContext } from "../lib/transform.js";
const BASE_CONFIG = {
    enabled: true,
    pressureThreshold: 0.1,
    deepPressureThreshold: 0.2,
    deepGoalMinChars: 20,
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
    laneDbPath: ".opencode/rlm-context-lanes.sqlite",
    keepRecentMessages: 1,
    maxArchiveChars: 1400,
    maxFocusedContextChars: 550,
    pythonBin: "python3",
    backend: "opencode",
    model: "gpt-5.3-codex",
    environment: "local",
    shallowMaxDepth: 1,
    shallowMaxIterations: 2,
    maxDepth: 3,
    maxIterations: 8,
    timeoutMs: 30000,
};
function textMessage(role, text) {
    return {
        role,
        parts: [{ type: "text", text }],
    };
}
const STOP_WORDS = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "only",
    "your",
    "have",
    "will",
    "about",
    "after",
    "before",
    "just",
]);
function tokenize(input) {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9_./-]+/g, " ")
        .split(/\s+/)
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}
function scoreLine(line, goalTokens) {
    const lower = line.toLowerCase();
    let score = 0;
    for (const token of goalTokens) {
        if (lower.includes(token)) {
            score += 2;
        }
    }
    if (/([a-z0-9_./-]+\.(ts|js|json|md|py))/.test(lower)) {
        score += 2;
    }
    if (/(retry|cleanup|session|backend|auth|apikey|api key|provider|model|hook|failure)/.test(lower)) {
        score += 2;
    }
    if (/(tailwind|gradient|font|color palette|hero section|marketing copy)/.test(lower)) {
        score -= 3;
    }
    return score;
}
function unique(items) {
    return [...new Set(items)];
}
function topLines(lines, goalTokens, keep) {
    return lines
        .map((line) => ({ line, score: scoreLine(line, goalTokens) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, keep)
        .map((item) => item.line);
}
function extractChunkLines(chunks) {
    return chunks.flatMap((chunk) => chunk
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("[")));
}
function recursiveSelectWithTrajectory(chunks, goalTokens, depth, maxDepth, iterationsLeft, state) {
    state.step += 1;
    const id = state.step;
    if (chunks.length === 0 || iterationsLeft <= 0) {
        return {
            selected: [],
            trajectory: {
                id,
                depth,
                chunkCount: chunks.length,
                iterationsLeft,
                phase: "empty",
                selected: [],
                children: [],
            },
        };
    }
    if (depth >= maxDepth || chunks.length <= 2) {
        const selected = topLines(extractChunkLines(chunks), goalTokens, 4);
        return {
            selected,
            trajectory: {
                id,
                depth,
                chunkCount: chunks.length,
                iterationsLeft,
                phase: "leaf",
                selected,
                children: [],
            },
        };
    }
    const mid = Math.ceil(chunks.length / 2);
    const left = recursiveSelectWithTrajectory(chunks.slice(0, mid), goalTokens, depth + 1, maxDepth, iterationsLeft - 1, state);
    const right = recursiveSelectWithTrajectory(chunks.slice(mid), goalTokens, depth + 1, maxDepth, iterationsLeft - 1, state);
    const selected = topLines(unique([...left.selected, ...right.selected]), goalTokens, 10);
    return {
        selected,
        trajectory: {
            id,
            depth,
            chunkCount: chunks.length,
            iterationsLeft,
            phase: "split",
            selected,
            children: [left.trajectory, right.trajectory],
        },
    };
}
function mockPaperStyleRLMWithTrajectory(archiveContext, latestGoal, config) {
    const chunks = archiveContext.split(/\n\n+/).filter((chunk) => chunk.trim().length > 0);
    const goalTokens = tokenize(latestGoal);
    const selection = recursiveSelectWithTrajectory(chunks, goalTokens, 0, config.maxDepth, config.maxIterations, { step: 0 });
    const fallback = selection.selected.length > 0 ? selection.selected : topLines(extractChunkLines(chunks), goalTokens, 6);
    const merged = [
        `Goal: ${latestGoal}`,
        "Actionable context:",
        ...fallback.map((line) => `- ${line}`),
    ].join("\n");
    return {
        preparedContext: merged.slice(0, config.maxFocusedContextChars),
        trajectory: selection.trajectory,
    };
}
function flattenTrajectory(root) {
    const nodes = [root];
    for (const child of root.children) {
        nodes.push(...flattenTrajectory(child));
    }
    return nodes;
}
function printTrajectory(root) {
    console.log("TRAJECTORY TREE");
    const visit = (node, indent) => {
        const preview = node.selected.slice(0, 2).join(" | ") || "(none)";
        console.log(`${indent}#${node.id} depth=${node.depth} phase=${node.phase} chunks=${node.chunkCount} iterations_left=${node.iterationsLeft} selected=${node.selected.length}`);
        console.log(`${indent}  preview: ${preview}`);
        for (const child of node.children) {
            visit(child, `${indent}  `);
        }
    };
    visit(root, "");
}
function wrap(text, width) {
    const words = text.replace(/\s+/g, " ").trim().split(" ");
    const lines = [];
    let current = "";
    for (const word of words) {
        if (!current) {
            current = word;
            continue;
        }
        if (`${current} ${word}`.length <= width) {
            current = `${current} ${word}`;
            continue;
        }
        lines.push(current);
        current = word;
    }
    if (current) {
        lines.push(current);
    }
    return lines;
}
function printSideBySide(noisy, prepared) {
    const width = 58;
    const left = wrap(noisy, width);
    const right = wrap(prepared, width);
    const rows = Math.max(left.length, right.length);
    const header = `${"NOISY ARCHIVE".padEnd(width)} | ${"PREPARED CONTEXT".padEnd(width)}`;
    const sep = `${"-".repeat(width)}-+-${"-".repeat(width)}`;
    console.log(header);
    console.log(sep);
    for (let i = 0; i < rows; i += 1) {
        console.log(`${(left[i] ?? "").padEnd(width)} | ${(right[i] ?? "").padEnd(width)}`);
    }
}
function buildRealisticMessages() {
    return [
        textMessage("user", "I copied a long terminal dump with npm warnings, lockfile churn, and shell history that is not tied to the current fix."),
        textMessage("assistant", "We can redesign the landing hero gradient, typography stack, and button color palette later."),
        textMessage("assistant", "Keep backend default to opencode in lib/config.ts so session auth is used without external provider keys."),
        textMessage("assistant", "In lib/opencode-bridge.ts preserve session cleanup in finally and keep temporary session deletion resilient."),
        textMessage("assistant", "tests/opencode-bridge.test.ts should verify model override is optional and defaults to active session model."),
        textMessage("user", "Finalize opencode-auth migration and make sure the plugin no longer depends on OPENAI_API_KEY for the default path."),
    ];
}
test("paper-style recursive narrowing keeps constraints and purges unrelated chatter", async () => {
    const messages = buildRealisticMessages();
    let noisyArchive = "";
    let preparedContext = "";
    let trajectory = null;
    const run = await computeFocusedContext(messages, BASE_CONFIG, 10, async (archiveContext, latestGoal, runtimeConfig) => {
        noisyArchive = archiveContext;
        const narrowed = mockPaperStyleRLMWithTrajectory(archiveContext, latestGoal, runtimeConfig);
        preparedContext = narrowed.preparedContext;
        trajectory = narrowed.trajectory;
        return { focusedContext: preparedContext };
    });
    assert.equal(run.compacted, true);
    assert.ok(preparedContext.includes("backend default to opencode"));
    assert.ok(preparedContext.includes("session cleanup"));
    assert.ok(preparedContext.includes("OPENAI_API_KEY"));
    assert.equal(/gradient|typography|color palette/.test(preparedContext.toLowerCase()), false);
    assert.ok(preparedContext.length <= BASE_CONFIG.maxFocusedContextChars);
    if (process.env.RLM_TEST_VERBOSE === "1") {
        printSideBySide(noisyArchive, preparedContext);
        if (trajectory && process.env.RLM_TEST_SHOW_TRAJECTORY === "1") {
            console.log("---");
            printTrajectory(trajectory);
        }
        console.log("---");
        console.log(`Archive chars: ${noisyArchive.length}`);
        console.log(`Prepared chars: ${preparedContext.length}`);
    }
});
test("paper-style recursive narrowing exposes trajectory tree nodes", async () => {
    const messages = buildRealisticMessages();
    let preparedContext = "";
    let trajectory = null;
    const run = await computeFocusedContext(messages, BASE_CONFIG, 10, async (archiveContext, latestGoal, runtimeConfig) => {
        const narrowed = mockPaperStyleRLMWithTrajectory(archiveContext, latestGoal, runtimeConfig);
        preparedContext = narrowed.preparedContext;
        trajectory = narrowed.trajectory;
        return { focusedContext: preparedContext };
    });
    assert.equal(run.compacted, true);
    if (!trajectory) {
        throw new Error("trajectory not captured");
    }
    const nodes = flattenTrajectory(trajectory);
    const splitNodes = nodes.filter((node) => node.phase === "split");
    const leafNodes = nodes.filter((node) => node.phase === "leaf");
    assert.ok(splitNodes.length >= 1);
    assert.ok(leafNodes.length >= 2);
    assert.ok(nodes.some((node) => node.depth >= 1));
    assert.ok(nodes.some((node) => node.selected.some((line) => /opencode|cleanup|openai_api_key|session model/i.test(line))));
    assert.equal(/gradient|typography|color palette/.test(preparedContext.toLowerCase()), false);
    if (process.env.RLM_TEST_VERBOSE === "1" && process.env.RLM_TEST_SHOW_TRAJECTORY === "1") {
        printTrajectory(trajectory);
    }
});
