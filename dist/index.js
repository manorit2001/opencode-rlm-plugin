import { tool } from "@opencode-ai/plugin/tool";
import { getConfig } from "./lib/config.js";
import { computeFocusedContext } from "./lib/transform.js";
import { estimateConversationTokens } from "./lib/token-estimator.js";
import { INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG, generateFocusedContextWithOpenCodeAuth, } from "./lib/opencode-bridge.js";
import { ContextLaneOrchestrator } from "./lib/context-lanes/orchestrator.js";
import { ContextLaneStore } from "./lib/context-lanes/store.js";
import { createSessionRuntimeStats, formatRuntimeStats, formatTokenEfficiencyStats, recordLaneTelemetry, } from "./lib/runtime-stats.js";
import { buildLaneVisualizationSnapshot } from "./lib/context-lanes/visualization.js";
import { startLaneVisualizationWebServer, } from "./lib/context-lanes/visualization-web.js";
const FOCUSED_CONTEXT_TAG = "[RLM_FOCUSED_CONTEXT]";
const INTERNAL_CONTEXT_HANDOFF_TAG = "[RLM_INTERNAL_CONTEXT_HANDOFF]";
function statsForSession(statsBySession, sessionID, now) {
    const existing = statsBySession.get(sessionID);
    if (existing) {
        return existing;
    }
    const created = createSessionRuntimeStats(now);
    statsBySession.set(sessionID, created);
    return created;
}
function unwrapData(response) {
    if (!response || typeof response !== "object") {
        return response;
    }
    const record = response;
    if (Object.hasOwn(record, "data")) {
        return record.data;
    }
    return response;
}
function normalizeLaneSessionTitle(prefix, laneTitle) {
    const cleanPrefix = (prefix ?? "Project").trim();
    const cleanTitle = laneTitle.trim();
    if (cleanPrefix.length === 0) {
        return cleanTitle;
    }
    if (cleanTitle.length === 0) {
        return cleanPrefix;
    }
    return `${cleanPrefix}: ${cleanTitle}`;
}
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
function isInternalPluginPrompt(parts) {
    for (const part of parts) {
        if (!part || typeof part !== "object") {
            continue;
        }
        const record = part;
        if (record.type !== "text" || typeof record.text !== "string") {
            continue;
        }
        if (record.text.startsWith(INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG) ||
            record.text.startsWith(INTERNAL_CONTEXT_HANDOFF_TAG)) {
            return true;
        }
    }
    return false;
}
function buildOwnerHandoffPrompt(rootSessionID, latestUserText, route) {
    const role = route.isPrimary ? "primary" : "secondary";
    return [
        INTERNAL_CONTEXT_HANDOFF_TAG,
        "This is an internal lane handoff message.",
        `Root session: ${rootSessionID}`,
        `Lane role: ${role}`,
        `Lane context ID: ${route.contextID}`,
        `Lane title: ${route.contextTitle}`,
        "Latest user message:",
        latestUserText,
        "Continue this subtask in this session with concrete next actions.",
    ].join("\n");
}
function textFromParts(parts) {
    const chunks = [];
    for (const part of parts) {
        if (!part || typeof part !== "object") {
            continue;
        }
        const record = part;
        if (record.type === "text" && typeof record.text === "string") {
            const text = record.text.trim();
            if (text.length > 0) {
                chunks.push(text);
            }
        }
    }
    return chunks.join("\n\n").trim();
}
function latestUserTextFromHistory(history) {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message.role !== "user") {
            continue;
        }
        const text = textFromParts(message.parts ?? []);
        if (text.length > 0) {
            return text;
        }
    }
    return "";
}
function formatContextsOutput(laneOrchestrator, sessionID, laneMaxActive) {
    const contexts = laneOrchestrator.listContexts(sessionID, laneMaxActive);
    const activeCount = laneOrchestrator.activeContextCount(sessionID);
    const primaryContextID = laneOrchestrator.currentPrimaryContextID(sessionID);
    if (contexts.length === 0) {
        return "No active contexts yet. A new context lane will be created automatically on the next routed message.";
    }
    const lines = [`Active contexts: ${activeCount}`, `Primary context: ${primaryContextID ?? "none"}`, "", "Contexts:"];
    for (const context of contexts) {
        const marker = context.id === primaryContextID ? "*" : "-";
        const summary = context.summary.replace(/\s+/g, " ").slice(0, 120);
        const owner = context.ownerSessionID ?? "none";
        lines.push(`${marker} ${context.id} | ${context.title} | owner=${owner} | msgs=${context.msgCount} | last=${context.lastActiveAt} | ${summary}`);
    }
    return lines.join("\n");
}
function formatSwitchEventsOutput(laneOrchestrator, sessionID, limit) {
    const events = laneOrchestrator.listSwitchEvents(sessionID, Math.min(limit, 50));
    if (events.length === 0) {
        return "No context switch events recorded yet.";
    }
    return events
        .map((event) => {
        const from = event.from ?? "none";
        return `${event.at}: ${from} -> ${event.to} (confidence=${event.confidence.toFixed(3)}, reason=${event.reason})`;
    })
        .join("\n");
}
function stringifyDetail(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return JSON.stringify({ error: "non-serializable-detail" });
    }
}
function historySnapshotPayload(history) {
    return history.map((message) => ({
        id: message.id ?? "",
        role: message.role ?? "unknown",
        text: textFromParts(message.parts ?? []),
    }));
}
function historySnapshotTailForScaffold(history, limit = 12) {
    const normalizedLimit = Math.max(1, Math.floor(limit));
    const start = Math.max(0, history.length - normalizedLimit);
    return history.slice(start).map((message) => {
        const text = textFromParts(message.parts ?? []);
        return {
            id: message.id ?? "",
            role: message.role ?? "unknown",
            textChars: text.length,
            textPreview: previewScaffoldText(text, 220),
        };
    });
}
function previewScaffoldText(value, maxChars) {
    const compact = value.replace(/\s+/g, " ").trim();
    if (compact.length <= maxChars) {
        return compact;
    }
    return `${compact.slice(0, maxChars)}...`;
}
function partsSnapshotPayload(parts) {
    const snapshots = [];
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (!part || typeof part !== "object") {
            snapshots.push({ index, type: "unknown", textChars: 0, textPreview: "" });
            continue;
        }
        const record = part;
        const type = typeof record.type === "string" ? record.type : "unknown";
        const text = typeof record.text === "string" ? record.text : "";
        snapshots.push({
            index,
            type,
            textChars: text.length,
            textPreview: previewScaffoldText(text, 280),
        });
    }
    return snapshots;
}
function parseDetailJSON(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return { error: "invalid-json", value };
    }
}
function delegationHintForSession(laneOrchestrator, sessionID) {
    const primaryContextID = laneOrchestrator.currentPrimaryContextID(sessionID);
    if (!primaryContextID) {
        return null;
    }
    const contexts = laneOrchestrator.listContexts(sessionID, 64);
    const primary = contexts.find((context) => context.id === primaryContextID);
    const ownerSessionID = primary?.ownerSessionID?.trim() ?? "";
    if (ownerSessionID.length === 0) {
        return null;
    }
    return `Delegation target: ${ownerSessionID} (open with: opencode -s ${ownerSessionID})`;
}
const plugin = (async (ctx) => {
    const config = getConfig();
    const laneStore = new ContextLaneStore(ctx.directory, config.laneDbPath);
    const laneOrchestrator = new ContextLaneOrchestrator(laneStore, fetch, config.laneBucketsUseSessions
        ? async ({ rootSessionID, laneTitle }) => {
            const title = normalizeLaneSessionTitle(config.laneSessionTitlePrefix, laneTitle);
            const createdRaw = await ctx.client.session.create({
                body: {
                    parentID: rootSessionID,
                    title,
                },
            });
            const created = unwrapData(createdRaw);
            if (!created || typeof created !== "object") {
                return { laneTitle: title };
            }
            const sessionID = created.id;
            if (typeof sessionID !== "string" || sessionID.trim().length === 0) {
                return { laneTitle: title };
            }
            return {
                contextID: sessionID,
                laneTitle: title,
            };
        }
        : undefined);
    const statsBySession = new Map();
    let laneVisualizationWeb = null;
    let laneVisualizationWebSignature = "";
    const notifyOwnerSessions = async (rootSessionID, latestUserText, ownerRoutes) => {
        if (latestUserText.trim().length === 0 || ownerRoutes.length === 0) {
            return;
        }
        const seenOwners = new Set();
        for (const route of ownerRoutes) {
            if (route.ownerSessionID === rootSessionID || seenOwners.has(route.ownerSessionID)) {
                continue;
            }
            seenOwners.add(route.ownerSessionID);
            try {
                await ctx.client.session.prompt({
                    path: { id: route.ownerSessionID },
                    body: {
                        parts: [
                            {
                                type: "text",
                                text: buildOwnerHandoffPrompt(rootSessionID, latestUserText, route),
                            },
                        ],
                    },
                });
            }
            catch (error) {
                if (process.env.RLM_PLUGIN_DEBUG === "1") {
                    console.error(`RLM plugin failed to notify owner session ${route.ownerSessionID}`, error);
                }
            }
        }
    };
    return {
        tool: {
            contexts: tool({
                description: "Show active context lanes and current primary lane",
                args: {},
                execute: async (_args, tctx) => {
                    return formatContextsOutput(laneOrchestrator, tctx.sessionID, config.laneMaxActive);
                },
            }),
            "contexts-switch": tool({
                description: "Temporarily force a primary context lane",
                args: {
                    contextID: tool.schema.string().min(1),
                    ttlMinutes: tool.schema.number().int().positive().optional(),
                },
                execute: async (args, tctx) => {
                    const ttlMinutes = args.ttlMinutes ?? 30;
                    const switched = laneOrchestrator.switchContext(tctx.sessionID, args.contextID, ttlMinutes, Date.now());
                    if (!switched) {
                        return `Context ${args.contextID} was not found or not active.`;
                    }
                    return `Context override set to ${args.contextID} for ${ttlMinutes} minute(s).`;
                },
            }),
            "contexts-clear-override": tool({
                description: "Clear manual context override and return to automatic routing",
                args: {},
                execute: async (_args, tctx) => {
                    laneOrchestrator.clearManualOverride(tctx.sessionID);
                    return "Context override cleared. Automatic routing is active.";
                },
            }),
            "contexts-events": tool({
                description: "Show recent context switch events",
                args: {
                    limit: tool.schema.number().int().positive().optional(),
                },
                execute: async (args, tctx) => {
                    return formatSwitchEventsOutput(laneOrchestrator, tctx.sessionID, args.limit ?? 10);
                },
            }),
            "contexts-stats": tool({
                description: "Show live RLM runtime stats for this session",
                args: {},
                execute: async (_args, tctx) => {
                    const stats = statsBySession.get(tctx.sessionID);
                    if (!stats) {
                        return "No runtime stats yet for this session. Send at least one message first.";
                    }
                    return formatRuntimeStats(stats, {
                        activeContextCount: laneOrchestrator.activeContextCount(tctx.sessionID),
                        primaryContextID: laneOrchestrator.currentPrimaryContextID(tctx.sessionID),
                        switchEventsCount: laneOrchestrator.listSwitchEvents(tctx.sessionID, 50).length,
                    });
                },
            }),
            "contexts-efficiency": tool({
                description: "Show estimated token savings from lane routing",
                args: {
                    switchWindow: tool.schema.number().int().positive().optional(),
                },
                execute: async (args, tctx) => {
                    const stats = statsBySession.get(tctx.sessionID);
                    if (!stats) {
                        return "No runtime stats yet for this session. Send at least one message first.";
                    }
                    const switchEvents = laneOrchestrator.listSwitchEvents(tctx.sessionID, Math.min(args.switchWindow ?? 50, 200));
                    return formatTokenEfficiencyStats(stats, {
                        activeContextCount: laneOrchestrator.activeContextCount(tctx.sessionID),
                        switchEvents,
                    });
                },
            }),
            "contexts-visualize": tool({
                description: "Start a web frontend that visualizes lane formation from lane sqlite data",
                args: {
                    sessionID: tool.schema.string().min(1).optional(),
                    host: tool.schema.string().optional(),
                    port: tool.schema.number().int().positive().optional(),
                    basePath: tool.schema.string().optional(),
                    sessionLimit: tool.schema.number().int().positive().optional(),
                    contextLimit: tool.schema.number().int().positive().optional(),
                    switchLimit: tool.schema.number().int().positive().optional(),
                    membershipLimit: tool.schema.number().int().positive().optional(),
                },
                execute: async (args, tctx) => {
                    const defaults = {
                        sessionID: (args.sessionID ?? tctx.sessionID).trim(),
                        sessionLimit: args.sessionLimit ?? config.laneVisualizationSessionLimit ?? 8,
                        contextLimit: args.contextLimit ?? config.laneVisualizationContextLimit ?? 16,
                        switchLimit: args.switchLimit ?? config.laneVisualizationSwitchLimit ?? 60,
                        membershipLimit: args.membershipLimit ?? config.laneVisualizationMembershipLimit ?? 240,
                    };
                    const host = (args.host ?? config.laneVisualizationWebHost ?? "127.0.0.1").trim() || "127.0.0.1";
                    const port = args.port ?? config.laneVisualizationWebPort ?? 3799;
                    const basePath = (args.basePath ?? config.laneVisualizationWebBasePath ?? "/").trim() || "/";
                    const signature = JSON.stringify({ host, port, basePath, defaults });
                    if (laneVisualizationWeb && laneVisualizationWebSignature === signature) {
                        const apiURL = `${laneVisualizationWeb.url}/api/snapshot`;
                        const eventsURL = `${laneVisualizationWeb.url}/api/events`;
                        const messageURL = `${laneVisualizationWeb.url}/api/message`;
                        const healthURL = `${laneVisualizationWeb.url}/health`;
                        const delegationHint = delegationHintForSession(laneOrchestrator, defaults.sessionID);
                        return [
                            `Lane visualization web frontend already running at ${laneVisualizationWeb.url}`,
                            `Snapshot API: ${apiURL}`,
                            `Events API: ${eventsURL}`,
                            `Message Debug API: ${messageURL}`,
                            `Health check: ${healthURL}`,
                            `Default session: ${defaults.sessionID || "none"}`,
                            ...(delegationHint ? [delegationHint] : []),
                            "Query params: sessionID, sessionLimit, contextLimit, switchLimit, membershipLimit",
                        ].join("\n");
                    }
                    if (laneVisualizationWeb) {
                        await laneVisualizationWeb.close();
                        laneVisualizationWeb = null;
                        laneVisualizationWebSignature = "";
                    }
                    laneVisualizationWeb = await startLaneVisualizationWebServer({
                        host,
                        port,
                        basePath,
                        defaults,
                        buildSnapshot: (options) => buildLaneVisualizationSnapshot(laneStore, laneOrchestrator, {
                            sessionID: options.sessionID ?? defaults.sessionID,
                            sessionLimit: options.sessionLimit ?? defaults.sessionLimit,
                            contextLimit: options.contextLimit ?? defaults.contextLimit,
                            switchLimit: options.switchLimit ?? defaults.switchLimit,
                            membershipLimit: options.membershipLimit ?? defaults.membershipLimit,
                        }),
                        listEventsAfter: (sessionID, afterSeq, limit) => laneStore.listLaneEventsAfter(sessionID, afterSeq, limit),
                        getMessageDebug: (sessionID, messageID, limit) => {
                            const intentDebug = laneStore.listIntentBucketAssignmentsWithDelta(sessionID, messageID, limit);
                            const snapshots = laneStore.listContextSnapshots(sessionID, messageID, null, limit);
                            const rawRequestScaffold = snapshots
                                .filter((snapshot) => snapshot.snapshotKind === "raw-request-scaffold")
                                .sort((left, right) => left.snapshotIndex - right.snapshotIndex)
                                .map((snapshot) => parseDetailJSON(snapshot.payloadJSON));
                            return {
                                intentBuckets: intentDebug.currentBuckets,
                                previousIntentBuckets: intentDebug.previousBuckets,
                                bucketDelta: intentDebug.delta,
                                progression: laneStore.listProgressionSteps(sessionID, messageID, limit),
                                snapshots,
                                rawRequestScaffold,
                            };
                        },
                    });
                    laneVisualizationWebSignature = signature;
                    const apiURL = `${laneVisualizationWeb.url}/api/snapshot`;
                    const eventsURL = `${laneVisualizationWeb.url}/api/events`;
                    const messageURL = `${laneVisualizationWeb.url}/api/message`;
                    const healthURL = `${laneVisualizationWeb.url}/health`;
                    const delegationHint = delegationHintForSession(laneOrchestrator, defaults.sessionID);
                    return [
                        `Lane visualization web frontend started at ${laneVisualizationWeb.url}`,
                        `Snapshot API: ${apiURL}`,
                        `Events API: ${eventsURL}`,
                        `Message Debug API: ${messageURL}`,
                        `Health check: ${healthURL}`,
                        `Default session: ${defaults.sessionID || "none"}`,
                        ...(delegationHint ? [delegationHint] : []),
                        "Query params: sessionID, sessionLimit, contextLimit, switchLimit, membershipLimit",
                    ].join("\n");
                },
            }),
            "contexts-visualize-stop": tool({
                description: "Stop the lane visualization web frontend server",
                args: {},
                execute: async () => {
                    if (!laneVisualizationWeb) {
                        return "Lane visualization web frontend is not running.";
                    }
                    const url = laneVisualizationWeb.url;
                    await laneVisualizationWeb.close();
                    laneVisualizationWeb = null;
                    laneVisualizationWebSignature = "";
                    return `Lane visualization web frontend stopped: ${url}`;
                },
            }),
        },
        "chat.message": async (_input, output) => {
            if (!config.enabled) {
                return;
            }
            const sessionID = output.message.sessionID;
            const now = Date.now();
            const messageID = output.message.id ?? `message-${now}`;
            const sessionStats = statsForSession(statsBySession, sessionID, now);
            sessionStats.messagesSeen += 1;
            sessionStats.lastSeenAt = now;
            const recordProgress = (stepType, detail) => {
                try {
                    const at = Date.now();
                    const detailJSON = stringifyDetail(detail);
                    laneStore.appendProgressionStep(sessionID, messageID, stepType, detailJSON, at);
                    laneStore.appendLaneEvent(sessionID, messageID, stepType, detailJSON, at);
                }
                catch (error) {
                    if (process.env.RLM_PLUGIN_DEBUG === "1") {
                        console.error("RLM plugin failed to persist progression event", error);
                    }
                }
            };
            const parts = output.parts;
            recordProgress("message.received", { partCount: parts.length });
            if (isInternalPluginPrompt(parts)) {
                sessionStats.lastDecision = "skipped-internal-focused-context-prompt";
                recordProgress("message.skipped.internal-prompt", { reason: "internal-focused-context-prompt" });
                return;
            }
            let historyResponse;
            try {
                historyResponse = await ctx.client.session.messages({
                    path: { id: sessionID },
                });
            }
            catch (error) {
                sessionStats.historyFetchFailures += 1;
                sessionStats.lastDecision = "skipped-history-fetch-failed";
                recordProgress("message.skipped.history-fetch-failed", { reason: "history-fetch-failed" });
                if (process.env.RLM_PLUGIN_DEBUG === "1") {
                    console.error("RLM plugin failed to read session history", error);
                }
                return;
            }
            const history = normalizeMessages(historyResponse);
            if (history.length === 0) {
                sessionStats.lastDecision = "skipped-empty-history";
                recordProgress("message.skipped.empty-history", { reason: "empty-history" });
                return;
            }
            recordProgress("history.loaded", { messages: history.length });
            const baselineTokenEstimate = estimateConversationTokens(history);
            sessionStats.lastBaselineTokenEstimate = baselineTokenEstimate;
            const latestUserText = textFromParts(parts) || latestUserTextFromHistory(history);
            let historyForTransform = history;
            let ownerRoutes = [];
            let routedPrimaryContextID = null;
            let routedSecondaryContextIDs = [];
            let laneTokenEstimate = null;
            if (config.laneRoutingEnabled && latestUserText.length > 0) {
                sessionStats.laneRoutingRuns += 1;
                const routed = await laneOrchestrator.route({
                    sessionID,
                    messageID,
                    latestUserText,
                    history,
                    config,
                    now,
                });
                historyForTransform = routed.laneHistory;
                ownerRoutes = routed.ownerRoutes;
                routedPrimaryContextID = routed.selection.primaryContextID;
                routedSecondaryContextIDs = routed.selection.secondaryContextIDs;
                if (routed.selection.createdNewContext) {
                    sessionStats.laneNewContextCount += 1;
                }
                const sortedScores = routed.selection.scores
                    .map((entry) => ({ contextID: entry.contextID, score: entry.score }))
                    .sort((left, right) => {
                    if (right.score !== left.score) {
                        return right.score - left.score;
                    }
                    return left.contextID.localeCompare(right.contextID);
                });
                laneStore.saveIntentBucketAssignments(sessionID, messageID, sortedScores.map((entry, index) => ({
                    bucketType: index === 0 ? "primary" : "secondary",
                    contextID: entry.contextID,
                    score: entry.score,
                    bucketRank: index,
                    reason: entry.contextID === routed.selection.primaryContextID ? "selected-primary" : "selected-secondary",
                })), now);
                if (process.env.RLM_PLUGIN_DEBUG === "1") {
                    const secondaries = routed.selection.secondaryContextIDs.join(",") || "none";
                    console.error(`RLM lane routing active=${routed.activeContextCount} primary=${routed.selection.primaryContextID} secondary=${secondaries} created=${routed.selection.createdNewContext}`);
                }
                laneTokenEstimate = estimateConversationTokens(historyForTransform);
                const laneSavedTokens = Math.max(0, baselineTokenEstimate - laneTokenEstimate);
                recordLaneTelemetry(sessionStats, {
                    at: now,
                    baselineTokens: baselineTokenEstimate,
                    laneScopedTokens: laneTokenEstimate,
                    historyMessages: history.length,
                    laneHistoryMessages: historyForTransform.length,
                    primaryContextID: routed.selection.primaryContextID,
                    createdNewContext: routed.selection.createdNewContext,
                });
                sessionStats.laneRoutingSamples += 1;
                sessionStats.totalBaselineTokens += baselineTokenEstimate;
                sessionStats.totalLaneScopedTokens += laneTokenEstimate;
                sessionStats.totalLaneSavedTokens += laneSavedTokens;
                sessionStats.lastLaneScopedTokenEstimate = laneTokenEstimate;
                sessionStats.lastLaneSavedTokens = laneSavedTokens;
                const primaryOwnerRoute = ownerRoutes.find((route) => route.isPrimary) ?? null;
                const delegation = primaryOwnerRoute
                    ? {
                        ownerSessionID: primaryOwnerRoute.ownerSessionID,
                        openCommand: `opencode -s ${primaryOwnerRoute.ownerSessionID}`,
                        mode: "reuse-existing-owner-session",
                    }
                    : null;
                recordProgress("routing.completed", {
                    primaryContextID: routed.selection.primaryContextID,
                    secondaryContextIDs: routed.selection.secondaryContextIDs,
                    createdNewContext: routed.selection.createdNewContext,
                    ownerRoutes,
                    laneHistoryMessages: historyForTransform.length,
                    delegation,
                });
                if (config.laneBucketsUseSessions) {
                    await notifyOwnerSessions(sessionID, latestUserText, ownerRoutes);
                    if (ownerRoutes.length > 0) {
                        recordProgress("delegation.notified-owner-session", {
                            ownerSessionIDs: ownerRoutes.map((route) => route.ownerSessionID),
                        });
                    }
                }
            }
            laneStore.saveContextSnapshot(sessionID, messageID, "model-input", 0, stringifyDetail({
                primaryContextID: routedPrimaryContextID,
                baselineTokenEstimate,
                laneTokenEstimate,
                history: historySnapshotPayload(historyForTransform),
            }), Date.now());
            laneStore.saveContextSnapshot(sessionID, messageID, "raw-request-scaffold", 0, stringifyDetail({
                stage: "before-compaction",
                latestUserTextChars: latestUserText.length,
                latestUserTextPreview: previewScaffoldText(latestUserText, 300),
                messageParts: partsSnapshotPayload(parts),
                historyTail: historySnapshotTailForScaffold(historyForTransform),
                formation: {
                    historyMessages: historyForTransform.length,
                    baselineTokenEstimate,
                    laneTokenEstimate,
                    primaryContextID: routedPrimaryContextID,
                    secondaryContextIDs: routedSecondaryContextIDs,
                    ownerRoutes: ownerRoutes.map((route) => ({
                        ownerSessionID: route.ownerSessionID,
                        contextID: route.contextID,
                        isPrimary: route.isPrimary,
                    })),
                },
                cacheStability: {
                    stablePrefix: FOCUSED_CONTEXT_TAG,
                    focusedContextApplied: false,
                },
            }), Date.now());
            recordProgress("request.scaffold.updated", {
                stage: "before-compaction",
                partCount: parts.length,
                historyMessages: historyForTransform.length,
            });
            recordProgress("context.prepared", {
                historyMessages: historyForTransform.length,
                primaryContextID: routedPrimaryContextID,
            });
            const run = config.backend === "opencode"
                ? await computeFocusedContext(historyForTransform, config, null, async (archiveContext, latestGoal, runtimeConfig) => {
                    return generateFocusedContextWithOpenCodeAuth({
                        client: ctx.client,
                        sessionID,
                        archiveContext,
                        latestGoal,
                        config: runtimeConfig,
                    });
                })
                : await computeFocusedContext(historyForTransform, config, null);
            sessionStats.transformRuns += 1;
            sessionStats.lastPressure = run.pressure;
            sessionStats.lastTokenEstimate = run.tokenEstimate;
            if (!run.compacted || !run.focusedContext) {
                sessionStats.compactionsSkipped += 1;
                sessionStats.lastFocusedChars = 0;
                sessionStats.lastDecision = run.pressure < config.pressureThreshold ? "skipped-pressure" : "skipped-no-focused-context";
                laneStore.saveContextSnapshot(sessionID, messageID, "raw-request-scaffold", 1, stringifyDetail({
                    stage: "final-model-input",
                    compacted: false,
                    reason: sessionStats.lastDecision,
                    pressure: run.pressure,
                    tokenEstimate: run.tokenEstimate,
                    messageParts: partsSnapshotPayload(parts),
                    cacheStability: {
                        stablePrefix: FOCUSED_CONTEXT_TAG,
                        focusedContextApplied: false,
                    },
                }), Date.now());
                recordProgress("request.scaffold.updated", {
                    stage: "final-model-input",
                    compacted: false,
                    reason: sessionStats.lastDecision,
                });
                recordProgress("compaction.skipped", {
                    pressure: run.pressure,
                    tokenEstimate: run.tokenEstimate,
                    reason: sessionStats.lastDecision,
                });
                return;
            }
            prependFocusedContext(parts, run.focusedContext);
            sessionStats.compactionsApplied += 1;
            sessionStats.lastFocusedChars = run.focusedContext.length;
            sessionStats.lastDecision = "compacted";
            laneStore.saveContextSnapshot(sessionID, messageID, "focused-context", 0, stringifyDetail({
                focusedContext: run.focusedContext,
                pressure: run.pressure,
                tokenEstimate: run.tokenEstimate,
            }), Date.now());
            laneStore.saveContextSnapshot(sessionID, messageID, "raw-request-scaffold", 1, stringifyDetail({
                stage: "final-model-input",
                compacted: true,
                pressure: run.pressure,
                tokenEstimate: run.tokenEstimate,
                focusedContextChars: run.focusedContext.length,
                focusedContextPreview: previewScaffoldText(run.focusedContext, 280),
                messageParts: partsSnapshotPayload(parts),
                cacheStability: {
                    stablePrefix: FOCUSED_CONTEXT_TAG,
                    focusedContextApplied: true,
                },
            }), Date.now());
            recordProgress("request.scaffold.updated", {
                stage: "final-model-input",
                compacted: true,
                focusedContextChars: run.focusedContext.length,
            });
            recordProgress("compaction.applied", {
                focusedContextChars: run.focusedContext.length,
                pressure: run.pressure,
                tokenEstimate: run.tokenEstimate,
            });
        },
    };
});
export default plugin;
