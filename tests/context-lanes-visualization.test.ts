import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ContextLaneStore } from "../lib/context-lanes/store.js"
import { ContextLaneOrchestrator } from "../lib/context-lanes/orchestrator.js"
import {
  buildLaneVisualizationSnapshot,
  formatLaneVisualizationText,
  renderLaneVisualizationHTML,
} from "../lib/context-lanes/visualization.js"

test("buildLaneVisualizationSnapshot returns per-session lane timelines", () => {
  const dir = mkdtempSync(join(tmpdir(), "rlm-lane-visual-"))

  try {
    const store = new ContextLaneStore(dir, "lane-state.sqlite")
    const orchestrator = new ContextLaneOrchestrator(store, fetch)
    const now = 1_700_000_000_000

    const planning = store.createContext(
      "session-a",
      "Planning",
      "Plan lane summary",
      now,
      "context-plan",
    )
    const execution = store.createContext(
      "session-a",
      "Execution",
      "Execution lane summary",
      now + 200,
      "context-exec",
    )

    store.saveMemberships(
      "session-a",
      "msg-1",
      [
        {
          contextID: planning.id,
          relevance: 0.8,
          isPrimary: true,
        },
      ],
      now + 1_000,
    )
    store.saveMemberships(
      "session-a",
      "msg-2",
      [
        {
          contextID: execution.id,
          relevance: 0.92,
          isPrimary: true,
        },
      ],
      now + 2_000,
    )
    store.recordSwitch(
      "session-a",
      "msg-2",
      planning.id,
      execution.id,
      0.92,
      "score-switch",
      now + 2_000,
    )

    store.createContext("session-b", "Review", "Review lane summary", now + 3_000, "context-review")

    const snapshot = buildLaneVisualizationSnapshot(store, orchestrator, {
      sessionLimit: 5,
      contextLimit: 10,
      switchLimit: 10,
      membershipLimit: 10,
    })

    assert.equal(snapshot.sessions.length, 2)

    const sessionA = snapshot.sessions.find((session) => session.sessionID === "session-a")
    assert.ok(sessionA)
    assert.equal(sessionA?.primaryContextID, execution.id)
    assert.equal(sessionA?.contexts.length, 2)
    assert.equal(sessionA?.switches.length, 1)

    const timelineKinds = sessionA?.timeline.map((event) => event.kind)
    assert.deepEqual(timelineKinds, ["context-created", "context-created", "membership", "membership", "switch"])

    const membershipTimes = sessionA?.memberships.map((membership) => membership.createdAt) ?? []
    assert.deepEqual(membershipTimes, [...membershipTimes].sort((left, right) => left - right))

    const scoped = buildLaneVisualizationSnapshot(store, orchestrator, {
      sessionID: "session-a",
      sessionLimit: 5,
      contextLimit: 10,
      switchLimit: 10,
      membershipLimit: 10,
    })
    assert.equal(scoped.sessions.length, 1)
    assert.equal(scoped.sessions[0]?.sessionID, "session-a")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("renderLaneVisualizationHTML includes dashboard elements and serialized payload", () => {
  const snapshot = {
    generatedAt: 1_700_000_123_000,
    sessions: [
      {
        sessionID: "session-ui",
        lastActivityAt: 1_700_000_123_000,
        activeContextCount: 2,
        primaryContextID: "context-ui",
        contexts: [
          {
            sessionID: "session-ui",
            id: "context-ui",
            ownerSessionID: undefined,
            title: "UI Context",
            summary: "UI lane summary",
            status: "active" as const,
            msgCount: 4,
            lastActiveAt: 1_700_000_123_000,
            createdAt: 1_700_000_100_000,
            updatedAt: 1_700_000_123_000,
          },
        ],
        switches: [],
        memberships: [],
        timeline: [
          {
            at: 1_700_000_100_000,
            kind: "context-created" as const,
            contextID: "context-ui",
            label: "UI Context",
            detail: "Context created",
          },
        ],
      },
    ],
  }

  const html = renderLaneVisualizationHTML(snapshot)
  assert.ok(html.includes("RLM Context Lane Visualization"))
  assert.ok(html.includes("session-selector"))
  assert.ok(html.includes("session-ui"))
  assert.ok(html.includes("Formation Timeline"))
  assert.ok(html.includes("rlm-lane-visualization-data"))
})

test("formatLaneVisualizationText provides compact session summary", () => {
  const text = formatLaneVisualizationText({
    generatedAt: 1_700_000_555_000,
    sessions: [
      {
        sessionID: "session-text",
        lastActivityAt: 1_700_000_555_000,
        activeContextCount: 1,
        primaryContextID: "context-main",
        contexts: [],
        switches: [],
        memberships: [],
        timeline: [],
      },
    ],
  })

  assert.ok(text.includes("Lane visualization snapshot"))
  assert.ok(text.includes("Session session-text"))
  assert.ok(text.includes("primary=context-main"))
})
