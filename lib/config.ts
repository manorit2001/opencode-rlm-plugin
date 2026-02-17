import type { RecursiveConfig } from "./types.js"

export const DEFAULT_CONFIG: RecursiveConfig = {
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
  laneDbPath: ".opencode/rlm-context-lanes.sqlite",
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

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }

  const normalized = raw.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false
  }

  return fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
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
  const driftEmbeddingsEnabled = readBoolean(
    "RLM_PLUGIN_DRIFT_ENABLED",
    DEFAULT_CONFIG.driftEmbeddingsEnabled,
  )
  const driftMinPressure = clamp(
    readNumber("RLM_PLUGIN_DRIFT_MIN_PRESSURE", DEFAULT_CONFIG.driftMinPressure),
    0.05,
    1.2,
  )
  const driftThreshold = clamp(
    readNumber("RLM_PLUGIN_DRIFT_THRESHOLD", DEFAULT_CONFIG.driftThreshold),
    0.05,
    0.99,
  )
  const driftEmbeddingProvider = readString(
    "RLM_PLUGIN_DRIFT_PROVIDER",
    DEFAULT_CONFIG.driftEmbeddingProvider,
  )
  const driftEmbeddingModel = readString(
    "RLM_PLUGIN_DRIFT_MODEL",
    DEFAULT_CONFIG.driftEmbeddingModel,
  )
  const driftEmbeddingBaseURL = readString(
    "RLM_PLUGIN_DRIFT_BASE_URL",
    DEFAULT_CONFIG.driftEmbeddingBaseURL,
  )
  const driftEmbeddingTimeoutMs = Math.max(
    500,
    Math.floor(readNumber("RLM_PLUGIN_DRIFT_TIMEOUT_MS", DEFAULT_CONFIG.driftEmbeddingTimeoutMs)),
  )
  const driftEmbeddingMaxChars = Math.max(
    1000,
    Math.floor(readNumber("RLM_PLUGIN_DRIFT_MAX_CHARS", DEFAULT_CONFIG.driftEmbeddingMaxChars)),
  )
  const laneRoutingEnabled = readBoolean("RLM_PLUGIN_LANES_ENABLED", DEFAULT_CONFIG.laneRoutingEnabled)
  const lanePrimaryThreshold = clamp(
    readNumber("RLM_PLUGIN_LANES_PRIMARY_THRESHOLD", DEFAULT_CONFIG.lanePrimaryThreshold),
    0.05,
    0.99,
  )
  const laneSecondaryThreshold = Math.min(
    lanePrimaryThreshold,
    clamp(
      readNumber("RLM_PLUGIN_LANES_SECONDARY_THRESHOLD", DEFAULT_CONFIG.laneSecondaryThreshold),
      0.01,
      0.99,
    ),
  )
  const laneSwitchMargin = clamp(
    readNumber("RLM_PLUGIN_LANES_SWITCH_MARGIN", DEFAULT_CONFIG.laneSwitchMargin),
    0,
    0.5,
  )
  const laneMaxActive = Math.max(
    1,
    Math.floor(readNumber("RLM_PLUGIN_LANES_MAX_ACTIVE", DEFAULT_CONFIG.laneMaxActive)),
  )
  const laneSummaryMaxChars = Math.max(
    200,
    Math.floor(readNumber("RLM_PLUGIN_LANES_SUMMARY_MAX_CHARS", DEFAULT_CONFIG.laneSummaryMaxChars)),
  )
  const laneDbPath = readString("RLM_PLUGIN_LANES_DB_PATH", DEFAULT_CONFIG.laneDbPath)
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
    driftEmbeddingsEnabled,
    driftMinPressure,
    driftThreshold,
    driftEmbeddingProvider,
    driftEmbeddingModel,
    driftEmbeddingBaseURL,
    driftEmbeddingTimeoutMs,
    driftEmbeddingMaxChars,
    laneRoutingEnabled,
    lanePrimaryThreshold,
    laneSecondaryThreshold,
    laneSwitchMargin,
    laneMaxActive,
    laneSummaryMaxChars,
    laneDbPath,
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
