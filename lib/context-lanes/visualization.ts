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
  eventsPath?: string
  messagePath?: string
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
      const safeSessionID = escapeHTML(session.sessionID)
      return `<section class="session-card${visible}" data-session="${safeSessionID}"><h2>Session <code>${safeSessionID}</code></h2><p class="meta">Last activity: ${toISO(session.lastActivityAt)} | Primary lane: <code>${escapeHTML(session.primaryContextID ?? "none")}</code> | Active lanes: ${session.activeContextCount}</p><h3>Lane Contexts</h3><table><thead><tr><th>Primary</th><th>Context ID</th><th>Title</th><th>Owner Session</th><th>Messages</th><th>Last Active</th><th>Summary</th></tr></thead><tbody>${contextsRows || "<tr><td colspan=\"7\">No contexts for this session.</td></tr>"}</tbody></table><h3>Formation Timeline</h3><table><thead><tr><th>At</th><th>Type</th><th>Context</th><th>Message</th><th>Label</th><th>Detail</th></tr></thead><tbody>${timelineRows || "<tr><td colspan=\"6\">No timeline events for this session.</td></tr>"}</tbody></table><h3>Live Progression Events</h3><table><thead><tr><th>Seq</th><th>At</th><th>Type</th><th>Message</th><th>Details</th></tr></thead><tbody id="progression-${safeSessionID}"><tr><td colspan="5">Waiting for live progression events...</td></tr></tbody></table><h3>Message Debug</h3><pre id="message-debug-${safeSessionID}" class="debug-panel">Select an event row to inspect bucket changes, request formation scaffolding, and raw debug payload.</pre></section>`
    })
    .join("")

  const serialized = escapeHTML(JSON.stringify(snapshot))
  const generatedAt = toISO(snapshot.generatedAt)
  const apiPath = (options.apiPath ?? "/api/snapshot").trim() || "/api/snapshot"
  const eventsPath = (options.eventsPath ?? "/api/events").trim() || "/api/events"
  const messagePath = (options.messagePath ?? "/api/message").trim() || "/api/message"

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
      .debug-panel {
        border: 1px solid var(--border);
        background: #f9fbff;
        border-radius: 10px;
        padding: 12px;
        min-height: 130px;
        overflow: auto;
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
        <span class="meta">Events: <code>${escapeHTML(eventsPath)}</code></span>
      </div>
      ${sessionCards || '<section class="session-card"><p>No sessions were found in the lane database.</p></section>'}
      <script id="rlm-lane-visualization-data" type="application/json">${serialized}</script>
      <script>
        const apiEventsPath = ${JSON.stringify(eventsPath)};
        const apiMessagePath = ${JSON.stringify(messagePath)};
        const selector = document.getElementById("session-selector");
        const cards = [...document.querySelectorAll(".session-card[data-session]")];
        const cursors = Object.create(null);

        function activeSessionID() {
          if (selector && selector.value) {
            return selector.value;
          }
          const first = cards.find((card) => !card.classList.contains("hidden"));
          return first ? first.dataset.session : "";
        }

        function asObject(value) {
          return value && typeof value === "object" ? value : {};
        }

        function asArray(value) {
          return Array.isArray(value) ? value : [];
        }

        function summarizeParts(parts) {
          const records = asArray(parts);
          if (records.length === 0) {
            return "none";
          }

          const rendered = records.map((record, index) => {
            const item = asObject(record);
            const partType = typeof item.type === "string" ? item.type : "unknown";
            const textChars = typeof item.textChars === "number" ? item.textChars : 0;
            const textPreview = typeof item.textPreview === "string" ? item.textPreview : "";
            const preview = textPreview.length > 0 ? ' "' + textPreview + '"' : "";
            return "#" + index + " " + partType + " chars=" + textChars + preview;
          });

          return rendered.join(" | ");
        }

        function formatBucketDelta(delta) {
          const record = asObject(delta);
          if (Object.keys(record).length === 0) {
            return "No bucket delta available yet.";
          }

          const previousMessageID = typeof record.previousMessageID === "string" ? record.previousMessageID : "none";
          const previousPrimary = typeof record.previousPrimaryContextID === "string" ? record.previousPrimaryContextID : "none";
          const currentPrimary = typeof record.currentPrimaryContextID === "string" ? record.currentPrimaryContextID : "none";
          const primaryChanged = record.primaryChanged === true;
          const addedContextIDs = asArray(record.addedContextIDs).map((value) => String(value));
          const removedContextIDs = asArray(record.removedContextIDs).map((value) => String(value));
          const changedContexts = asArray(record.changedContexts);

          const lines = [
            "previousMessageID: " + previousMessageID,
            "primary: " + previousPrimary + " -> " + currentPrimary + (primaryChanged ? " (changed)" : " (unchanged)"),
            "addedContexts: " + (addedContextIDs.length > 0 ? addedContextIDs.join(", ") : "none"),
            "removedContexts: " + (removedContextIDs.length > 0 ? removedContextIDs.join(", ") : "none"),
          ];

          if (changedContexts.length === 0) {
            lines.push("score/rank/type changes: none");
            return lines.join("\n");
          }

          lines.push("score/rank/type changes:");
          for (const changed of changedContexts) {
            const change = asObject(changed);
            const contextID = typeof change.contextID === "string" ? change.contextID : "unknown";
            const previousScore = typeof change.previousScore === "number" ? change.previousScore.toFixed(3) : "-";
            const currentScore = typeof change.currentScore === "number" ? change.currentScore.toFixed(3) : "-";
            const previousRank = typeof change.previousRank === "number" ? String(change.previousRank) : "-";
            const currentRank = typeof change.currentRank === "number" ? String(change.currentRank) : "-";
            const previousBucketType = typeof change.previousBucketType === "string" ? change.previousBucketType : "-";
            const currentBucketType = typeof change.currentBucketType === "string" ? change.currentBucketType : "-";
            lines.push(
              "- " +
                contextID +
                " score " +
                previousScore +
                " -> " +
                currentScore +
                ", rank " +
                previousRank +
                " -> " +
                currentRank +
                ", type " +
                previousBucketType +
                " -> " +
                currentBucketType,
            );
          }

          return lines.join("\n");
        }

        function formatRequestScaffold(scaffold) {
          const entries = asArray(scaffold).map((entry) => asObject(entry));
          if (entries.length === 0) {
            return "No raw request scaffold recorded for this message.";
          }

          const before = entries.find((entry) => entry.stage === "before-compaction") || entries[0];
          const finalEntry = entries.find((entry) => entry.stage === "final-model-input") || entries[entries.length - 1];
          const formation = asObject(before.formation);
          const cacheStability = asObject(finalEntry.cacheStability);
          const historyTail = asArray(before.historyTail);

          const lines = [
            "stagesRecorded: " + entries.length,
            "latestUserTextChars: " + (typeof before.latestUserTextChars === "number" ? before.latestUserTextChars : 0),
            "latestUserTextPreview: " + (typeof before.latestUserTextPreview === "string" ? before.latestUserTextPreview : ""),
            "historyMessagesRouted: " + (typeof formation.historyMessages === "number" ? formation.historyMessages : historyTail.length),
            "historyTailMessages: " + historyTail.length,
            "primaryContextID: " + (typeof formation.primaryContextID === "string" ? formation.primaryContextID : "none"),
            "secondaryContextIDs: " +
              (asArray(formation.secondaryContextIDs).map((value) => String(value)).join(", ") || "none"),
            "partsBeforeCompaction: " + summarizeParts(before.messageParts),
            "compacted: " + (finalEntry.compacted === true ? "yes" : "no"),
            "partsFinalModelInput: " + summarizeParts(finalEntry.messageParts),
            "focusedContextChars: " +
              (typeof finalEntry.focusedContextChars === "number" ? String(finalEntry.focusedContextChars) : "0"),
            "cacheStablePrefix: " + (typeof cacheStability.stablePrefix === "string" ? cacheStability.stablePrefix : "none"),
            "focusedContextApplied: " + (cacheStability.focusedContextApplied === true ? "yes" : "no"),
          ];

          if (typeof finalEntry.reason === "string" && finalEntry.reason.length > 0) {
            lines.push("finalReason: " + finalEntry.reason);
          }

          return lines.join("\n");
        }

        async function loadMessageDebug(sessionID, messageID) {
          const panel = document.getElementById("message-debug-" + sessionID);
          if (!panel) {
            return;
          }
          try {
            const url =
              apiMessagePath +
              "?sessionID=" +
              encodeURIComponent(sessionID) +
              "&messageID=" +
              encodeURIComponent(messageID) +
              "&limit=160";
            const response = await fetch(url);
            if (!response.ok) {
              panel.textContent = "Failed to load message debug (" + response.status + ")";
              return;
            }
            const payload = await response.json();
            const sections = [
              "Bucket Changes\n" + formatBucketDelta(payload.bucketDelta),
              "Request Formation\n" + formatRequestScaffold(payload.rawRequestScaffold),
              "Raw Message Debug Payload\n" + JSON.stringify(payload, null, 2),
            ];
            panel.textContent = sections.join("\n\n");
          } catch (error) {
            panel.textContent = "Failed to load message debug: " + error;
          }
        }

        async function pollEvents() {
          const sessionID = activeSessionID();
          if (!sessionID) {
            return;
          }

          const tbody = document.getElementById("progression-" + sessionID);
          if (!tbody) {
            return;
          }

          const afterSeq = Number(cursors[sessionID] || 0);
          try {
            const url =
              apiEventsPath +
              "?sessionID=" +
              encodeURIComponent(sessionID) +
              "&afterSeq=" +
              afterSeq +
              "&limit=120";
            const response = await fetch(url);
            if (!response.ok) {
              return;
            }

            const payload = await response.json();
            const events = Array.isArray(payload.events) ? payload.events : [];
            if (events.length === 0) {
              return;
            }

            if (tbody.children.length === 1 && tbody.textContent.includes("Waiting for live progression events")) {
              tbody.innerHTML = "";
            }

            for (const event of events) {
              const row = document.createElement("tr");
              const at = typeof event.createdAt === "number" ? new Date(event.createdAt).toISOString() : "-";
              row.innerHTML =
                "<td>" +
                event.seq +
                "</td><td>" +
                at +
                "</td><td>" +
                event.eventType +
                "</td><td><code>" +
                event.messageID +
                "</code></td><td><code>" +
                event.payloadJSON +
                "</code></td>";
              row.style.cursor = "pointer";
              row.addEventListener("click", () => {
                loadMessageDebug(sessionID, event.messageID);
              });
              tbody.appendChild(row);
            }

            while (tbody.children.length > 200) {
              tbody.removeChild(tbody.firstChild);
            }

            const nextSeq = Number(payload.lastSeq || afterSeq);
            if (nextSeq > afterSeq) {
              cursors[sessionID] = nextSeq;
            }
          } catch {
            // Ignore transient poll failures.
          }
        }

        if (selector) {
          selector.addEventListener("change", () => {
            const value = selector.value;
            cards.forEach((card) => {
              card.classList.toggle("hidden", card.dataset.session !== value);
            });
            if (!(value in cursors)) {
              cursors[value] = 0;
            }
            pollEvents();
          });
        }

        const initial = activeSessionID();
        if (initial) {
          cursors[initial] = 0;
        }
        pollEvents();
        setInterval(pollEvents, 1500);
      </script>
    </main>
  </body>
</html>`
}
