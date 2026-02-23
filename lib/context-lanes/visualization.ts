import type { ContextLaneOrchestrator } from "./orchestrator.js"
import type { ContextMembershipEvent, ContextLaneStore, SessionActivity } from "./store.js"
import type { ContextLane } from "./types.js"

interface LaneSwitchRecord {
  from: string | null
  to: string
  confidence: number
  reason: string
  at: number
}

export interface LaneVisualizationOptions {
  sessionID?: string
  sessionLimit?: number
  contextLimit?: number
  switchLimit?: number
  membershipLimit?: number
}

export interface LaneTimelineEvent {
  at: number
  kind: "context-created" | "membership" | "switch"
  contextID?: string
  messageID?: string
  label: string
  detail: string
}

export interface LaneVisualizationSession {
  sessionID: string
  lastActivityAt: number
  activeContextCount: number
  primaryContextID: string | null
  contexts: ContextLane[]
  switches: LaneSwitchRecord[]
  memberships: ContextMembershipEvent[]
  timeline: LaneTimelineEvent[]
}

export interface LaneVisualizationSnapshot {
  generatedAt: number
  sessions: LaneVisualizationSession[]
}

export interface LaneVisualizationRenderOptions {
  apiPath?: string
}

const DEFAULT_SESSION_LIMIT = 8
const DEFAULT_CONTEXT_LIMIT = 16
const DEFAULT_SWITCH_LIMIT = 60
const DEFAULT_MEMBERSHIP_LIMIT = 240

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback
  }

  return Math.max(1, Math.floor(value ?? fallback))
}

function toISO(ms: number): string {
  return new Date(ms).toISOString()
}

function summarize(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim()
  if (compact.length <= maxChars) {
    return compact
  }

  return `${compact.slice(0, maxChars - 3)}...`
}

function escapeHTML(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function inferLastActivityAt(
  context: ContextLane[],
  switches: LaneSwitchRecord[],
  memberships: ContextMembershipEvent[],
  fallback: number,
): number {
  let max = fallback
  for (const lane of context) {
    max = Math.max(max, lane.lastActiveAt, lane.createdAt, lane.updatedAt)
  }
  for (const event of switches) {
    max = Math.max(max, event.at)
  }
  for (const membership of memberships) {
    max = Math.max(max, membership.createdAt)
  }
  return max
}

function timelineFrom(
  contexts: ContextLane[],
  memberships: ContextMembershipEvent[],
  switches: LaneSwitchRecord[],
): LaneTimelineEvent[] {
  const timeline: LaneTimelineEvent[] = []

  const contextByID = new Map(contexts.map((context) => [context.id, context]))

  for (const context of [...contexts].sort((left, right) => left.createdAt - right.createdAt)) {
    timeline.push({
      at: context.createdAt,
      kind: "context-created",
      contextID: context.id,
      label: context.title,
      detail: `Context created (owner: ${context.ownerSessionID ?? "none"})`,
    })
  }

  for (const membership of memberships) {
    const contextTitle = contextByID.get(membership.contextID)?.title ?? membership.contextID
    const laneRole = membership.isPrimary ? "primary" : "secondary"
    timeline.push({
      at: membership.createdAt,
      kind: "membership",
      contextID: membership.contextID,
      messageID: membership.messageID,
      label: `${laneRole} lane membership`,
      detail: `${contextTitle} (message: ${membership.messageID}, relevance: ${membership.relevance.toFixed(3)})`,
    })
  }

  for (const event of switches) {
    timeline.push({
      at: event.at,
      kind: "switch",
      contextID: event.to,
      label: event.reason,
      detail: `${event.from ?? "none"} -> ${event.to} (confidence: ${event.confidence.toFixed(3)})`,
    })
  }

  const typePriority: Record<LaneTimelineEvent["kind"], number> = {
    "context-created": 0,
    membership: 1,
    switch: 2,
  }

  timeline.sort((left, right) => {
    if (left.at !== right.at) {
      return left.at - right.at
    }

    const typeDiff = typePriority[left.kind] - typePriority[right.kind]
    if (typeDiff !== 0) {
      return typeDiff
    }

    if ((left.contextID ?? "") !== (right.contextID ?? "")) {
      return (left.contextID ?? "").localeCompare(right.contextID ?? "")
    }

    return (left.messageID ?? "").localeCompare(right.messageID ?? "")
  })

  return timeline
}

function normalizeOptions(options: LaneVisualizationOptions): Required<LaneVisualizationOptions> {
  return {
    sessionID: (options.sessionID ?? "").trim(),
    sessionLimit: normalizeLimit(options.sessionLimit, DEFAULT_SESSION_LIMIT),
    contextLimit: normalizeLimit(options.contextLimit, DEFAULT_CONTEXT_LIMIT),
    switchLimit: normalizeLimit(options.switchLimit, DEFAULT_SWITCH_LIMIT),
    membershipLimit: normalizeLimit(options.membershipLimit, DEFAULT_MEMBERSHIP_LIMIT),
  }
}

function selectedSessions(
  sessions: SessionActivity[],
  requestedSessionID: string,
  sessionLimit: number,
): SessionActivity[] {
  if (requestedSessionID.length > 0) {
    const existing = sessions.find((session) => session.sessionID === requestedSessionID)
    if (existing) {
      return [existing]
    }

    return [{ sessionID: requestedSessionID, lastActivityAt: 0 }]
  }

  return sessions.slice(0, sessionLimit)
}

export function buildLaneVisualizationSnapshot(
  laneStore: ContextLaneStore,
  laneOrchestrator: ContextLaneOrchestrator,
  options: LaneVisualizationOptions = {},
): LaneVisualizationSnapshot {
  const normalized = normalizeOptions(options)
  const availableSessions = laneStore.listSessions(Math.max(normalized.sessionLimit, 32))
  const sessions = selectedSessions(availableSessions, normalized.sessionID, normalized.sessionLimit)

  const visualizedSessions: LaneVisualizationSession[] = sessions.map((session) => {
    const contexts = laneOrchestrator.listContexts(session.sessionID, normalized.contextLimit)
    const switches = laneOrchestrator
      .listSwitchEvents(session.sessionID, normalized.switchLimit)
      .slice()
      .sort((left, right) => left.at - right.at || left.to.localeCompare(right.to))
    const memberships = laneStore
      .listMembershipEvents(session.sessionID, normalized.membershipLimit)
      .slice()
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) {
          return left.createdAt - right.createdAt
        }
        if (left.messageID !== right.messageID) {
          return left.messageID.localeCompare(right.messageID)
        }
        return left.contextID.localeCompare(right.contextID)
      })

    const timeline = timelineFrom(contexts, memberships, switches)

    return {
      sessionID: session.sessionID,
      lastActivityAt: inferLastActivityAt(contexts, switches, memberships, session.lastActivityAt),
      activeContextCount: laneOrchestrator.activeContextCount(session.sessionID),
      primaryContextID: laneOrchestrator.currentPrimaryContextID(session.sessionID),
      contexts,
      switches,
      memberships,
      timeline,
    }
  })

  return {
    generatedAt: Date.now(),
    sessions: visualizedSessions,
  }
}

export function formatLaneVisualizationText(snapshot: LaneVisualizationSnapshot): string {
  if (snapshot.sessions.length === 0) {
    return "No lane data available in the configured lane database yet."
  }

  const lines = [`Lane visualization snapshot at ${toISO(snapshot.generatedAt)}`, ""]
  for (const session of snapshot.sessions) {
    lines.push(
      `Session ${session.sessionID} | primary=${session.primaryContextID ?? "none"} | active=${session.activeContextCount} | contexts=${session.contexts.length} | memberships=${session.memberships.length} | switches=${session.switches.length}`,
    )
  }

  return lines.join("\n")
}

export function renderLaneVisualizationHTML(
  snapshot: LaneVisualizationSnapshot,
  options: LaneVisualizationRenderOptions = {},
): string {
  const sessionOptions = snapshot.sessions
    .map((session, index) => {
      const selected = index === 0 ? " selected" : ""
      return `<option value="${escapeHTML(session.sessionID)}"${selected}>${escapeHTML(session.sessionID)}</option>`
    })
    .join("")

  const sessionCards = snapshot.sessions
    .map((session, index) => {
      const contextsRows = session.contexts
        .map((context) => {
          const isPrimary = context.id === session.primaryContextID
          const summary = escapeHTML(summarize(context.summary, 140))
          return `<tr><td>${isPrimary ? "yes" : "no"}</td><td><code>${escapeHTML(context.id)}</code></td><td>${escapeHTML(context.title)}</td><td>${escapeHTML(context.ownerSessionID ?? "none")}</td><td>${context.msgCount}</td><td>${toISO(context.lastActiveAt)}</td><td>${summary}</td></tr>`
        })
        .join("")

      const timelineRows = session.timeline
        .map((event) => {
          const context = escapeHTML(event.contextID ?? "-")
          const message = escapeHTML(event.messageID ?? "-")
          return `<tr><td>${toISO(event.at)}</td><td>${escapeHTML(event.kind)}</td><td><code>${context}</code></td><td><code>${message}</code></td><td>${escapeHTML(event.label)}</td><td>${escapeHTML(event.detail)}</td></tr>`
        })
        .join("")

      const visible = index === 0 ? "" : " hidden"
      return `<section class="session-card${visible}" data-session="${escapeHTML(session.sessionID)}"><h2>Session <code>${escapeHTML(session.sessionID)}</code></h2><p class="meta">Last activity: ${toISO(session.lastActivityAt)} | Primary lane: <code>${escapeHTML(session.primaryContextID ?? "none")}</code> | Active lanes: ${session.activeContextCount}</p><h3>Lane Contexts</h3><table><thead><tr><th>Primary</th><th>Context ID</th><th>Title</th><th>Owner Session</th><th>Messages</th><th>Last Active</th><th>Summary</th></tr></thead><tbody>${contextsRows || "<tr><td colspan=\"7\">No contexts for this session.</td></tr>"}</tbody></table><h3>Formation Timeline</h3><table><thead><tr><th>At</th><th>Type</th><th>Context</th><th>Message</th><th>Label</th><th>Detail</th></tr></thead><tbody>${timelineRows || "<tr><td colspan=\"6\">No timeline events for this session.</td></tr>"}</tbody></table></section>`
    })
    .join("")

  const serialized = escapeHTML(JSON.stringify(snapshot))
  const generatedAt = toISO(snapshot.generatedAt)
  const apiPath = (options.apiPath ?? "/api/snapshot").trim() || "/api/snapshot"

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RLM Lane Visualization</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f7fb;
        --card: #ffffff;
        --text: #172031;
        --muted: #5f6d85;
        --accent: #1f5fbf;
        --border: #d8ddea;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background: radial-gradient(circle at 15% 10%, #dfe8ff 0%, var(--bg) 50%);
        color: var(--text);
      }
      main { max-width: 1400px; margin: 0 auto; padding: 24px; }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        margin-bottom: 16px;
      }
      .meta { color: var(--muted); font-size: 14px; }
      .session-card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 18px;
        box-shadow: 0 8px 30px rgba(10, 28, 64, 0.08);
        margin-bottom: 20px;
      }
      .session-card.hidden { display: none; }
      table {
        width: 100%;
        border-collapse: collapse;
        margin: 10px 0 18px;
        font-size: 13px;
      }
      th, td {
        border: 1px solid var(--border);
        padding: 8px;
        text-align: left;
        vertical-align: top;
      }
      th {
        background: #edf2fe;
        color: #24314d;
      }
      code {
        font-family: "IBM Plex Mono", "JetBrains Mono", monospace;
        font-size: 12px;
      }
      select {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: #fff;
        padding: 6px 10px;
        font-size: 14px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>RLM Context Lane Visualization</h1>
      <div class="toolbar">
        <label for="session-selector">Session:</label>
        <select id="session-selector">${sessionOptions}</select>
        <span class="meta">Generated at ${generatedAt}. Sessions: ${snapshot.sessions.length}.</span>
        <span class="meta">API: <code>${escapeHTML(apiPath)}</code></span>
      </div>
      ${sessionCards || '<section class="session-card"><p>No sessions were found in the lane database.</p></section>'}
      <script id="rlm-lane-visualization-data" type="application/json">${serialized}</script>
      <script>
        const selector = document.getElementById("session-selector");
        const cards = [...document.querySelectorAll(".session-card[data-session]")];
        if (selector) {
          selector.addEventListener("change", () => {
            const value = selector.value;
            cards.forEach((card) => {
              card.classList.toggle("hidden", card.dataset.session !== value);
            });
          });
        }
      </script>
    </main>
  </body>
</html>`
}
