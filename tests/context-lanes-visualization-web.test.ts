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
    store.createContext("session-web", "Web Lane Secondary", "Secondary lane", now + 100, "context-web-2")
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
      getMessageDebug: (sessionID, messageID, limit) => {
        const intentDebug = store.listIntentBucketAssignmentsWithDelta(sessionID, messageID, limit)
        const snapshots = store.listContextSnapshots(sessionID, messageID, null, limit)
        return {
          intentBuckets: intentDebug.currentBuckets,
          previousIntentBuckets: intentDebug.previousBuckets,
          bucketDelta: intentDebug.delta,
          progression: store.listProgressionSteps(sessionID, messageID, limit),
          snapshots,
          rawRequestScaffold: snapshots
            .filter((snapshot) => snapshot.snapshotKind === "raw-request-scaffold")
            .map((snapshot) => JSON.parse(snapshot.payloadJSON)),
        }
      },
    })

    try {
      const htmlResponse = await fetch(server.url)
      assert.equal(htmlResponse.status, 200)
      const html = await htmlResponse.text()
      assert.ok(html.includes("RLM Context Lane Visualization"))
      assert.ok(html.includes("session-selector"))
      assert.ok(html.includes("API:"))
      assert.ok(html.includes("Events:"))
      assert.ok(html.includes("Prompt Cache Risk"))

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
        "msg-web-0",
        [
          {
            bucketType: "primary",
            contextID: "context-web",
            score: 0.9,
            bucketRank: 0,
            reason: "selected-primary",
          },
        ],
        now + 1_900,
      )
      store.saveIntentBucketAssignments(
        "session-web",
        "msg-web-1",
        [
          {
            bucketType: "primary",
            contextID: "context-web-2",
            score: 0.95,
            bucketRank: 0,
            reason: "selected-primary",
          },
          {
            bucketType: "secondary",
            contextID: "context-web",
            score: 0.91,
            bucketRank: 1,
            reason: "selected-secondary",
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
      store.saveContextSnapshot(
        "session-web",
        "msg-web-1",
        "raw-request-scaffold",
        0,
        JSON.stringify({
          stage: "before-compaction",
          latestUserTextChars: 12,
          messageParts: [{ index: 0, type: "text", textChars: 12, textPreview: "hello lanes" }],
          formation: {
            historyMessages: 1,
            primaryContextID: "context-web-2",
            secondaryContextIDs: ["context-web"],
          },
        }),
        now + 2_001,
      )
      store.saveContextSnapshot(
        "session-web",
        "msg-web-1",
        "raw-request-scaffold",
        1,
        JSON.stringify({
          stage: "final-model-input",
          compacted: true,
          focusedContextChars: 36,
          messageParts: [{ index: 0, type: "text", textChars: 48, textPreview: "focused + hello lanes" }],
          cacheStability: {
            stablePrefix: "<focused_context>",
            focusedContextApplied: true,
          },
        }),
        now + 2_002,
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
        intentBuckets: Array<{ bucketType: string; contextID: string }>
        previousIntentBuckets: Array<{ contextID: string }>
        bucketDelta: {
          previousMessageID: string | null
          primaryChanged: boolean
          addedContextIDs: string[]
          changedContexts: Array<{ contextID: string }>
        }
        rawRequestScaffold: Array<{ stage: string }>
        cacheRisk: {
          score: number
          level: "low" | "medium" | "high"
          reasons: string[]
          inputs: {
            stablePrefixPresent: boolean
            focusedContextApplied: boolean
          }
        }
        progression: Array<{ stepType: string }>
        snapshots: Array<{ snapshotKind: string }>
      }
      assert.equal(messagePayload.intentBuckets[0]?.bucketType, "primary")
      assert.equal(messagePayload.intentBuckets[0]?.contextID, "context-web-2")
      assert.equal(messagePayload.previousIntentBuckets.length, 1)
      assert.equal(messagePayload.bucketDelta.previousMessageID, "msg-web-0")
      assert.equal(messagePayload.bucketDelta.primaryChanged, true)
      assert.deepEqual(messagePayload.bucketDelta.addedContextIDs, ["context-web-2"])
      assert.equal(messagePayload.bucketDelta.changedContexts[0]?.contextID, "context-web")
      assert.equal(messagePayload.rawRequestScaffold.length, 2)
      assert.equal(messagePayload.rawRequestScaffold[0]?.stage, "before-compaction")
      assert.ok(messagePayload.cacheRisk.score >= 0 && messagePayload.cacheRisk.score <= 100)
      assert.equal(messagePayload.cacheRisk.level, "medium")
      assert.equal(messagePayload.cacheRisk.inputs.stablePrefixPresent, true)
      assert.equal(messagePayload.cacheRisk.inputs.focusedContextApplied, true)
      assert.ok(messagePayload.cacheRisk.reasons.includes("primary-context-switch"))
      assert.equal(messagePayload.progression[0]?.stepType, "message.received")
      assert.ok(messagePayload.snapshots.some((snapshot) => snapshot.snapshotKind === "model-input"))
      assert.ok(messagePayload.snapshots.some((snapshot) => snapshot.snapshotKind === "raw-request-scaffold"))

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
      getMessageDebug: (sessionID, messageID, limit) => {
        const intentDebug = store.listIntentBucketAssignmentsWithDelta(sessionID, messageID, limit)
        const snapshots = store.listContextSnapshots(sessionID, messageID, null, limit)
        return {
          intentBuckets: intentDebug.currentBuckets,
          previousIntentBuckets: intentDebug.previousBuckets,
          bucketDelta: intentDebug.delta,
          progression: store.listProgressionSteps(sessionID, messageID, limit),
          snapshots,
          rawRequestScaffold: snapshots
            .filter((snapshot) => snapshot.snapshotKind === "raw-request-scaffold")
            .map((snapshot) => JSON.parse(snapshot.payloadJSON)),
        }
      },
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
