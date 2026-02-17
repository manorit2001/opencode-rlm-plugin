import test from "node:test"
import assert from "node:assert/strict"
import { scoreContextsForMessage, selectContextLanes } from "../lib/context-lanes/router.js"
import type { ContextLane } from "../lib/context-lanes/types.js"
import type { RecursiveConfig } from "../lib/types.js"

const BASE_CONFIG: RecursiveConfig = {
  enabled: true,
  pressureThreshold: 0.72,
  deepPressureThreshold: 0.86,
  deepGoalMinChars: 120,
  driftEmbeddingsEnabled: false,
  driftMinPressure: 0.35,
  driftThreshold: 0.58,
  driftEmbeddingProvider: "ollama",
  driftEmbeddingModel: "embeddinggemma",
  driftEmbeddingBaseURL: "http://127.0.0.1:11434",
  driftEmbeddingTimeoutMs: 5000,
  driftEmbeddingMaxChars: 8000,
  laneRoutingEnabled: true,
  lanePrimaryThreshold: 0.25,
  laneSecondaryThreshold: 0.16,
  laneSwitchMargin: 0.06,
  laneMaxActive: 8,
  laneSummaryMaxChars: 1200,
  laneDbPath: ".opencode/rlm-context-lanes.sqlite",
  keepRecentMessages: 8,
  maxArchiveChars: 60000,
  maxFocusedContextChars: 4500,
  pythonBin: "python3",
  backend: "opencode",
  model: "gpt-4.1-mini",
  environment: "local",
  opencodeProviderID: undefined,
  opencodeModelID: undefined,
  shallowMaxDepth: 1,
  shallowMaxIterations: 2,
  maxDepth: 3,
  maxIterations: 8,
  timeoutMs: 30000,
}

function lane(id: string, title: string, summary: string, now: number): ContextLane {
  return {
    id,
    sessionID: "session-1",
    title,
    summary,
    status: "active",
    msgCount: 4,
    lastActiveAt: now,
    createdAt: now,
    updatedAt: now,
  }
}

test("router scores all contexts and supports primary+secondary selection", () => {
  const now = Date.now()
  const contexts: ContextLane[] = [
    lane(
      "backend",
      "Backend Auth Migration",
      "Keep opencode backend default and preserve bridge cleanup in finally.",
      now,
    ),
    lane("tests", "Regression Tests", "Verify bridge tests and migration checks.", now - 10_000),
    lane("ui", "UI Polish", "Discuss hero gradient and typography updates.", now - 20_000),
  ]

  const scores = scoreContextsForMessage(
    "Finalize backend auth migration and update bridge tests for keyless opencode mode.",
    contexts,
    now,
  )
  const selected = selectContextLanes(scores, null, BASE_CONFIG)
  const testsScore = scores.find((score) => score.contextID === "tests")?.score ?? 0
  const uiScore = scores.find((score) => score.contextID === "ui")?.score ?? 0

  assert.equal(scores.length, 3)
  assert.equal(selected.primaryContextID, "backend")
  assert.ok(testsScore > uiScore)
  assert.equal(selected.secondaryContextIDs.includes("ui"), false)
})

test("router keeps current primary when score gap is within hysteresis margin", () => {
  const selected = selectContextLanes(
    [
      { contextID: "new-context", score: 0.62, title: "New" },
      { contextID: "current-context", score: 0.59, title: "Current" },
      { contextID: "other", score: 0.21, title: "Other" },
    ],
    "current-context",
    BASE_CONFIG,
  )

  assert.equal(selected.primaryContextID, "current-context")
  assert.ok(selected.secondaryContextIDs.includes("new-context"))
})

test("router returns no primary when all scores are below primary threshold", () => {
  const selected = selectContextLanes(
    [{ contextID: "x", score: 0.1, title: "x" }],
    null,
    { ...BASE_CONFIG, lanePrimaryThreshold: 0.2 },
  )

  assert.equal(selected.primaryContextID, null)
  assert.deepEqual(selected.secondaryContextIDs, [])
})

test("router switches primary when new score exceeds hysteresis margin", () => {
  const selected = selectContextLanes(
    [
      { contextID: "new-context", score: 0.74, title: "New" },
      { contextID: "current-context", score: 0.59, title: "Current" },
      { contextID: "other", score: 0.3, title: "Other" },
    ],
    "current-context",
    BASE_CONFIG,
  )

  assert.equal(selected.primaryContextID, "new-context")
  assert.equal(selected.secondaryContextIDs.includes("current-context"), false)
})

test("router keeps only top two qualified secondaries", () => {
  const selected = selectContextLanes(
    [
      { contextID: "primary", score: 0.8, title: "Primary" },
      { contextID: "s1", score: 0.72, title: "Secondary1" },
      { contextID: "s2", score: 0.69, title: "Secondary2" },
      { contextID: "s3", score: 0.66, title: "Secondary3" },
    ],
    null,
    BASE_CONFIG,
  )

  assert.equal(selected.primaryContextID, "primary")
  assert.deepEqual(selected.secondaryContextIDs, ["s1", "s2"])
})
