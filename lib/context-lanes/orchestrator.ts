import type { ChatMessage } from "../types.js"
import {
  mergeSemanticScores,
  scoreContextsForMessage,
  selectContextLanes,
  shouldRunSemanticRerank,
} from "./router.js"
import { computeSemanticSimilaritiesForTopCandidates } from "./semantic.js"
import { ContextLaneStore } from "./store.js"
import type {
  ContextLane,
  ContextRoutingInput,
  ContextRoutingResult,
  MessageContextMembership,
} from "./types.js"

function cleanLine(input: string): string {
  return input.replace(/\s+/g, " ").trim()
}

function firstSentence(input: string): string {
  const cleaned = cleanLine(input)
  if (cleaned.length === 0) {
    return ""
  }

  const match = cleaned.match(/^(.{1,140}?)([.!?]|$)/)
  return (match?.[1] ?? cleaned).trim()
}

function titleFromMessage(text: string): string {
  const words = cleanLine(text)
    .split(" ")
    .filter((word) => word.length > 0)
    .slice(0, 6)
  if (words.length === 0) {
    return "General Context"
  }

  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ")
}

function summarizeContext(existingSummary: string, latestMessage: string, maxChars: number): string {
  const previous = existingSummary
    .split("\n")
    .map((line) => cleanLine(line))
    .filter((line) => line.length > 0)
    .slice(-7)
  const latest = firstSentence(latestMessage)

  const lines = [...previous]
  if (latest.length > 0 && !lines.includes(latest)) {
    lines.push(latest)
  }

  let summary = lines.map((line) => `- ${line}`).join("\n")
  if (summary.length > maxChars) {
    summary = summary.slice(summary.length - maxChars)
  }

  return summary.length > 0 ? summary : `- ${firstSentence(latestMessage) || "No summary yet"}`
}

function toScoreMap(scores: Array<{ contextID: string; score: number }>): Map<string, number> {
  return new Map(scores.map((score) => [score.contextID, score.score]))
}

function buildMemberships(
  primaryContextID: string,
  secondaryContextIDs: string[],
  scoreMap: Map<string, number>,
): MessageContextMembership[] {
  const memberships: MessageContextMembership[] = []

  memberships.push({
    contextID: primaryContextID,
    relevance: scoreMap.get(primaryContextID) ?? 1,
    isPrimary: true,
  })

  for (const contextID of secondaryContextIDs) {
    memberships.push({
      contextID,
      relevance: scoreMap.get(contextID) ?? 0.5,
      isPrimary: false,
    })
  }

  return memberships
}

function recentMessageIDSet(history: ChatMessage[], keepRecentMessages: number): Set<string> {
  const tail = history.slice(-keepRecentMessages)
  return new Set(tail.map((message) => message.id).filter((id): id is string => typeof id === "string"))
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>()
  const deduped: ChatMessage[] = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const key = message.id ? `id:${message.id}` : `index:${index}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(message)
  }

  return deduped
}

function contextForID(contexts: ContextLane[], contextID: string): ContextLane | undefined {
  return contexts.find((context) => context.id === contextID)
}

export class ContextLaneOrchestrator {
  constructor(
    private readonly store: ContextLaneStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  currentPrimaryContextID(sessionID: string): string | null {
    return this.store.latestPrimaryContextID(sessionID)
  }

  activeContextCount(sessionID: string): number {
    return this.store.countActiveContexts(sessionID)
  }

  async route(input: ContextRoutingInput): Promise<ContextRoutingResult> {
    const { sessionID, messageID, latestUserText, history, config, now } = input
    const contexts = this.store.listActiveContexts(sessionID, config.laneMaxActive)
    const previousPrimaryContextID = this.store.latestPrimaryContextID(sessionID)
    let scoreRows = scoreContextsForMessage(latestUserText, contexts, now)

    if (shouldRunSemanticRerank(scoreRows, config)) {
      const contextByID = new Map(contexts.map((context) => [context.id, context]))
      const semanticByContextID = await computeSemanticSimilaritiesForTopCandidates(
        latestUserText,
        scoreRows,
        contextByID,
        config,
        this.fetchImpl,
      )

      if (semanticByContextID.size > 0) {
        scoreRows = mergeSemanticScores(scoreRows, semanticByContextID, config)
      }
    }

    const scoreMap = toScoreMap(scoreRows)

    const selected = selectContextLanes(scoreRows, previousPrimaryContextID, config)
    const overrideContextID = this.store.getManualOverride(sessionID, now)

    let primaryContextID = selected.primaryContextID
    let secondaryContextIDs = selected.secondaryContextIDs
    let createdNewContext = false
    const mutableContexts = [...contexts]

    if (overrideContextID && contextForID(mutableContexts, overrideContextID)) {
      primaryContextID = overrideContextID
      secondaryContextIDs = secondaryContextIDs.filter((contextID) => contextID !== overrideContextID)
    }

    if (!primaryContextID) {
      const created = this.store.createContext(
        sessionID,
        titleFromMessage(latestUserText),
        summarizeContext("", latestUserText, config.laneSummaryMaxChars),
        now,
      )
      mutableContexts.push(created)
      primaryContextID = created.id
      createdNewContext = true
      scoreMap.set(created.id, 1)
    }

    const primaryContext = contextForID(mutableContexts, primaryContextID)
    if (primaryContext) {
      const nextSummary = summarizeContext(primaryContext.summary, latestUserText, config.laneSummaryMaxChars)
      this.store.updateContextSummary(sessionID, primaryContextID, nextSummary, now)
    }

    for (const contextID of secondaryContextIDs) {
      if (contextID === primaryContextID) {
        continue
      }

      const context = contextForID(mutableContexts, contextID)
      if (!context) {
        continue
      }

      this.store.updateContextSummary(sessionID, contextID, context.summary, now)
    }

    const memberships = buildMemberships(primaryContextID, secondaryContextIDs, scoreMap)
    this.store.saveMemberships(sessionID, messageID, memberships, now)

    if (previousPrimaryContextID !== primaryContextID) {
      this.store.recordSwitch(
        sessionID,
        messageID,
        previousPrimaryContextID,
        primaryContextID,
        scoreMap.get(primaryContextID) ?? 1,
        createdNewContext ? "created-new-context" : overrideContextID ? "manual-override" : "score-switch",
        now,
      )
    }

    const selectedContextIDs = new Set<string>([primaryContextID, ...secondaryContextIDs])
    const messageIDs = history
      .map((message) => message.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
    const membershipMap = this.store.getMembershipContextMap(sessionID, messageIDs)
    const recentIDs = recentMessageIDSet(history, config.keepRecentMessages)

    const laneHistory: ChatMessage[] = []
    for (const message of history) {
      const messageIDFromHistory = message.id
      const isRecent = messageIDFromHistory ? recentIDs.has(messageIDFromHistory) : false
      const membershipSet = messageIDFromHistory ? membershipMap.get(messageIDFromHistory) : undefined
      const matchesLane = membershipSet
        ? [...membershipSet].some((contextID) => selectedContextIDs.has(contextID))
        : false

      if (isRecent || matchesLane) {
        laneHistory.push(message)
      }
    }

    const dedupedLaneHistory = dedupeMessages(laneHistory)
    const minimumMessages = Math.max(config.keepRecentMessages + 2, 4)
    const effectiveHistory =
      dedupedLaneHistory.length >= minimumMessages ? dedupedLaneHistory : dedupeMessages(history)

    return {
      selection: {
        primaryContextID,
        secondaryContextIDs,
        scores: scoreRows,
        createdNewContext,
      },
      laneHistory: effectiveHistory,
      activeContextCount: this.store.countActiveContexts(sessionID),
    }
  }

  listContexts(sessionID: string, limit = 20): ContextLane[] {
    return this.store.listContexts(sessionID, limit)
  }

  listSwitchEvents(sessionID: string, limit = 20): Array<{ from: string | null; to: string; confidence: number; reason: string; at: number }> {
    return this.store.listSwitchEvents(sessionID, limit).map((event) => ({
      from: event.fromContextID,
      to: event.toContextID,
      confidence: event.confidence,
      reason: event.reason,
      at: event.createdAt,
    }))
  }

  switchContext(sessionID: string, contextID: string, ttlMinutes: number, now: number): boolean {
    const lane = this.store.getContext(sessionID, contextID)
    if (!lane || lane.status !== "active") {
      return false
    }

    const ttlMs = Math.max(1, Math.floor(ttlMinutes)) * 60_000
    this.store.setManualOverride(sessionID, contextID, now + ttlMs)
    return true
  }

  clearManualOverride(sessionID: string): void {
    this.store.clearManualOverride(sessionID)
  }
}
