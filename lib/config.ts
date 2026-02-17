import type { RecursiveConfig } from "./types.js"

export const DEFAULT_CONFIG: RecursiveConfig = {
  enabled: true,
  pressureThreshold: 0.72,
  deepPressureThreshold: 0.86,
  deepGoalMinChars: 120,
  keepRecentMessages: 8,
  maxArchiveChars: 60000,
  maxFocusedContextChars: 4500,
  pythonBin: "python3",
  backend: "opencode",
  model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
  environment: "local",
  shallowMaxDepth: 1,
  shallowMaxIterations: 2,
  maxDepth: 3,
  maxIterations: 8,
  timeoutMs: 30000,
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const value = Number(raw)
  if (!Number.isFinite(value)) {
    return fallback
  }

  return value
}

function readString(name: string, fallback: string): string {
  const raw = process.env[name]
  if (!raw || raw.trim().length === 0) {
    return fallback
  }

  return raw.trim()
}

function readOptionalString(name: string): string | undefined {
  const raw = process.env[name]
  if (!raw || raw.trim().length === 0) {
    return undefined
  }

  return raw.trim()
}

export function getConfig(): RecursiveConfig {
  const enabled = process.env.RLM_PLUGIN_ENABLED !== "0"
  const pressureThreshold = Math.max(
    0.1,
    readNumber("RLM_PLUGIN_PRESSURE_THRESHOLD", DEFAULT_CONFIG.pressureThreshold),
  )
  const deepPressureThreshold = Math.max(
    pressureThreshold,
    readNumber("RLM_PLUGIN_DEEP_PRESSURE_THRESHOLD", DEFAULT_CONFIG.deepPressureThreshold),
  )
  const deepGoalMinChars = Math.max(
    20,
    Math.floor(readNumber("RLM_PLUGIN_DEEP_GOAL_MIN_CHARS", DEFAULT_CONFIG.deepGoalMinChars)),
  )
  const keepRecentMessages = Math.max(
    2,
    Math.floor(readNumber("RLM_PLUGIN_KEEP_RECENT", DEFAULT_CONFIG.keepRecentMessages)),
  )
  const maxArchiveChars = Math.max(
    2000,
    Math.floor(readNumber("RLM_PLUGIN_MAX_ARCHIVE_CHARS", DEFAULT_CONFIG.maxArchiveChars)),
  )
  const maxFocusedContextChars = Math.max(
    500,
    Math.floor(readNumber("RLM_PLUGIN_MAX_FOCUSED_CHARS", DEFAULT_CONFIG.maxFocusedContextChars)),
  )
  const shallowMaxDepth = Math.max(
    1,
    Math.floor(readNumber("RLM_PLUGIN_SHALLOW_MAX_DEPTH", DEFAULT_CONFIG.shallowMaxDepth)),
  )
  const shallowMaxIterations = Math.max(
    1,
    Math.floor(
      readNumber("RLM_PLUGIN_SHALLOW_MAX_ITERATIONS", DEFAULT_CONFIG.shallowMaxIterations),
    ),
  )
  const maxDepth = Math.max(1, Math.floor(readNumber("RLM_PLUGIN_MAX_DEPTH", DEFAULT_CONFIG.maxDepth)))
  const maxIterations = Math.max(
    1,
    Math.floor(readNumber("RLM_PLUGIN_MAX_ITERATIONS", DEFAULT_CONFIG.maxIterations)),
  )
  const timeoutMs = Math.max(1000, Math.floor(readNumber("RLM_PLUGIN_TIMEOUT_MS", DEFAULT_CONFIG.timeoutMs)))
  const pythonBin = readString("RLM_PLUGIN_PYTHON_BIN", DEFAULT_CONFIG.pythonBin)
  const backend = readString("RLM_PLUGIN_BACKEND", DEFAULT_CONFIG.backend)
  const model = readString("RLM_PLUGIN_MODEL", DEFAULT_CONFIG.model)
  const environment = readString("RLM_PLUGIN_ENVIRONMENT", DEFAULT_CONFIG.environment)
  const opencodeProviderID = readOptionalString("RLM_PLUGIN_OPENCODE_PROVIDER_ID")
  const opencodeModelID = readOptionalString("RLM_PLUGIN_OPENCODE_MODEL_ID")

  return {
    ...DEFAULT_CONFIG,
    enabled,
    pressureThreshold,
    deepPressureThreshold,
    deepGoalMinChars,
    keepRecentMessages,
    maxArchiveChars,
    maxFocusedContextChars,
    pythonBin,
    backend,
    model,
    environment,
    opencodeProviderID,
    opencodeModelID,
    shallowMaxDepth,
    shallowMaxIterations,
    maxDepth,
    maxIterations,
    timeoutMs,
  }
}
