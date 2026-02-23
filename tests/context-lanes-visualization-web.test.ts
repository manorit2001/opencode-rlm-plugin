import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ContextLaneOrchestrator } from "../lib/context-lanes/orchestrator.js"
import { ContextLaneStore } from "../lib/context-lanes/store.js"
import { buildLaneVisualizationSnapshot } from "../lib/context-lanes/visualization.js"
import { startLaneVisualizationWebServer } from "../lib/context-lanes/visualization-web.js"

test("lane visualization web server serves HTML dashboard and snapshot API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rlm-lane-web-"))
  const store = new ContextLaneStore(dir, "lane-state.sqlite")
  const orchestrator = new ContextLaneOrchestrator(store, fetch)
  const now = 1_700_000_000_000

  try {
    store.createContext("session-web", "Web Lane", "Dashboard lane", now, "context-web")
    store.saveMemberships(
      "session-web",
      "msg-web-1",
      [
        {
          contextID: "context-web",
          relevance: 0.95,
          isPrimary: true,
        },
      ],
      now + 1_000,
    )

    const server = await startLaneVisualizationWebServer({
      host: "127.0.0.1",
      port: 0,
      defaults: {
        sessionID: "session-web",
        sessionLimit: 8,
        contextLimit: 16,
        switchLimit: 60,
        membershipLimit: 240,
      },
      buildSnapshot: (options) => buildLaneVisualizationSnapshot(store, orchestrator, options),
      listEventsAfter: (sessionID, afterSeq, limit) => store.listLaneEventsAfter(sessionID, afterSeq, limit),
      getMessageDebug: (sessionID, messageID, limit) => ({
        intentBuckets: store.listIntentBucketAssignments(sessionID, messageID, limit),
        progression: store.listProgressionSteps(sessionID, messageID, limit),
        snapshots: store.listContextSnapshots(sessionID, messageID, null, limit),
      }),
    })

    try {
      const htmlResponse = await fetch(server.url)
      assert.equal(htmlResponse.status, 200)
      const html = await htmlResponse.text()
      assert.ok(html.includes("RLM Context Lane Visualization"))
      assert.ok(html.includes("session-selector"))
      assert.ok(html.includes("API:"))
      assert.ok(html.includes("Events:"))

      store.appendLaneEvent("session-web", "msg-web-1", "message.received", JSON.stringify({ step: 1 }), now + 2_000)
      store.appendProgressionStep(
        "session-web",
        "msg-web-1",
        "message.received",
        JSON.stringify({ step: 1 }),
        now + 2_000,
      )
      store.saveIntentBucketAssignments(
        "session-web",
        "msg-web-1",
        [
          {
            bucketType: "primary",
            contextID: "context-web",
            score: 0.95,
            bucketRank: 0,
            reason: "selected-primary",
          },
        ],
        now + 2_000,
      )
      store.saveContextSnapshot(
        "session-web",
        "msg-web-1",
        "model-input",
        0,
        JSON.stringify({ historyMessages: 1 }),
        now + 2_000,
      )

      const eventsResponse = await fetch(`${server.url}/api/events?sessionID=session-web&afterSeq=0&limit=10`)
      assert.equal(eventsResponse.status, 200)
      const eventsPayload = (await eventsResponse.json()) as {
        count: number
        events: Array<{ messageID: string; eventType: string }>
      }
      assert.equal(eventsPayload.count, 1)
      assert.equal(eventsPayload.events[0]?.messageID, "msg-web-1")
      assert.equal(eventsPayload.events[0]?.eventType, "message.received")

      const messageResponse = await fetch(`${server.url}/api/message?sessionID=session-web&messageID=msg-web-1&limit=20`)
      assert.equal(messageResponse.status, 200)
      const messagePayload = (await messageResponse.json()) as {
        intentBuckets: Array<{ bucketType: string }>
        progression: Array<{ stepType: string }>
        snapshots: Array<{ snapshotKind: string }>
      }
      assert.equal(messagePayload.intentBuckets[0]?.bucketType, "primary")
      assert.equal(messagePayload.progression[0]?.stepType, "message.received")
      assert.equal(messagePayload.snapshots[0]?.snapshotKind, "model-input")

      const apiResponse = await fetch(`${server.url}/api/snapshot`)
      assert.equal(apiResponse.status, 200)
      const snapshot = (await apiResponse.json()) as {
        sessions: Array<{ sessionID: string }>
      }
      assert.equal(snapshot.sessions.length, 1)
      assert.equal(snapshot.sessions[0]?.sessionID, "session-web")

      const healthResponse = await fetch(`${server.url}/health`)
      assert.equal(healthResponse.status, 200)
    } finally {
      await server.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("lane visualization web server honors basePath and query overrides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rlm-lane-web-base-"))
  const store = new ContextLaneStore(dir, "lane-state.sqlite")
  const orchestrator = new ContextLaneOrchestrator(store, fetch)
  const now = 1_700_000_100_000

  try {
    store.createContext("session-a", "A", "A lane", now, "context-a")
    store.createContext("session-b", "B", "B lane", now + 100, "context-b")

    const server = await startLaneVisualizationWebServer({
      host: "127.0.0.1",
      port: 0,
      basePath: "/lanes",
      defaults: {
        sessionID: "",
        sessionLimit: 8,
        contextLimit: 16,
        switchLimit: 60,
        membershipLimit: 240,
      },
      buildSnapshot: (options) => buildLaneVisualizationSnapshot(store, orchestrator, options),
      listEventsAfter: (sessionID, afterSeq, limit) => store.listLaneEventsAfter(sessionID, afterSeq, limit),
      getMessageDebug: (sessionID, messageID, limit) => ({
        intentBuckets: store.listIntentBucketAssignments(sessionID, messageID, limit),
        progression: store.listProgressionSteps(sessionID, messageID, limit),
        snapshots: store.listContextSnapshots(sessionID, messageID, null, limit),
      }),
    })

    try {
      const apiResponse = await fetch(`${server.url}/api/snapshot?sessionID=session-b&sessionLimit=1`)
      assert.equal(apiResponse.status, 200)
      const snapshot = (await apiResponse.json()) as {
        sessions: Array<{ sessionID: string }>
      }
      assert.equal(snapshot.sessions.length, 1)
      assert.equal(snapshot.sessions[0]?.sessionID, "session-b")

      const wrongBase = await fetch(`http://${server.host}:${server.port}/api/snapshot`)
      assert.equal(wrongBase.status, 404)
    } finally {
      await server.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
