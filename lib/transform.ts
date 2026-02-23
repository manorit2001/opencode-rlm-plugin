import type { ChatMessage, RecursiveConfig, RLMFocusedContext, TransformRun } from "./types.js"
import { estimateConversationTokens } from "./token-estimator.js"
import { generateFocusedContextWithRLM } from "./rlm-bridge.js"
import { detectContextDriftWithEmbeddings } from "./drift-embeddings.js"

const FOCUSED_CONTEXT_TAG = "[RLM_FOCUSED_CONTEXT]"

type RecursionTier = "shallow" | "deep"

export type FocusedContextGenerator = (
  archiveContext: string,
  latestGoal: string,
  config: RecursiveConfig,
) => Promise<RLMFocusedContext>

export type DriftDetector = (
  archiveContext: string,
  recentContext: string,
  latestGoal: string,
  config: RecursiveConfig,
) => Promise<{ drifted: boolean; score: number }>

function resolveContextLimit(contextLimitHint: number | null): number {
  if (typeof contextLimitHint === "number" && Number.isFinite(contextLimitHint) && contextLimitHint > 0) {
    return contextLimitHint
  }

  return 64000
}

function partToText(part: Record<string, unknown>): string {
  const text = part.text
  if (typeof text === "string") {
    return text
  }

  const input = part.input
  if (typeof input === "string") {
    return input
  }
  if (input && typeof input === "object") {
    return JSON.stringify(input)
  }

  const output = part.output
  if (typeof output === "string") {
    return output
  }
  if (output && typeof output === "object") {
    return JSON.stringify(output)
  }

  return JSON.stringify(part)
}

function messageToText(message: ChatMessage): string {
  const role = typeof message.role === "string" ? message.role : "unknown"
  const parts: unknown[] = Array.isArray(message.parts) ? message.parts : []
  const text = parts
    .map((part: unknown) => {
      if (!part || typeof part !== "object") {
        return ""
      }
      return partToText(part as Record<string, unknown>)
    })
    .filter((value: string) => value.length > 0)
    .join("\n")

  return `[${role}]\n${text}`
}

function isFocusedContextMessage(message: ChatMessage): boolean {
  const parts: unknown[] = Array.isArray(message.parts) ? message.parts : []
  return parts.some((part: unknown) => {
    if (!part || typeof part !== "object") {
      return false
    }

    const text = (part as Record<string, unknown>).text
    return typeof text === "string" && text.startsWith(FOCUSED_CONTEXT_TAG)
  })
}

function extractCompactedVector(message: ChatMessage): string | null {
  const parts: unknown[] = Array.isArray(message.parts) ? message.parts : []
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue
    }

    const text = (part as Record<string, unknown>).text
    if (typeof text !== "string" || !text.startsWith(FOCUSED_CONTEXT_TAG)) {
      continue
    }

    const normalized = text
      .slice(FOCUSED_CONTEXT_TAG.length)
      .trimStart()
      .trim()
    if (normalized.length === 0) {
      return null
    }

    if (!normalized.includes("\n\n")) {
      return null
    }

    return normalized
  }

  return null
}

function buildArchiveContext(messages: ChatMessage[], maxArchiveChars: number): string {
  let compactedVector: string | null = null
  let startIndex = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const vector = extractCompactedVector(messages[index])
    if (vector) {
      compactedVector = vector
      startIndex = index + 1
      break
    }
  }

  let remaining = maxArchiveChars
  const historicalChunks: string[] = []
  let vectorChunk: string | null = null

  if (compactedVector) {
    const serializedVector = `[assistant]\n${compactedVector}`
    const boundedVector =
      serializedVector.length > remaining
        ? serializedVector.slice(serializedVector.length - remaining)
        : serializedVector

    if (boundedVector.length > 0) {
      vectorChunk = boundedVector
      remaining -= boundedVector.length
    }
  }

  if (remaining <= 0) {
    return vectorChunk ?? ""
  }

  for (let index = messages.length - 1; index >= startIndex && remaining > 0; index -= 1) {
    const message = messages[index]
    if (isFocusedContextMessage(message)) {
      continue
    }

    const serialized = messageToText(message)
    if (serialized.length === 0) {
      continue
    }

    const bounded = serialized.length > remaining ? serialized.slice(serialized.length - remaining) : serialized
    historicalChunks.push(bounded)
    remaining -= bounded.length
  }

  historicalChunks.reverse()
  if (vectorChunk) {
    return [vectorChunk, ...historicalChunks].join("\n\n")
  }

  return historicalChunks.join("\n\n")
}

function latestUserGoal(messages: ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "user") {
      continue
    }

    const parts: unknown[] = Array.isArray(message.parts) ? message.parts : []
    for (const part of parts) {
      if (!part || typeof part !== "object") {
        continue
      }

      const text = (part as Record<string, unknown>).text
      if (typeof text === "string" && text.trim().length > 0) {
        return text.trim()
      }
    }
  }

  return "Continue the current software engineering task accurately."
}

function resolveRecursionTier(
  pressure: number,
  goal: string,
  config: RecursiveConfig,
): RecursionTier {
  const goalIsDense = goal.trim().length >= config.deepGoalMinChars
  if (pressure >= config.deepPressureThreshold && goalIsDense) {
    return "deep"
  }

  return "shallow"
}

function withShallowRecursion(config: RecursiveConfig): RecursiveConfig {
  return {
    ...config,
    maxDepth: Math.min(config.maxDepth, config.shallowMaxDepth),
    maxIterations: Math.min(config.maxIterations, config.shallowMaxIterations),
  }
}

export async function computeFocusedContext(
  messages: ChatMessage[],
  config: RecursiveConfig,
  contextLimitHint: number | null,
  generator: FocusedContextGenerator = generateFocusedContextWithRLM,
  driftDetector: DriftDetector = detectContextDriftWithEmbeddings,
): Promise<TransformRun> {
  const tokenEstimate = estimateConversationTokens(messages)
  const contextLimit = resolveContextLimit(contextLimitHint)
  const pressure = tokenEstimate / contextLimit

  const pressureTriggered = pressure >= config.pressureThreshold
  if (!pressureTriggered && !config.driftEmbeddingsEnabled) {
    return {
      compacted: false,
      focusedContext: null,
      tokenEstimate,
      pressure,
    }
  }

  if (messages.length <= config.keepRecentMessages) {
    return {
      compacted: false,
      focusedContext: null,
      tokenEstimate,
      pressure,
    }
  }

  const archiveMessages = messages.slice(0, messages.length - config.keepRecentMessages)
  const recentMessages = messages.slice(-config.keepRecentMessages)

  const archiveContext = buildArchiveContext(archiveMessages, config.maxArchiveChars)
  if (archiveContext.length === 0) {
    return {
      compacted: false,
      focusedContext: null,
      tokenEstimate,
      pressure,
    }
  }

  const goal = latestUserGoal(recentMessages)
  const recentContext = buildArchiveContext(
    recentMessages,
    Math.min(config.maxArchiveChars, config.driftEmbeddingMaxChars),
  )

  let driftTriggered = false
  if (!pressureTriggered && config.driftEmbeddingsEnabled && pressure >= config.driftMinPressure) {
    try {
      const drift = await driftDetector(archiveContext, recentContext, goal, config)
      driftTriggered = drift.drifted
    } catch (error) {
      if (process.env.RLM_PLUGIN_DEBUG === "1") {
        console.error("RLM plugin drift detector failed", error)
      }
    }
  }

  if (!pressureTriggered && !driftTriggered) {
    return {
      compacted: false,
      focusedContext: null,
      tokenEstimate,
      pressure,
    }
  }

  const recursionTier = resolveRecursionTier(pressure, goal, config)
  const generatorConfig = recursionTier === "deep" ? config : withShallowRecursion(config)

  let focusedContext: string
  try {
    const bridge = await generator(archiveContext, goal, generatorConfig)
    focusedContext = bridge.focusedContext.trim()
  } catch (error) {
    if (process.env.RLM_PLUGIN_DEBUG === "1") {
      console.error("RLM plugin failed to generate focused context", error)
    }
    return {
      compacted: false,
      focusedContext: null,
      tokenEstimate,
      pressure,
    }
  }

  if (focusedContext.length === 0) {
    return {
      compacted: false,
      focusedContext: null,
      tokenEstimate,
      pressure,
    }
  }

  return {
    compacted: true,
    focusedContext,
    tokenEstimate,
    pressure,
  }
}
