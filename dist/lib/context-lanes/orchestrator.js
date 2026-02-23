import { estimateConversationTokens } from "../token-estimator.js";
import { mergeSemanticScores, scoreContextsForMessage, selectContextLanes, shouldRunSemanticRerank, } from "./router.js";
import { computeSemanticSimilaritiesForTopCandidates } from "./semantic.js";
function cleanLine(input) {
    return input.replace(/\s+/g, " ").trim();
}
function firstSentence(input) {
    const cleaned = cleanLine(input);
    if (cleaned.length === 0) {
        return "";
    }
    const match = cleaned.match(/^(.{1,140}?)([.!?]|$)/);
    return (match?.[1] ?? cleaned).trim();
}
function titleFromMessage(text) {
    const words = cleanLine(text)
        .split(" ")
        .filter((word) => word.length > 0)
        .slice(0, 6);
    if (words.length === 0) {
        return "General Context";
    }
    return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}
function summarizeContext(existingSummary, latestMessage, maxChars) {
    const previous = existingSummary
        .split("\n")
        .map((line) => cleanLine(line))
        .filter((line) => line.length > 0)
        .slice(-7);
    const latest = firstSentence(latestMessage);
    const lines = [...previous];
    if (latest.length > 0 && !lines.includes(latest)) {
        lines.push(latest);
    }
    let summary = lines.map((line) => `- ${line}`).join("\n");
    if (summary.length > maxChars) {
        summary = summary.slice(summary.length - maxChars);
    }
    return summary.length > 0 ? summary : `- ${firstSentence(latestMessage) || "No summary yet"}`;
}
function toScoreMap(scores) {
    return new Map(scores.map((score) => [score.contextID, score.score]));
}
function buildMemberships(primaryContextID, secondaryContextIDs, scoreMap) {
    const memberships = [];
    memberships.push({
        contextID: primaryContextID,
        relevance: scoreMap.get(primaryContextID) ?? 1,
        isPrimary: true,
    });
    for (const contextID of secondaryContextIDs) {
        memberships.push({
            contextID,
            relevance: scoreMap.get(contextID) ?? 0.5,
            isPrimary: false,
        });
    }
    return memberships;
}
function recentMessageIDSet(history, keepRecentMessages) {
    const tail = history.slice(-keepRecentMessages);
    return new Set(tail.map((message) => message.id).filter((id) => typeof id === "string"));
}
function dedupeMessages(messages) {
    const seen = new Set();
    const deduped = [];
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const key = message.id ? `id:${message.id}` : `index:${index}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(message);
    }
    return deduped;
}
function clampRatio(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}
function applyTokenRetentionFloor(laneHistory, fullHistory, minimumTokenRatio) {
    const targetRatio = clampRatio(minimumTokenRatio);
    if (targetRatio <= 0 || laneHistory.length === 0 || fullHistory.length === 0) {
        return laneHistory;
    }
    const fullTokens = estimateConversationTokens(fullHistory);
    if (fullTokens <= 0) {
        return laneHistory;
    }
    const targetTokens = Math.ceil(fullTokens * targetRatio);
    let laneTokens = estimateConversationTokens(laneHistory);
    if (laneTokens >= targetTokens) {
        return laneHistory;
    }
    const includedIDs = new Set(laneHistory.map((message) => message.id).filter((id) => Boolean(id)));
    const includedObjects = new Set(laneHistory.filter((message) => !message.id));
    for (let index = fullHistory.length - 1; index >= 0 && laneTokens < targetTokens; index -= 1) {
        const message = fullHistory[index];
        if (message.id) {
            if (includedIDs.has(message.id)) {
                continue;
            }
            includedIDs.add(message.id);
        }
        else {
            if (includedObjects.has(message)) {
                continue;
            }
            includedObjects.add(message);
        }
        laneTokens += estimateConversationTokens([message]);
    }
    return fullHistory.filter((message) => {
        if (message.id) {
            return includedIDs.has(message.id);
        }
        return includedObjects.has(message);
    });
}
function contextForID(contexts, contextID) {
    return contexts.find((context) => context.id === contextID);
}
function buildOwnerRoutes(contexts, primaryContextID, secondaryContextIDs) {
    const selected = [primaryContextID, ...secondaryContextIDs];
    const routes = [];
    for (const contextID of selected) {
        const context = contextForID(contexts, contextID);
        if (!context?.ownerSessionID) {
            continue;
        }
        routes.push({
            ownerSessionID: context.ownerSessionID,
            contextID,
            contextTitle: context.title,
            isPrimary: contextID === primaryContextID,
        });
    }
    return routes;
}
export class ContextLaneOrchestrator {
    store;
    fetchImpl;
    createContextLaneSession;
    constructor(store, fetchImpl = fetch, createContextLaneSession) {
        this.store = store;
        this.fetchImpl = fetchImpl;
        this.createContextLaneSession = createContextLaneSession;
    }
    currentPrimaryContextID(sessionID) {
        return this.store.latestPrimaryContextID(sessionID);
    }
    activeContextCount(sessionID) {
        return this.store.countActiveContexts(sessionID);
    }
    async route(input) {
        const { sessionID, messageID, latestUserText, history, config, now } = input;
        const contexts = this.store.listActiveContexts(sessionID, config.laneMaxActive);
        const previousPrimaryContextID = this.store.latestPrimaryContextID(sessionID);
        let scoreRows = scoreContextsForMessage(latestUserText, contexts, now);
        if (shouldRunSemanticRerank(scoreRows, config)) {
            const contextByID = new Map(contexts.map((context) => [context.id, context]));
            const semanticByContextID = await computeSemanticSimilaritiesForTopCandidates(latestUserText, scoreRows, contextByID, config, this.fetchImpl);
            if (semanticByContextID.size > 0) {
                scoreRows = mergeSemanticScores(scoreRows, semanticByContextID, config);
            }
        }
        const scoreMap = toScoreMap(scoreRows);
        const selected = selectContextLanes(scoreRows, previousPrimaryContextID, config);
        const overrideContextID = this.store.getManualOverride(sessionID, now);
        let primaryContextID = selected.primaryContextID;
        let secondaryContextIDs = selected.secondaryContextIDs;
        let createdNewContext = false;
        const mutableContexts = [...contexts];
        if (overrideContextID && contextForID(mutableContexts, overrideContextID)) {
            primaryContextID = overrideContextID;
            secondaryContextIDs = secondaryContextIDs.filter((contextID) => contextID !== overrideContextID);
        }
        if (!primaryContextID) {
            let laneTitle = titleFromMessage(latestUserText);
            let preferredContextID;
            let ownerSessionID;
            if (this.createContextLaneSession) {
                try {
                    const createdSession = await this.createContextLaneSession({
                        rootSessionID: sessionID,
                        laneTitle,
                        latestUserText,
                        now,
                    });
                    const candidateID = createdSession?.contextID?.trim();
                    if (candidateID) {
                        preferredContextID = candidateID;
                        ownerSessionID = candidateID;
                    }
                    const candidateTitle = createdSession?.laneTitle?.trim();
                    if (candidateTitle) {
                        laneTitle = candidateTitle;
                    }
                }
                catch (error) {
                    if (process.env.RLM_PLUGIN_DEBUG === "1") {
                        console.error("RLM lane routing failed to create session-backed lane", error);
                    }
                }
            }
            const created = this.store.createContext(sessionID, laneTitle, summarizeContext("", latestUserText, config.laneSummaryMaxChars), now, preferredContextID, ownerSessionID);
            mutableContexts.push(created);
            primaryContextID = created.id;
            createdNewContext = true;
            scoreMap.set(created.id, 1);
        }
        const primaryContext = contextForID(mutableContexts, primaryContextID);
        if (primaryContext) {
            const nextSummary = summarizeContext(primaryContext.summary, latestUserText, config.laneSummaryMaxChars);
            this.store.updateContextSummary(sessionID, primaryContextID, nextSummary, now);
        }
        for (const contextID of secondaryContextIDs) {
            if (contextID === primaryContextID) {
                continue;
            }
            const context = contextForID(mutableContexts, contextID);
            if (!context) {
                continue;
            }
            this.store.updateContextSummary(sessionID, contextID, context.summary, now);
        }
        const memberships = buildMemberships(primaryContextID, secondaryContextIDs, scoreMap);
        this.store.saveMemberships(sessionID, messageID, memberships, now);
        if (previousPrimaryContextID !== primaryContextID) {
            this.store.recordSwitch(sessionID, messageID, previousPrimaryContextID, primaryContextID, scoreMap.get(primaryContextID) ?? 1, createdNewContext ? "created-new-context" : overrideContextID ? "manual-override" : "score-switch", now);
        }
        const selectedContextIDs = new Set([primaryContextID, ...secondaryContextIDs]);
        const messageIDs = history
            .map((message) => message.id)
            .filter((id) => typeof id === "string" && id.length > 0);
        const membershipMap = this.store.getMembershipContextMap(sessionID, messageIDs);
        const recentIDs = recentMessageIDSet(history, config.keepRecentMessages);
        const laneHistory = [];
        for (const message of history) {
            const messageIDFromHistory = message.id;
            const isRecent = messageIDFromHistory ? recentIDs.has(messageIDFromHistory) : false;
            const membershipSet = messageIDFromHistory ? membershipMap.get(messageIDFromHistory) : undefined;
            const matchesLane = membershipSet
                ? [...membershipSet].some((contextID) => selectedContextIDs.has(contextID))
                : false;
            if (isRecent || matchesLane) {
                laneHistory.push(message);
            }
        }
        const dedupedLaneHistory = dedupeMessages(laneHistory);
        const fullDedupedHistory = dedupeMessages(history);
        const minimumMessages = Math.max(config.keepRecentMessages + 2, 4);
        const effectiveHistory = dedupedLaneHistory.length >= minimumMessages
            ? applyTokenRetentionFloor(dedupedLaneHistory, fullDedupedHistory, config.laneMinHistoryTokenRatio ?? 0.75)
            : fullDedupedHistory;
        return {
            selection: {
                primaryContextID,
                secondaryContextIDs,
                scores: scoreRows,
                createdNewContext,
            },
            laneHistory: effectiveHistory,
            activeContextCount: this.store.countActiveContexts(sessionID),
            ownerRoutes: buildOwnerRoutes(mutableContexts, primaryContextID, secondaryContextIDs),
        };
    }
    listContexts(sessionID, limit = 20) {
        return this.store.listContexts(sessionID, limit);
    }
    listSwitchEvents(sessionID, limit = 20) {
        return this.store.listSwitchEvents(sessionID, limit).map((event) => ({
            from: event.fromContextID,
            to: event.toContextID,
            confidence: event.confidence,
            reason: event.reason,
            at: event.createdAt,
        }));
    }
    switchContext(sessionID, contextID, ttlMinutes, now) {
        const lane = this.store.getContext(sessionID, contextID);
        if (!lane || lane.status !== "active") {
            return false;
        }
        const ttlMs = Math.max(1, Math.floor(ttlMinutes)) * 60_000;
        this.store.setManualOverride(sessionID, contextID, now + ttlMs);
        return true;
    }
    clearManualOverride(sessionID) {
        this.store.clearManualOverride(sessionID);
    }
}
