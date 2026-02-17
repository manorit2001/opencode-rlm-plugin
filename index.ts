import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { getConfig } from "./lib/config.js"
import { computeFocusedContext } from "./lib/transform.js"
import {
  INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG,
  generateFocusedContextWithOpenCodeAuth,
} from "./lib/opencode-bridge.js"
import { ContextLaneOrchestrator } from "./lib/context-lanes/orchestrator.js"
import { ContextLaneStore } from "./lib/context-lanes/store.js"
import type { ChatMessage } from "./lib/types.js"
import { createSessionRuntimeStats, formatRuntimeStats, type SessionRuntimeStats } from "./lib/runtime-stats.js"

const FOCUSED_CONTEXT_TAG = "[RLM_FOCUSED_CONTEXT]"

function statsForSession(
  statsBySession: Map<string, SessionRuntimeStats>,
  sessionID: string,
  now: number,
): SessionRuntimeStats {
  const existing = statsBySession.get(sessionID)
  if (existing) {
    return existing
  }

  const created = createSessionRuntimeStats(now)
  statsBySession.set(sessionID, created)
  return created
}

function normalizeMessage(entry: unknown): ChatMessage | null {
  if (!entry || typeof entry !== "object") {
    return null
  }

  const record = entry as Record<string, unknown>
  const parts = Array.isArray(record.parts) ? (record.parts as Record<string, unknown>[]) : []

  if (typeof record.role === "string") {
    return {
      id: typeof record.id === "string" ? record.id : undefined,
      role: record.role,
      parts,
    }
  }

  const info = record.info
  if (!info || typeof info !== "object") {
    return null
  }

  const infoRecord = info as Record<string, unknown>
  if (typeof infoRecord.role !== "string") {
    return null
  }

  return {
    id: typeof infoRecord.id === "string" ? infoRecord.id : undefined,
    role: infoRecord.role,
    parts,
  }
}

function normalizeMessages(response: unknown): ChatMessage[] {
  const root = response as { data?: unknown }
  const raw = Array.isArray(response) ? response : Array.isArray(root?.data) ? root.data : []
  const normalized: ChatMessage[] = []

  for (const entry of raw) {
    const message = normalizeMessage(entry)
    if (!message) {
      continue
    }

    normalized.push(message)
  }

  return normalized
}

function prependFocusedContext(parts: unknown[], focusedContext: string): void {
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue
    }

    const record = part as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") {
      record.text = `${FOCUSED_CONTEXT_TAG}\n${focusedContext}\n\n${record.text}`
      return
    }
  }
}

function isInternalFocusedContextPrompt(parts: unknown[]): boolean {
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue
    }

    const record = part as Record<string, unknown>
    if (record.type !== "text" || typeof record.text !== "string") {
      continue
    }

    if (record.text.startsWith(INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG)) {
      return true
    }
  }

  return false
}

function textFromParts(parts: unknown[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue
    }

    const record = part as Record<string, unknown>
    if (record.type === "text" && typeof record.text === "string") {
      const text = record.text.trim()
      if (text.length > 0) {
        chunks.push(text)
      }
    }
  }

  return chunks.join("\n\n").trim()
}

function latestUserTextFromHistory(history: ChatMessage[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]
    if (message.role !== "user") {
      continue
    }

    const text = textFromParts(message.parts ?? [])
    if (text.length > 0) {
      return text
    }
  }

  return ""
}

const plugin: Plugin = (async (ctx) => {
  const config = getConfig()
  const laneStore = new ContextLaneStore(ctx.directory, config.laneDbPath)
  const laneOrchestrator = new ContextLaneOrchestrator(laneStore)
  const statsBySession = new Map<string, SessionRuntimeStats>()

  return {
    tool: {
      contexts: tool({
        description: "Show active context lanes and current primary lane",
        args: {},
        execute: async (_args, tctx) => {
          const contexts = laneOrchestrator.listContexts(tctx.sessionID, config.laneMaxActive)
          const activeCount = laneOrchestrator.activeContextCount(tctx.sessionID)
          const primaryContextID = laneOrchestrator.currentPrimaryContextID(tctx.sessionID)

          if (contexts.length === 0) {
            return "No active contexts yet. A new context lane will be created automatically on the next routed message."
          }

          const lines = [
            `Active contexts: ${activeCount}`,
            `Primary context: ${primaryContextID ?? "none"}`,
            "",
            "Contexts:",
          ]

          for (const context of contexts) {
            const marker = context.id === primaryContextID ? "*" : "-"
            const summary = context.summary.replace(/\s+/g, " ").slice(0, 120)
            lines.push(
              `${marker} ${context.id} | ${context.title} | msgs=${context.msgCount} | last=${context.lastActiveAt} | ${summary}`,
            )
          }

          return lines.join("\n")
        },
      }),
      "contexts-switch": tool({
        description: "Temporarily force a primary context lane",
        args: {
          contextID: tool.schema.string().min(1),
          ttlMinutes: tool.schema.number().int().positive().optional(),
        },
        execute: async (args, tctx) => {
          const ttlMinutes = args.ttlMinutes ?? 30
          const switched = laneOrchestrator.switchContext(
            tctx.sessionID,
            args.contextID,
            ttlMinutes,
            Date.now(),
          )

          if (!switched) {
            return `Context ${args.contextID} was not found or not active.`
          }

          return `Context override set to ${args.contextID} for ${ttlMinutes} minute(s).`
        },
      }),
      "contexts-clear-override": tool({
        description: "Clear manual context override and return to automatic routing",
        args: {},
        execute: async (_args, tctx) => {
          laneOrchestrator.clearManualOverride(tctx.sessionID)
          return "Context override cleared. Automatic routing is active."
        },
      }),
      "contexts-events": tool({
        description: "Show recent context switch events",
        args: {
          limit: tool.schema.number().int().positive().optional(),
        },
        execute: async (args, tctx) => {
          const limit = Math.min(args.limit ?? 10, 50)
          const events = laneOrchestrator.listSwitchEvents(tctx.sessionID, limit)
          if (events.length === 0) {
            return "No context switch events recorded yet."
          }

          return events
            .map((event) => {
              const from = event.from ?? "none"
              return `${event.at}: ${from} -> ${event.to} (confidence=${event.confidence.toFixed(3)}, reason=${event.reason})`
            })
            .join("\n")
        },
      }),
      "contexts-stats": tool({
        description: "Show live RLM runtime stats for this session",
        args: {},
        execute: async (_args, tctx) => {
          const stats = statsBySession.get(tctx.sessionID)
          if (!stats) {
            return "No runtime stats yet for this session. Send at least one message first."
          }

          return formatRuntimeStats(stats, {
            activeContextCount: laneOrchestrator.activeContextCount(tctx.sessionID),
            primaryContextID: laneOrchestrator.currentPrimaryContextID(tctx.sessionID),
            switchEventsCount: laneOrchestrator.listSwitchEvents(tctx.sessionID, 50).length,
          })
        },
      }),
    },
    "chat.message": async (_input, output) => {
      if (!config.enabled) {
        return
      }

      const sessionID = output.message.sessionID
      const now = Date.now()
      const sessionStats = statsForSession(statsBySession, sessionID, now)
      sessionStats.messagesSeen += 1
      sessionStats.lastSeenAt = now

      const parts: unknown[] = output.parts
      if (isInternalFocusedContextPrompt(parts)) {
        sessionStats.lastDecision = "skipped-internal-focused-context-prompt"
        return
      }

      let historyResponse: unknown
      try {
        historyResponse = await ctx.client.session.messages({
          path: { id: sessionID },
        })
      } catch (error) {
        sessionStats.historyFetchFailures += 1
        sessionStats.lastDecision = "skipped-history-fetch-failed"
        if (process.env.RLM_PLUGIN_DEBUG === "1") {
          console.error("RLM plugin failed to read session history", error)
        }
        return
      }

      const history = normalizeMessages(historyResponse)
      if (history.length === 0) {
        sessionStats.lastDecision = "skipped-empty-history"
        return
      }

      const latestUserText = textFromParts(parts) || latestUserTextFromHistory(history)
      let historyForTransform = history
      if (config.laneRoutingEnabled && latestUserText.length > 0) {
        sessionStats.laneRoutingRuns += 1
        const routed = await laneOrchestrator.route({
          sessionID,
          messageID: output.message.id,
          latestUserText,
          history,
          config,
          now,
        })
        historyForTransform = routed.laneHistory
        if (routed.selection.createdNewContext) {
          sessionStats.laneNewContextCount += 1
        }

        if (process.env.RLM_PLUGIN_DEBUG === "1") {
          const secondaries = routed.selection.secondaryContextIDs.join(",") || "none"
          console.error(
            `RLM lane routing active=${routed.activeContextCount} primary=${routed.selection.primaryContextID} secondary=${secondaries} created=${routed.selection.createdNewContext}`,
          )
        }
      }

      const run =
        config.backend === "opencode"
          ? await computeFocusedContext(historyForTransform, config, null, async (archiveContext, latestGoal, runtimeConfig) => {
              return generateFocusedContextWithOpenCodeAuth({
                client: ctx.client,
                sessionID,
                archiveContext,
                latestGoal,
                config: runtimeConfig,
              })
            })
          : await computeFocusedContext(historyForTransform, config, null)

      sessionStats.transformRuns += 1
      sessionStats.lastPressure = run.pressure
      sessionStats.lastTokenEstimate = run.tokenEstimate

      if (!run.compacted || !run.focusedContext) {
        sessionStats.compactionsSkipped += 1
        sessionStats.lastFocusedChars = 0
        sessionStats.lastDecision = run.pressure < config.pressureThreshold ? "skipped-pressure" : "skipped-no-focused-context"
        return
      }

      prependFocusedContext(parts, run.focusedContext)
      sessionStats.compactionsApplied += 1
      sessionStats.lastFocusedChars = run.focusedContext.length
      sessionStats.lastDecision = "compacted"
    },
  }
}) satisfies Plugin

export default plugin
