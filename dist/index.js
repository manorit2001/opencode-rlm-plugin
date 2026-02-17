import { getConfig } from "./lib/config.js";
import { computeFocusedContext } from "./lib/transform.js";
import { INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG, generateFocusedContextWithOpenCodeAuth, } from "./lib/opencode-bridge.js";
const FOCUSED_CONTEXT_TAG = "[RLM_FOCUSED_CONTEXT]";
function normalizeMessage(entry) {
    if (!entry || typeof entry !== "object") {
        return null;
    }
    const record = entry;
    const parts = Array.isArray(record.parts) ? record.parts : [];
    if (typeof record.role === "string") {
        return {
            id: typeof record.id === "string" ? record.id : undefined,
            role: record.role,
            parts,
        };
    }
    const info = record.info;
    if (!info || typeof info !== "object") {
        return null;
    }
    const infoRecord = info;
    if (typeof infoRecord.role !== "string") {
        return null;
    }
    return {
        id: typeof infoRecord.id === "string" ? infoRecord.id : undefined,
        role: infoRecord.role,
        parts,
    };
}
function normalizeMessages(response) {
    const root = response;
    const raw = Array.isArray(response) ? response : Array.isArray(root?.data) ? root.data : [];
    const normalized = [];
    for (const entry of raw) {
        const message = normalizeMessage(entry);
        if (!message) {
            continue;
        }
        normalized.push(message);
    }
    return normalized;
}
function prependFocusedContext(parts, focusedContext) {
    for (const part of parts) {
        if (!part || typeof part !== "object") {
            continue;
        }
        const record = part;
        if (record.type === "text" && typeof record.text === "string") {
            record.text = `${FOCUSED_CONTEXT_TAG}\n${focusedContext}\n\n${record.text}`;
            return;
        }
    }
}
function isInternalFocusedContextPrompt(parts) {
    for (const part of parts) {
        if (!part || typeof part !== "object") {
            continue;
        }
        const record = part;
        if (record.type !== "text" || typeof record.text !== "string") {
            continue;
        }
        if (record.text.startsWith(INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG)) {
            return true;
        }
    }
    return false;
}
const plugin = (async (ctx) => {
    const config = getConfig();
    return {
        "chat.message": async (_input, output) => {
            if (!config.enabled) {
                return;
            }
            const parts = output.parts;
            if (isInternalFocusedContextPrompt(parts)) {
                return;
            }
            let historyResponse;
            try {
                historyResponse = await ctx.client.session.messages({
                    path: { id: output.message.sessionID },
                });
            }
            catch (error) {
                if (process.env.RLM_PLUGIN_DEBUG === "1") {
                    console.error("RLM plugin failed to read session history", error);
                }
                return;
            }
            const history = normalizeMessages(historyResponse);
            if (history.length === 0) {
                return;
            }
            const run = config.backend === "opencode"
                ? await computeFocusedContext(history, config, null, async (archiveContext, latestGoal, runtimeConfig) => {
                    return generateFocusedContextWithOpenCodeAuth({
                        client: ctx.client,
                        sessionID: output.message.sessionID,
                        archiveContext,
                        latestGoal,
                        config: runtimeConfig,
                    });
                })
                : await computeFocusedContext(history, config, null);
            if (!run.compacted || !run.focusedContext) {
                return;
            }
            prependFocusedContext(parts, run.focusedContext);
        },
    };
});
export default plugin;
