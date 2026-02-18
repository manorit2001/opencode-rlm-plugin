import test from "node:test"
import assert from "node:assert/strict"
import { computeFocusedContext } from "../lib/transform.js"
import type { ChatMessage, RecursiveConfig } from "../lib/types.js"

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
  lanePrimaryThreshold: 0.38,
  laneSecondaryThreshold: 0.3,
  laneSwitchMargin: 0.06,
  laneMaxActive: 8,
  laneSummaryMaxChars: 1200,
  laneSemanticEnabled: false,
  laneSemanticTopK: 4,
  laneSemanticWeight: 0.2,
  laneSemanticAmbiguityTopScore: 0.62,
  laneSemanticAmbiguityGap: 0.08,
  laneDbPath: ".opencode/rlm-context-lanes.sqlite",
  keepRecentMessages: 2,
  maxArchiveChars: 5000,
  maxFocusedContextChars: 400,
  pythonBin: "python3",
  backend: "opencode",
  model: "gpt-4.1-mini",
  environment: "local",
  shallowMaxDepth: 1,
  shallowMaxIterations: 2,
  maxDepth: 3,
  maxIterations: 8,
  timeoutMs: 10000,
}

function textMessage(role: string, text: string): ChatMessage {
  return {
    role,
    parts: [{ type: "text", text }],
  }
}

test("computeFocusedContext skips compaction when pressure is low", async () => {
  const messages: ChatMessage[] = [
    textMessage("user", "Short prompt"),
    textMessage("assistant", "Short reply"),
  ]

  let called = false
  const run = await computeFocusedContext(messages, BASE_CONFIG, 1_000_000, async () => {
    called = true
    return { focusedContext: "unexpected" }
  })

  assert.equal(run.compacted, false)
  assert.equal(run.focusedContext, null)
  assert.equal(called, false)
})

test("computeFocusedContext uses shallow recursion for moderate pressure", async () => {
  const messages: ChatMessage[] = [
    textMessage("assistant", "[RLM_FOCUSED_CONTEXT]\nstale summary"),
    textMessage("user", "Old constraint: preserve file layout."),
    textMessage("assistant", "Old finding: parser fails on null metadata."),
    textMessage("user", "Implement retry handling"),
    textMessage("assistant", "Acknowledged"),
  ]

  let archiveArg = ""
  let goalArg = ""
  let maxDepthArg = -1
  let maxIterationsArg = -1
  const run = await computeFocusedContext(
    messages,
    { ...BASE_CONFIG, pressureThreshold: 0.1, deepPressureThreshold: 0.9 },
    100,
    async function (archiveContext, latestGoal) {
      const runtimeConfig = arguments[2] as
        | { maxDepth?: number; maxIterations?: number }
        | undefined
      archiveArg = archiveContext
      goalArg = latestGoal
      maxDepthArg = typeof runtimeConfig?.maxDepth === "number" ? runtimeConfig.maxDepth : -1
      maxIterationsArg =
        typeof runtimeConfig?.maxIterations === "number" ? runtimeConfig.maxIterations : -1
      return { focusedContext: "Focused: retry handling with backoff." }
    },
  )

  assert.equal(run.compacted, true)
  assert.equal(run.focusedContext, "Focused: retry handling with backoff.")
  assert.equal(goalArg, "Implement retry handling")
  assert.equal(archiveArg.includes("stale summary"), false)
  assert.equal(archiveArg.includes("Old constraint: preserve file layout."), true)
  assert.equal(maxDepthArg, 1)
  assert.equal(maxIterationsArg, 2)
})

test("computeFocusedContext uses deep recursion for dense goals under high pressure", async () => {
  const denseGoal =
    "Refactor the command execution pipeline to split planner and executor responsibilities, add retry-aware telemetry fields, preserve existing API compatibility, and include migration notes for plugin consumers."

  const messages: ChatMessage[] = [
    textMessage("assistant", "Historical observation A"),
    textMessage("assistant", "Historical observation B"),
    textMessage("user", denseGoal),
  ]

  let maxDepthArg = -1
  let maxIterationsArg = -1
  const run = await computeFocusedContext(
    messages,
    {
      ...BASE_CONFIG,
      keepRecentMessages: 1,
      pressureThreshold: 0.1,
      deepPressureThreshold: 0.2,
      deepGoalMinChars: 40,
    },
    10,
    async function (_archiveContext, latestGoal) {
      const runtimeConfig = arguments[2] as
        | { maxDepth?: number; maxIterations?: number }
        | undefined
      maxDepthArg = typeof runtimeConfig?.maxDepth === "number" ? runtimeConfig.maxDepth : -1
      maxIterationsArg =
        typeof runtimeConfig?.maxIterations === "number" ? runtimeConfig.maxIterations : -1
      assert.equal(latestGoal, denseGoal)
      return { focusedContext: "Focused: preserve API compatibility and add telemetry fields." }
    },
  )

  assert.equal(run.compacted, true)
  assert.equal(maxDepthArg, BASE_CONFIG.maxDepth)
  assert.equal(maxIterationsArg, BASE_CONFIG.maxIterations)
})

test("computeFocusedContext returns no-op when generator throws", async () => {
  const messages: ChatMessage[] = [
    textMessage("user", "Historic context A"),
    textMessage("assistant", "Historic context B"),
    textMessage("user", "Current goal"),
  ]

  const run = await computeFocusedContext(
    messages,
    { ...BASE_CONFIG, pressureThreshold: 0.1, keepRecentMessages: 1 },
    10,
    async () => {
      throw new Error("bridge failure")
    },
  )

  assert.equal(run.compacted, false)
  assert.equal(run.focusedContext, null)
})

test("computeFocusedContext can trigger via drift when pressure gate is not met", async () => {
  const messages: ChatMessage[] = [
    textMessage("assistant", "Historic context A"),
    textMessage("assistant", "Historic context B"),
    textMessage("user", "Need final migration details"),
  ]

  let called = false
  const run = await computeFocusedContext(
    messages,
    {
      ...BASE_CONFIG,
      pressureThreshold: 0.95,
      driftEmbeddingsEnabled: true,
      driftMinPressure: 0.1,
      keepRecentMessages: 1,
    },
    100,
    async () => {
      called = true
      return { focusedContext: "Drift-triggered focused context" }
    },
    async () => ({ drifted: true, score: 0.92 }),
  )

  assert.equal(called, true)
  assert.equal(run.compacted, true)
  assert.equal(run.focusedContext, "Drift-triggered focused context")
})

test("computeFocusedContext does not trigger when drift score says no drift", async () => {
  const messages: ChatMessage[] = [
    textMessage("assistant", "Historic context A"),
    textMessage("assistant", "Historic context B"),
    textMessage("user", "Need final migration details"),
  ]

  let called = false
  const run = await computeFocusedContext(
    messages,
    {
      ...BASE_CONFIG,
      pressureThreshold: 0.95,
      driftEmbeddingsEnabled: true,
      driftMinPressure: 0.1,
      keepRecentMessages: 1,
    },
    100,
    async () => {
      called = true
      return { focusedContext: "unexpected" }
    },
    async () => ({ drifted: false, score: 0.18 }),
  )

  assert.equal(called, false)
  assert.equal(run.compacted, false)
  assert.equal(run.focusedContext, null)
})

test("computeFocusedContext uses latest compacted context as canonical archive vector", async () => {
  const messages: ChatMessage[] = [
    textMessage("user", "Legacy thread detail: old migration checklist."),
    textMessage("assistant", "Legacy thread detail: old cache notes."),
    textMessage(
      "user",
      [
        "[RLM_FOCUSED_CONTEXT]",
        "Focused summary: keep KV continuity for migration lane.",
        "- preserve context routing stability",
        "- reuse focused vector after compaction",
        "",
        "Continue migration work with stable cache behavior.",
      ].join("\n"),
    ),
    textMessage("assistant", "Post-compaction update: add regression tests for cache continuity."),
    textMessage("user", "Current goal: validate cache hits after compaction."),
  ]

  let archiveArg = ""
  const run = await computeFocusedContext(
    messages,
    {
      ...BASE_CONFIG,
      pressureThreshold: 0.1,
      keepRecentMessages: 1,
    },
    20,
    async (archiveContext) => {
      archiveArg = archiveContext
      return { focusedContext: "Focused: keep post-compaction cache hits stable." }
    },
  )

  assert.equal(run.compacted, true)
  assert.ok(archiveArg.includes("Focused summary: keep KV continuity for migration lane."))
  assert.ok(archiveArg.includes("Post-compaction update: add regression tests for cache continuity."))
  assert.equal(archiveArg.includes("Legacy thread detail: old migration checklist."), false)
  assert.equal(archiveArg.includes("Legacy thread detail: old cache notes."), false)
})

test("computeFocusedContext keeps post-compaction archive deterministic across replays", async () => {
  const messages: ChatMessage[] = [
    textMessage("assistant", "Historic context: lane scoring details."),
    textMessage(
      "user",
      [
        "[RLM_FOCUSED_CONTEXT]",
        "Focused summary: lane A is the canonical cache vector.",
        "- preserve deterministic arrival order",
        "",
        "Continue with lane A validations.",
      ].join("\n"),
    ),
    textMessage("assistant", "Loop checkpoint: keep lane A stable."),
    textMessage("user", "Loop checkpoint: keep lane A stable."),
  ]

  const archives: string[] = []
  async function runOnce(): Promise<void> {
    await computeFocusedContext(
      messages,
      {
        ...BASE_CONFIG,
        pressureThreshold: 0.1,
        keepRecentMessages: 1,
      },
      20,
      async (archiveContext) => {
        archives.push(archiveContext)
        return { focusedContext: "Focused: preserve lane A continuity." }
      },
    )
  }

  await runOnce()
  await runOnce()

  assert.equal(archives.length, 2)
  assert.equal(archives[0], archives[1])
  assert.ok(archives[0].includes("Focused summary: lane A is the canonical cache vector."))
  assert.equal(archives[0].includes("Historic context: lane scoring details."), false)
})
