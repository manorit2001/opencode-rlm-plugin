import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { getConfig } from "./lib/config.js"
import { computeFocusedContext } from "./lib/transform.js"
import { estimateConversationTokens } from "./lib/token-estimator.js"
import {
  INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG,
  generateFocusedContextWithOpenCodeAuth,
} from "./lib/opencode-bridge.js"
import { ContextLaneOrchestrator } from "./lib/context-lanes/orchestrator.js"
import { ContextLaneStore } from "./lib/context-lanes/store.js"
import type { ChatMessage } from "./lib/types.js"
import {
  createSessionRuntimeStats,
  formatRuntimeStats,
  formatTokenEfficiencyStats,
  recordLaneTelemetry,
  type SessionRuntimeStats,
} from "./lib/runtime-stats.js"
import { buildLaneVisualizationSnapshot } from "./lib/context-lanes/visualization.js"
import {
  startLaneVisualizationWebServer,
  type LaneVisualizationWebServerHandle,
} from "./lib/context-lanes/visualization-web.js"

const FOCUSED_CONTEXT_TAG = "[RLM_FOCUSED_CONTEXT]"
const INTERNAL_CONTEXT_HANDOFF_TAG = "[RLM_INTERNAL_CONTEXT_HANDOFF]"

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

function unwrapData(response: unknown): unknown {
  if (!response || typeof response !== "object") {
    return response
  }

  const record = response as Record<string, unknown>
  if (Object.hasOwn(record, "data")) {
    return record.data
  }

  return response
}

function normalizeLaneSessionTitle(prefix: string | undefined, laneTitle: string): string {
  const cleanPrefix = (prefix ?? "Project").trim()
  const cleanTitle = laneTitle.trim()
  if (cleanPrefix.length === 0) {
    return cleanTitle
  }

  if (cleanTitle.length === 0) {
    return cleanPrefix
  }

  return `${cleanPrefix}: ${cleanTitle}`
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

function isInternalPluginPrompt(parts: unknown[]): boolean {
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue
    }

    const record = part as Record<string, unknown>
    if (record.type !== "text" || typeof record.text !== "string") {
      continue
    }

    if (
      record.text.startsWith(INTERNAL_FOCUSED_CONTEXT_PROMPT_TAG) ||
      record.text.startsWith(INTERNAL_CONTEXT_HANDOFF_TAG)
    ) {
      return true
    }
  }

  return false
}

function buildOwnerHandoffPrompt(
  rootSessionID: string,
  latestUserText: string,
  route: { contextID: string; contextTitle: string; isPrimary: boolean },
): string {
  const role = route.isPrimary ? "primary" : "secondary"
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
  ].join("\n")
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

function formatContextsOutput(
  laneOrchestrator: ContextLaneOrchestrator,
  sessionID: string,
  laneMaxActive: number,
): string {
  const contexts = laneOrchestrator.listContexts(sessionID, laneMaxActive)
  const activeCount = laneOrchestrator.activeContextCount(sessionID)
  const primaryContextID = laneOrchestrator.currentPrimaryContextID(sessionID)

  if (contexts.length === 0) {
    return "No active contexts yet. A new context lane will be created automatically on the next routed message."
  }

  const lines = [`Active contexts: ${activeCount}`, `Primary context: ${primaryContextID ?? "none"}`, "", "Contexts:"]
  for (const context of contexts) {
    const marker = context.id === primaryContextID ? "*" : "-"
    const summary = context.summary.replace(/\s+/g, " ").slice(0, 120)
    const owner = context.ownerSessionID ?? "none"
    lines.push(
      `${marker} ${context.id} | ${context.title} | owner=${owner} | msgs=${context.msgCount} | last=${context.lastActiveAt} | ${summary}`,
    )
  }

  return lines.join("\n")
}

function formatSwitchEventsOutput(laneOrchestrator: ContextLaneOrchestrator, sessionID: string, limit: number): string {
  const events = laneOrchestrator.listSwitchEvents(sessionID, Math.min(limit, 50))
  if (events.length === 0) {
    return "No context switch events recorded yet."
  }

  return events
    .map((event) => {
      const from = event.from ?? "none"
      return `${event.at}: ${from} -> ${event.to} (confidence=${event.confidence.toFixed(3)}, reason=${event.reason})`
    })
    .join("\n")
}

const plugin: Plugin = (async (ctx) => {
  const config = getConfig()
  const laneStore = new ContextLaneStore(ctx.directory, config.laneDbPath)
  const laneOrchestrator = new ContextLaneOrchestrator(
    laneStore,
    fetch,
    config.laneBucketsUseSessions
      ? async ({ rootSessionID, laneTitle }) => {
          const title = normalizeLaneSessionTitle(config.laneSessionTitlePrefix, laneTitle)
          const createdRaw = await ctx.client.session.create({
            body: {
              parentID: rootSessionID,
              title,
            },
          })
          const created = unwrapData(createdRaw)
          if (!created || typeof created !== "object") {
            return { laneTitle: title }
          }

          const sessionID = (created as Record<string, unknown>).id
          if (typeof sessionID !== "string" || sessionID.trim().length === 0) {
            return { laneTitle: title }
          }

          return {
            contextID: sessionID,
            laneTitle: title,
          }
        }
      : undefined,
  )
  const statsBySession = new Map<string, SessionRuntimeStats>()
  let laneVisualizationWeb: LaneVisualizationWebServerHandle | null = null
  let laneVisualizationWebSignature = ""

  const notifyOwnerSessions = async (
    rootSessionID: string,
    latestUserText: string,
    ownerRoutes: Array<{ ownerSessionID: string; contextID: string; contextTitle: string; isPrimary: boolean }>,
  ): Promise<void> => {
    if (latestUserText.trim().length === 0 || ownerRoutes.length === 0) {
      return
    }

    const seenOwners = new Set<string>()
    for (const route of ownerRoutes) {
      if (route.ownerSessionID === rootSessionID || seenOwners.has(route.ownerSessionID)) {
        continue
      }

      seenOwners.add(route.ownerSessionID)
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
        })
      } catch (error) {
        if (process.env.RLM_PLUGIN_DEBUG === "1") {
          console.error(`RLM plugin failed to notify owner session ${route.ownerSessionID}`, error)
        }
      }
    }
  }

  return {
    tool: {
      contexts: tool({
        description: "Show active context lanes and current primary lane",
        args: {},
        execute: async (_args, tctx) => {
          return formatContextsOutput(laneOrchestrator, tctx.sessionID, config.laneMaxActive)
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
          return formatSwitchEventsOutput(laneOrchestrator, tctx.sessionID, args.limit ?? 10)
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
      "contexts-efficiency": tool({
        description: "Show estimated token savings from lane routing",
        args: {
          switchWindow: tool.schema.number().int().positive().optional(),
        },
        execute: async (args, tctx) => {
          const stats = statsBySession.get(tctx.sessionID)
          if (!stats) {
            return "No runtime stats yet for this session. Send at least one message first."
          }

          const switchEvents = laneOrchestrator.listSwitchEvents(tctx.sessionID, Math.min(args.switchWindow ?? 50, 200))
          return formatTokenEfficiencyStats(stats, {
            activeContextCount: laneOrchestrator.activeContextCount(tctx.sessionID),
            switchEvents,
          })
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
          }

          const host = (args.host ?? config.laneVisualizationWebHost ?? "127.0.0.1").trim() || "127.0.0.1"
          const port = args.port ?? config.laneVisualizationWebPort ?? 3799
          const basePath = (args.basePath ?? config.laneVisualizationWebBasePath ?? "/").trim() || "/"

          const signature = JSON.stringify({ host, port, basePath, defaults })
          if (laneVisualizationWeb && laneVisualizationWebSignature === signature) {
            const apiURL = `${laneVisualizationWeb.url}/api/snapshot`
            const healthURL = `${laneVisualizationWeb.url}/health`
            return [
              `Lane visualization web frontend already running at ${laneVisualizationWeb.url}`,
              `Snapshot API: ${apiURL}`,
              `Health check: ${healthURL}`,
              `Default session: ${defaults.sessionID || "none"}`,
              "Query params: sessionID, sessionLimit, contextLimit, switchLimit, membershipLimit",
            ].join("\n")
          }

          if (laneVisualizationWeb) {
            await laneVisualizationWeb.close()
            laneVisualizationWeb = null
            laneVisualizationWebSignature = ""
          }

          laneVisualizationWeb = await startLaneVisualizationWebServer({
            host,
            port,
            basePath,
            defaults,
            buildSnapshot: (options) =>
              buildLaneVisualizationSnapshot(laneStore, laneOrchestrator, {
                sessionID: options.sessionID ?? defaults.sessionID,
                sessionLimit: options.sessionLimit ?? defaults.sessionLimit,
                contextLimit: options.contextLimit ?? defaults.contextLimit,
                switchLimit: options.switchLimit ?? defaults.switchLimit,
                membershipLimit: options.membershipLimit ?? defaults.membershipLimit,
              }),
          })
          laneVisualizationWebSignature = signature

          const apiURL = `${laneVisualizationWeb.url}/api/snapshot`
          const healthURL = `${laneVisualizationWeb.url}/health`

          return [
            `Lane visualization web frontend started at ${laneVisualizationWeb.url}`,
            `Snapshot API: ${apiURL}`,
            `Health check: ${healthURL}`,
            `Default session: ${defaults.sessionID || "none"}`,
            "Query params: sessionID, sessionLimit, contextLimit, switchLimit, membershipLimit",
          ].join("\n")
        },
      }),
      "contexts-visualize-stop": tool({
        description: "Stop the lane visualization web frontend server",
        args: {},
        execute: async () => {
          if (!laneVisualizationWeb) {
            return "Lane visualization web frontend is not running."
          }

          const url = laneVisualizationWeb.url
          await laneVisualizationWeb.close()
          laneVisualizationWeb = null
          laneVisualizationWebSignature = ""
          return `Lane visualization web frontend stopped: ${url}`
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
      if (isInternalPluginPrompt(parts)) {
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

      const baselineTokenEstimate = estimateConversationTokens(history)
      sessionStats.lastBaselineTokenEstimate = baselineTokenEstimate

      const latestUserText = textFromParts(parts) || latestUserTextFromHistory(history)
      let historyForTransform = history
      let ownerRoutes: Array<{ ownerSessionID: string; contextID: string; contextTitle: string; isPrimary: boolean }> = []
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
        ownerRoutes = routed.ownerRoutes
        if (routed.selection.createdNewContext) {
          sessionStats.laneNewContextCount += 1
        }

        if (process.env.RLM_PLUGIN_DEBUG === "1") {
          const secondaries = routed.selection.secondaryContextIDs.join(",") || "none"
          console.error(
            `RLM lane routing active=${routed.activeContextCount} primary=${routed.selection.primaryContextID} secondary=${secondaries} created=${routed.selection.createdNewContext}`,
          )
        }

        const laneTokenEstimate = estimateConversationTokens(historyForTransform)
        const laneSavedTokens = Math.max(0, baselineTokenEstimate - laneTokenEstimate)

        recordLaneTelemetry(sessionStats, {
          at: now,
          baselineTokens: baselineTokenEstimate,
          laneScopedTokens: laneTokenEstimate,
          historyMessages: history.length,
          laneHistoryMessages: historyForTransform.length,
          primaryContextID: routed.selection.primaryContextID,
          createdNewContext: routed.selection.createdNewContext,
        })

        sessionStats.laneRoutingSamples += 1
        sessionStats.totalBaselineTokens += baselineTokenEstimate
        sessionStats.totalLaneScopedTokens += laneTokenEstimate
        sessionStats.totalLaneSavedTokens += laneSavedTokens
        sessionStats.lastLaneScopedTokenEstimate = laneTokenEstimate
        sessionStats.lastLaneSavedTokens = laneSavedTokens

        if (config.laneBucketsUseSessions) {
          await notifyOwnerSessions(sessionID, latestUserText, ownerRoutes)
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
