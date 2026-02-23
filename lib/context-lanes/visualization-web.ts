import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { renderLaneVisualizationHTML, type LaneVisualizationOptions, type LaneVisualizationSnapshot } from "./visualization.js"

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
  basePath: string,
): void {
  if (req.method !== "GET") {
    writeJSON(res, 405, { error: "method-not-allowed" })
    return
  }

  const requestURL = new URL(req.url ?? "/", "http://127.0.0.1")
  const apiPath = basePath === "/" ? "/api/snapshot" : `${basePath}/api/snapshot`
  const healthPath = basePath === "/" ? "/health" : `${basePath}/health`

  if (isRoute(requestURL.pathname, healthPath)) {
    writeJSON(res, 200, {
      ok: true,
      basePath,
      apiPath,
      generatedAt: Date.now(),
    })
    return
  }

  if (isRoute(requestURL.pathname, apiPath)) {
    const snapshot = buildSnapshot(optionsFromQuery(requestURL, defaults))
    writeJSON(res, 200, snapshot)
    return
  }

  if (isRoute(requestURL.pathname, basePath)) {
    const snapshot = buildSnapshot(optionsFromQuery(requestURL, defaults))
    const html = renderLaneVisualizationHTML(snapshot, { apiPath })
    writeText(res, 200, "text/html; charset=utf-8", html)
    return
  }

  writeJSON(res, 404, {
    error: "not-found",
    basePath,
    routes: [basePath, apiPath, healthPath],
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
    routeRequest(req, res, options.defaults, options.buildSnapshot, basePath)
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
