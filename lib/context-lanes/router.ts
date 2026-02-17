import type { RecursiveConfig } from "../types.js"
import type { ContextLane, ContextLaneScore } from "./types.js"

interface LaneSelectionCandidate {
  primaryContextID: string | null
  secondaryContextIDs: string[]
  scores: ContextLaneScore[]
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.min(1, Math.max(0, value))
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
}

function overlapScore(messageTokens: string[], laneTokens: string[]): number {
  if (messageTokens.length === 0 || laneTokens.length === 0) {
    return 0
  }

  const messageSet = new Set(messageTokens)
  const laneSet = new Set(laneTokens)

  let intersection = 0
  for (const token of messageSet) {
    if (laneSet.has(token)) {
      intersection += 1
    }
  }

  const union = messageSet.size + laneSet.size - intersection
  const jaccard = union === 0 ? 0 : intersection / union
  const containment = intersection / messageSet.size

  return clamp01(0.55 * jaccard + 0.45 * containment)
}

function recencyBonus(now: number, lastActiveAt: number): number {
  const ageMs = Math.max(0, now - lastActiveAt)
  const oneHourMs = 60 * 60 * 1000
  const normalized = clamp01(1 - ageMs / oneHourMs)
  return 0.08 * normalized
}

export function scoreContextsForMessage(
  messageText: string,
  contexts: ContextLane[],
  now: number,
): ContextLaneScore[] {
  const messageTokens = tokenize(messageText)
  return contexts
    .map((context) => {
      const laneTokens = tokenize(`${context.title} ${context.summary}`)
      const lexical = overlapScore(messageTokens, laneTokens)
      const score = clamp01(lexical + recencyBonus(now, context.lastActiveAt))
      return {
        contextID: context.id,
        score,
        title: context.title,
      }
    })
    .sort((left, right) => right.score - left.score)
}

function scoreByContextID(scores: ContextLaneScore[]): Map<string, number> {
  return new Map(scores.map((score) => [score.contextID, score.score]))
}

export function selectContextLanes(
  scores: ContextLaneScore[],
  currentPrimaryContextID: string | null,
  config: RecursiveConfig,
): LaneSelectionCandidate {
  if (scores.length === 0) {
    return {
      primaryContextID: null,
      secondaryContextIDs: [],
      scores,
    }
  }

  const top = scores[0]
  if (top.score < config.lanePrimaryThreshold) {
    return {
      primaryContextID: null,
      secondaryContextIDs: [],
      scores,
    }
  }

  const scoreIndex = scoreByContextID(scores)
  let primaryContextID = top.contextID

  if (currentPrimaryContextID) {
    const currentScore = scoreIndex.get(currentPrimaryContextID) ?? 0
    const keepCurrent =
      currentScore >= config.laneSecondaryThreshold &&
      currentScore >= top.score - config.laneSwitchMargin

    if (keepCurrent) {
      primaryContextID = currentPrimaryContextID
    }
  }

  const primaryScore = scoreIndex.get(primaryContextID) ?? top.score
  const secondaryContextIDs = scores
    .filter((score) => score.contextID !== primaryContextID)
    .filter((score) => score.score >= config.laneSecondaryThreshold)
    .filter((score) => score.score >= primaryScore - 0.12)
    .slice(0, 2)
    .map((score) => score.contextID)

  return {
    primaryContextID,
    secondaryContextIDs,
    scores,
  }
}
