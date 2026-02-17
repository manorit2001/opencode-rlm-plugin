import { estimateConversationTokens } from "./token-estimator.js";
import { generateFocusedContextWithRLM } from "./rlm-bridge.js";
import { detectContextDriftWithEmbeddings } from "./drift-embeddings.js";
const FOCUSED_CONTEXT_TAG = "[RLM_FOCUSED_CONTEXT]";
function resolveContextLimit(contextLimitHint) {
    if (typeof contextLimitHint === "number" && Number.isFinite(contextLimitHint) && contextLimitHint > 0) {
        return contextLimitHint;
    }
    return 64000;
}
function partToText(part) {
    const text = part.text;
    if (typeof text === "string") {
        return text;
    }
    const input = part.input;
    if (typeof input === "string") {
        return input;
    }
    if (input && typeof input === "object") {
        return JSON.stringify(input);
    }
    const output = part.output;
    if (typeof output === "string") {
        return output;
    }
    if (output && typeof output === "object") {
        return JSON.stringify(output);
    }
    return JSON.stringify(part);
}
function messageToText(message) {
    const role = typeof message.role === "string" ? message.role : "unknown";
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const text = parts
        .map((part) => {
        if (!part || typeof part !== "object") {
            return "";
        }
        return partToText(part);
    })
        .filter((value) => value.length > 0)
        .join("\n");
    return `[${role}]\n${text}`;
}
function isFocusedContextMessage(message) {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    return parts.some((part) => {
        if (!part || typeof part !== "object") {
            return false;
        }
        const text = part.text;
        return typeof text === "string" && text.startsWith(FOCUSED_CONTEXT_TAG);
    });
}
function buildArchiveContext(messages, maxArchiveChars) {
    let remaining = maxArchiveChars;
    const chunks = [];
    for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
        const message = messages[index];
        if (isFocusedContextMessage(message)) {
            continue;
        }
        const serialized = messageToText(message);
        if (serialized.length === 0) {
            continue;
        }
        const bounded = serialized.length > remaining ? serialized.slice(serialized.length - remaining) : serialized;
        chunks.push(bounded);
        remaining -= bounded.length;
    }
    chunks.reverse();
    return chunks.join("\n\n");
}
function latestUserGoal(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "user") {
            continue;
        }
        const parts = Array.isArray(message.parts) ? message.parts : [];
        for (const part of parts) {
            if (!part || typeof part !== "object") {
                continue;
            }
            const text = part.text;
            if (typeof text === "string" && text.trim().length > 0) {
                return text.trim();
            }
        }
    }
    return "Continue the current software engineering task accurately.";
}
function resolveRecursionTier(pressure, goal, config) {
    const goalIsDense = goal.trim().length >= config.deepGoalMinChars;
    if (pressure >= config.deepPressureThreshold && goalIsDense) {
        return "deep";
    }
    return "shallow";
}
function withShallowRecursion(config) {
    return {
        ...config,
        maxDepth: Math.min(config.maxDepth, config.shallowMaxDepth),
        maxIterations: Math.min(config.maxIterations, config.shallowMaxIterations),
    };
}
export async function computeFocusedContext(messages, config, contextLimitHint, generator = generateFocusedContextWithRLM, driftDetector = detectContextDriftWithEmbeddings) {
    const tokenEstimate = estimateConversationTokens(messages);
    const contextLimit = resolveContextLimit(contextLimitHint);
    const pressure = tokenEstimate / contextLimit;
    const pressureTriggered = pressure >= config.pressureThreshold;
    if (!pressureTriggered && !config.driftEmbeddingsEnabled) {
        return {
            compacted: false,
            focusedContext: null,
            tokenEstimate,
            pressure,
        };
    }
    if (messages.length <= config.keepRecentMessages) {
        return {
            compacted: false,
            focusedContext: null,
            tokenEstimate,
            pressure,
        };
    }
    const archiveMessages = messages.slice(0, messages.length - config.keepRecentMessages);
    const recentMessages = messages.slice(-config.keepRecentMessages);
    const archiveContext = buildArchiveContext(archiveMessages, config.maxArchiveChars);
    if (archiveContext.length === 0) {
        return {
            compacted: false,
            focusedContext: null,
            tokenEstimate,
            pressure,
        };
    }
    const goal = latestUserGoal(recentMessages);
    const recentContext = buildArchiveContext(recentMessages, Math.min(config.maxArchiveChars, config.driftEmbeddingMaxChars));
    let driftTriggered = false;
    if (!pressureTriggered && config.driftEmbeddingsEnabled && pressure >= config.driftMinPressure) {
        try {
            const drift = await driftDetector(archiveContext, recentContext, goal, config);
            driftTriggered = drift.drifted;
        }
        catch (error) {
            if (process.env.RLM_PLUGIN_DEBUG === "1") {
                console.error("RLM plugin drift detector failed", error);
            }
        }
    }
    if (!pressureTriggered && !driftTriggered) {
        return {
            compacted: false,
            focusedContext: null,
            tokenEstimate,
            pressure,
        };
    }
    const recursionTier = resolveRecursionTier(pressure, goal, config);
    const generatorConfig = recursionTier === "deep" ? config : withShallowRecursion(config);
    let focusedContext;
    try {
        const bridge = await generator(archiveContext, goal, generatorConfig);
        focusedContext = bridge.focusedContext.trim();
    }
    catch (error) {
        if (process.env.RLM_PLUGIN_DEBUG === "1") {
            console.error("RLM plugin failed to generate focused context", error);
        }
        return {
            compacted: false,
            focusedContext: null,
            tokenEstimate,
            pressure,
        };
    }
    if (focusedContext.length === 0) {
        return {
            compacted: false,
            focusedContext: null,
            tokenEstimate,
            pressure,
        };
    }
    return {
        compacted: true,
        focusedContext,
        tokenEstimate,
        pressure,
    };
}
