export const INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG = "[RLM_INTERNAL_FOCUSED_CONTEXT_PROMPT]";
function unwrapData(response) {
    if (!response || typeof response !== "object") {
        return response;
    }
    const record = response;
    if (record.error) {
        throw new Error(String(record.error));
    }
    if (Object.hasOwn(record, "data")) {
        return record.data;
    }
    return response;
}
function buildPrompt(archiveContext, latestGoal, maxChars) {
    return [
        INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG,
        "You are a focused-context engine for an autonomous coding assistant.",
        "Analyze the archived conversation and produce only what is needed for the next turn.",
        "Return JSON only with this exact schema: {\"focused_context\": string}",
        "Rules:",
        "- Include only actionable constraints, decisions, unresolved blockers, and concrete file paths.",
        "- Remove repetition and stale tool noise.",
        `- Keep focused_context under ${maxChars} characters.`,
        `Latest user goal: ${latestGoal}`,
        "Archived context:",
        archiveContext,
    ].join("\n");
}
function resolveModelOverride(config) {
    if (!config.opencodeProviderID || !config.opencodeModelID) {
        return undefined;
    }
    return {
        providerID: config.opencodeProviderID,
        modelID: config.opencodeModelID,
    };
}
function extractTextParts(parts) {
    if (!Array.isArray(parts)) {
        return [];
    }
    const collected = [];
    for (const part of parts) {
        if (!part || typeof part !== "object") {
            continue;
        }
        const record = part;
        if (record.type === "text" && typeof record.text === "string") {
            const value = record.text.trim();
            if (value.length > 0) {
                collected.push(value);
            }
        }
    }
    return collected;
}
function extractFocusedContextFromText(rawText, maxChars) {
    const trimmed = rawText.trim();
    if (trimmed.length === 0) {
        return "";
    }
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        return trimmed.slice(0, maxChars);
    }
    try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.focused_context === "string") {
            return parsed.focused_context.trim().slice(0, maxChars);
        }
    }
    catch {
        return trimmed.slice(0, maxChars);
    }
    return trimmed.slice(0, maxChars);
}
async function createTemporarySession(client, parentID) {
    const created = unwrapData(await client.session.create({
        body: {
            parentID,
            title: "RLM Focused Context (internal)",
        },
    }));
    if (!created || typeof created !== "object") {
        throw new Error("OpenCode bridge failed to create temporary session");
    }
    const sessionID = created.id;
    if (typeof sessionID !== "string" || sessionID.length === 0) {
        throw new Error("OpenCode bridge returned invalid temporary session id");
    }
    return sessionID;
}
export async function generateFocusedContextWithOpenCodeAuth(input) {
    const { client, sessionID, archiveContext, latestGoal, config } = input;
    const tempSessionID = await createTemporarySession(client, sessionID);
    try {
        const prompt = buildPrompt(archiveContext, latestGoal, config.maxFocusedContextChars);
        const modelOverride = resolveModelOverride(config);
        const promptBody = {
            parts: [{ type: "text", text: prompt }],
        };
        if (modelOverride) {
            promptBody.model = modelOverride;
        }
        const rawResponse = await client.session.prompt({
            path: { id: tempSessionID },
            body: promptBody,
        });
        const response = unwrapData(rawResponse);
        const textParts = extractTextParts(response.parts);
        const merged = textParts.join("\n\n");
        const focusedContext = extractFocusedContextFromText(merged, config.maxFocusedContextChars);
        if (focusedContext.length === 0) {
            throw new Error("OpenCode bridge returned empty focused context");
        }
        return { focusedContext };
    }
    finally {
        try {
            unwrapData(await client.session.delete({ path: { id: tempSessionID } }));
        }
        catch (error) {
            if (process.env.RLM_PLUGIN_DEBUG === "1") {
                console.error("RLM plugin failed to delete temporary OpenCode session", error);
            }
        }
    }
}
