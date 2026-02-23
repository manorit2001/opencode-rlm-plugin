import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { renderLaneVisualizationHTML, type LaneVisualizationOptions, type LaneVisualizationSnapshot } from "./visualization.js"
import type {
  ContextSnapshotRecord,
  LaneEventRecord,
  MessageIntentBucketAssignment,
  MessageProgressionStep,
} from "./types.js"

type UnknownRecord = Record<string, unknown>

export interface LaneCacheRiskInputs {
  primaryChanged: boolean
  addedContextCount: number
  removedContextCount: number
  changedContextCount: number
  latestUserTextChars: number
  historyMessages: number
  focusedContextApplied: boolean
  stablePrefixPresent: boolean
  scaffoldStages: number
}

export interface LaneCacheRisk {
  score: number
  level: "low" | "medium" | "high"
  reasons: string[]
  inputs: LaneCacheRiskInputs
}

export interface LaneMessageDebugPayload {
  intentBuckets: MessageIntentBucketAssignment[]
  progression: MessageProgressionStep[]
  snapshots: ContextSnapshotRecord[]
  previousIntentBuckets?: MessageIntentBucketAssignment[]
  bucketDelta?: unknown
  rawRequestScaffold?: unknown
  cacheRisk?: LaneCacheRisk
}

interface LaneVisualizationSnapshotDefaults {
  sessionID: string
  sessionLimit: number
  contextLimit: number
  switchLimit: number
  membershipLimit: number
}

export interface StartLaneVisualizationWebServerOptions {
  host: string
  port: number
  basePath?: string
  defaults: LaneVisualizationSnapshotDefaults
  buildSnapshot: (options: LaneVisualizationOptions) => LaneVisualizationSnapshot
  listEventsAfter: (sessionID: string, afterSeq: number, limit: number) => LaneEventRecord[]
  getMessageDebug: (sessionID: string, messageID: string, limit: number) => LaneMessageDebugPayload
}

export interface LaneVisualizationWebServerHandle {
  host: string
  port: number
  basePath: string
  url: string
  close: () => Promise<void>
}

function normalizeBasePath(basePath: string | undefined): string {
  const trimmed = (basePath ?? "/").trim()
  if (trimmed.length === 0 || trimmed === "/") {
    return "/"
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const withoutTrailingSlash = withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, Math.max(1, withLeadingSlash.length - 1))
    : withLeadingSlash
  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : "/"
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.max(1, Math.floor(parsed))
}

function parseNonNegativeInt(raw: string | null, fallback: number): number {
  if (!raw) {
    return fallback
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  return Math.max(0, Math.floor(parsed))
}

function asRecord(value: unknown): UnknownRecord {
  if (value && typeof value === "object") {
    return value as UnknownRecord
  }
  return {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  return fallback
}

function normalizeRiskScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)))
}

function riskLevel(score: number): "low" | "medium" | "high" {
  if (score >= 67) {
    return "high"
  }
  if (score >= 34) {
    return "medium"
  }
  return "low"
}

function computeCacheRisk(payload: LaneMessageDebugPayload): LaneCacheRisk {
  const delta = asRecord(payload.bucketDelta)
  const scaffolds = asArray(payload.rawRequestScaffold).map((entry) => asRecord(entry))
  const beforeScaffold = scaffolds.find((entry) => entry.stage === "before-compaction") ?? scaffolds[0] ?? {}
  const finalScaffold =
    scaffolds.find((entry) => entry.stage === "final-model-input") ??
    scaffolds[Math.max(0, scaffolds.length - 1)] ??
    {}

  const formation = asRecord(beforeScaffold.formation)
  const cacheStability = asRecord(finalScaffold.cacheStability)

  const primaryChanged = delta.primaryChanged === true
  const addedContextCount = asArray(delta.addedContextIDs).length
  const removedContextCount = asArray(delta.removedContextIDs).length
  const changedContextCount = asArray(delta.changedContexts).length
  const latestUserTextChars = asNumber(beforeScaffold.latestUserTextChars, 0)
  const historyMessages = asNumber(formation.historyMessages, asArray(beforeScaffold.historyTail).length)
  const focusedContextApplied = cacheStability.focusedContextApplied === true || finalScaffold.compacted === true
  const stablePrefixPresent = typeof cacheStability.stablePrefix === "string" && cacheStability.stablePrefix.length > 0

  const reasons: string[] = []
  let score = 0

  if (primaryChanged) {
    score += 28
    reasons.push("primary-context-switch")
  }

  const membershipDeltaCount = addedContextCount + removedContextCount
  if (membershipDeltaCount > 0) {
    score += Math.min(18, membershipDeltaCount * 6)
    reasons.push("bucket-membership-delta")
  }

  if (changedContextCount > 0) {
    score += Math.min(24, changedContextCount * 8)
    reasons.push("bucket-score-rank-delta")
  }

  if (focusedContextApplied) {
    score += 14
    reasons.push("focused-context-prepend")
  }

  if (latestUserTextChars > 1_200) {
    score += 12
    reasons.push("large-latest-user-message")
  } else if (latestUserTextChars > 500) {
    score += 6
    reasons.push("medium-latest-user-message")
  }

  if (historyMessages > 30) {
    score += 8
    reasons.push("large-routed-history")
  } else if (historyMessages > 15) {
    score += 4
    reasons.push("medium-routed-history")
  }

  if (stablePrefixPresent) {
    score -= 10
    reasons.push("stable-prefix-anchor")
  } else {
    score += 6
    reasons.push("missing-stable-prefix")
  }

  if (scaffolds.length === 0) {
    score += 8
    reasons.push("missing-request-scaffold")
  }

  if (payload.bucketDelta === undefined) {
    score += 6
    reasons.push("missing-bucket-delta")
  }

  const normalized = normalizeRiskScore(score)
  return {
    score: normalized,
    level: riskLevel(normalized),
    reasons: [...new Set(reasons)],
    inputs: {
      primaryChanged,
      addedContextCount,
      removedContextCount,
      changedContextCount,
      latestUserTextChars,
      historyMessages,
      focusedContextApplied,
      stablePrefixPresent,
      scaffoldStages: scaffolds.length,
    },
  }
}

function optionsFromQuery(
  url: URL,
  defaults: LaneVisualizationSnapshotDefaults,
): LaneVisualizationOptions {
  const sessionID = (url.searchParams.get("sessionID") ?? defaults.sessionID).trim()
  return {
    sessionID: sessionID.length > 0 ? sessionID : undefined,
    sessionLimit: parsePositiveInt(url.searchParams.get("sessionLimit"), defaults.sessionLimit),
    contextLimit: parsePositiveInt(url.searchParams.get("contextLimit"), defaults.contextLimit),
    switchLimit: parsePositiveInt(url.searchParams.get("switchLimit"), defaults.switchLimit),
    membershipLimit: parsePositiveInt(url.searchParams.get("membershipLimit"), defaults.membershipLimit),
  }
}

function isRoute(pathname: string, route: string): boolean {
  if (pathname === route) {
    return true
  }

  return route !== "/" && pathname === `${route}/`
}

function writeJSON(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader("content-type", "application/json; charset=utf-8")
  res.end(JSON.stringify(payload, null, 2))
}

function writeText(res: ServerResponse, statusCode: number, contentType: string, body: string): void {
  res.statusCode = statusCode
  res.setHeader("content-type", contentType)
  res.end(body)
}

function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  defaults: LaneVisualizationSnapshotDefaults,
  buildSnapshot: (options: LaneVisualizationOptions) => LaneVisualizationSnapshot,
  listEventsAfter: (sessionID: string, afterSeq: number, limit: number) => LaneEventRecord[],
  getMessageDebug: (sessionID: string, messageID: string, limit: number) => LaneMessageDebugPayload,
  basePath: string,
): void {
  if (req.method !== "GET") {
    writeJSON(res, 405, { error: "method-not-allowed" })
    return
  }

  const requestURL = new URL(req.url ?? "/", "http://127.0.0.1")
  const apiPath = basePath === "/" ? "/api/snapshot" : `${basePath}/api/snapshot`
  const eventsPath = basePath === "/" ? "/api/events" : `${basePath}/api/events`
  const messagePath = basePath === "/" ? "/api/message" : `${basePath}/api/message`
  const healthPath = basePath === "/" ? "/health" : `${basePath}/health`

  if (isRoute(requestURL.pathname, healthPath)) {
    writeJSON(res, 200, {
      ok: true,
      basePath,
      apiPath,
      eventsPath,
      messagePath,
      generatedAt: Date.now(),
    })
    return
  }

  if (isRoute(requestURL.pathname, apiPath)) {
    const snapshot = buildSnapshot(optionsFromQuery(requestURL, defaults))
    writeJSON(res, 200, snapshot)
    return
  }

  if (isRoute(requestURL.pathname, eventsPath)) {
    const fallbackSessionID = defaults.sessionID.trim()
    const sessionID = (requestURL.searchParams.get("sessionID") ?? fallbackSessionID).trim()
    if (sessionID.length === 0) {
      writeJSON(res, 400, { error: "sessionID-required" })
      return
    }

    const afterSeq = parseNonNegativeInt(requestURL.searchParams.get("afterSeq"), 0)
    const limit = parsePositiveInt(requestURL.searchParams.get("limit"), 100)
    const events = listEventsAfter(sessionID, afterSeq, limit)
    const lastSeq = events.length > 0 ? events[events.length - 1]?.seq ?? afterSeq : afterSeq
    writeJSON(res, 200, {
      sessionID,
      afterSeq,
      count: events.length,
      lastSeq,
      events,
    })
    return
  }

  if (isRoute(requestURL.pathname, messagePath)) {
    const fallbackSessionID = defaults.sessionID.trim()
    const sessionID = (requestURL.searchParams.get("sessionID") ?? fallbackSessionID).trim()
    const messageID = (requestURL.searchParams.get("messageID") ?? "").trim()
    if (sessionID.length === 0 || messageID.length === 0) {
      writeJSON(res, 400, { error: "sessionID-and-messageID-required" })
      return
    }

    const limit = parsePositiveInt(requestURL.searchParams.get("limit"), 120)
    const data = getMessageDebug(sessionID, messageID, limit)
    const cacheRisk = data.cacheRisk ?? computeCacheRisk(data)
    writeJSON(res, 200, {
      sessionID,
      messageID,
      ...data,
      cacheRisk,
    })
    return
  }

  if (isRoute(requestURL.pathname, basePath)) {
    const snapshot = buildSnapshot(optionsFromQuery(requestURL, defaults))
    const html = renderLaneVisualizationHTML(snapshot, { apiPath, eventsPath, messagePath })
    writeText(res, 200, "text/html; charset=utf-8", html)
    return
  }

  writeJSON(res, 404, {
    error: "not-found",
    basePath,
    routes: [basePath, apiPath, eventsPath, messagePath, healthPath],
  })
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off("error", onError)
      resolve()
    }

    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, host)
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

export async function startLaneVisualizationWebServer(
  options: StartLaneVisualizationWebServerOptions,
): Promise<LaneVisualizationWebServerHandle> {
  const host = options.host.trim().length > 0 ? options.host.trim() : "127.0.0.1"
  const port = Math.max(0, Math.floor(options.port))
  const basePath = normalizeBasePath(options.basePath)

  const server = createServer((req, res) => {
    routeRequest(req, res, options.defaults, options.buildSnapshot, options.listEventsAfter, options.getMessageDebug, basePath)
  })

  await listen(server, host, port)

  const address = server.address()
  if (!address || typeof address === "string") {
    await closeServer(server)
    throw new Error("Lane visualization server failed to resolve listening address")
  }

  const boundHost = address.address === "::" ? "127.0.0.1" : address.address
  const boundPort = address.port
  const root = basePath === "/" ? "" : basePath

  return {
    host: boundHost,
    port: boundPort,
    basePath,
    url: `http://${boundHost}:${boundPort}${root}`,
    close: () => closeServer(server),
  }
}
