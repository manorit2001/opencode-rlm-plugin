export const DEFAULT_CONFIG = {
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
    laneMinHistoryTokenRatio: 0.75,
    laneVisualizationSessionLimit: 8,
    laneVisualizationContextLimit: 16,
    laneVisualizationSwitchLimit: 60,
    laneVisualizationMembershipLimit: 240,
    laneVisualizationOutputPath: ".opencode/rlm-context-lanes-visualization.html",
    laneVisualizationWebHost: "127.0.0.1",
    laneVisualizationWebPort: 3799,
    laneVisualizationWebBasePath: "/",
    laneDbPath: ".opencode/rlm-context-lanes.sqlite",
    laneBucketsUseSessions: false,
    laneSessionTitlePrefix: "Project",
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
};
function readNumber(name, fallback) {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
        return fallback;
    }
    return value;
}
function readString(name, fallback) {
    const raw = process.env[name];
    if (!raw || raw.trim().length === 0) {
        return fallback;
    }
    return raw.trim();
}
function readOptionalString(name) {
    const raw = process.env[name];
    if (!raw || raw.trim().length === 0) {
        return undefined;
    }
    return raw.trim();
}
function readBoolean(name, fallback) {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
    }
    return fallback;
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
export function getConfig() {
    const enabled = process.env.RLM_PLUGIN_ENABLED !== "0";
    const pressureThreshold = Math.max(0.1, readNumber("RLM_PLUGIN_PRESSURE_THRESHOLD", DEFAULT_CONFIG.pressureThreshold));
    const deepPressureThreshold = Math.max(pressureThreshold, readNumber("RLM_PLUGIN_DEEP_PRESSURE_THRESHOLD", DEFAULT_CONFIG.deepPressureThreshold));
    const deepGoalMinChars = Math.max(20, Math.floor(readNumber("RLM_PLUGIN_DEEP_GOAL_MIN_CHARS", DEFAULT_CONFIG.deepGoalMinChars)));
    const driftEmbeddingsEnabled = readBoolean("RLM_PLUGIN_DRIFT_ENABLED", DEFAULT_CONFIG.driftEmbeddingsEnabled);
    const driftMinPressure = clamp(readNumber("RLM_PLUGIN_DRIFT_MIN_PRESSURE", DEFAULT_CONFIG.driftMinPressure), 0.05, 1.2);
    const driftThreshold = clamp(readNumber("RLM_PLUGIN_DRIFT_THRESHOLD", DEFAULT_CONFIG.driftThreshold), 0.05, 0.99);
    const driftEmbeddingProvider = readString("RLM_PLUGIN_DRIFT_PROVIDER", DEFAULT_CONFIG.driftEmbeddingProvider);
    const driftEmbeddingModel = readString("RLM_PLUGIN_DRIFT_MODEL", DEFAULT_CONFIG.driftEmbeddingModel);
    const driftEmbeddingBaseURL = readString("RLM_PLUGIN_DRIFT_BASE_URL", DEFAULT_CONFIG.driftEmbeddingBaseURL);
    const driftEmbeddingTimeoutMs = Math.max(500, Math.floor(readNumber("RLM_PLUGIN_DRIFT_TIMEOUT_MS", DEFAULT_CONFIG.driftEmbeddingTimeoutMs)));
    const driftEmbeddingMaxChars = Math.max(1000, Math.floor(readNumber("RLM_PLUGIN_DRIFT_MAX_CHARS", DEFAULT_CONFIG.driftEmbeddingMaxChars)));
    const laneRoutingEnabled = readBoolean("RLM_PLUGIN_LANES_ENABLED", DEFAULT_CONFIG.laneRoutingEnabled);
    const lanePrimaryThreshold = clamp(readNumber("RLM_PLUGIN_LANES_PRIMARY_THRESHOLD", DEFAULT_CONFIG.lanePrimaryThreshold), 0.05, 0.99);
    const laneSecondaryThreshold = Math.min(lanePrimaryThreshold, clamp(readNumber("RLM_PLUGIN_LANES_SECONDARY_THRESHOLD", DEFAULT_CONFIG.laneSecondaryThreshold), 0.01, 0.99));
    const laneSwitchMargin = clamp(readNumber("RLM_PLUGIN_LANES_SWITCH_MARGIN", DEFAULT_CONFIG.laneSwitchMargin), 0, 0.5);
    const laneMaxActive = Math.max(1, Math.floor(readNumber("RLM_PLUGIN_LANES_MAX_ACTIVE", DEFAULT_CONFIG.laneMaxActive)));
    const laneSummaryMaxChars = Math.max(200, Math.floor(readNumber("RLM_PLUGIN_LANES_SUMMARY_MAX_CHARS", DEFAULT_CONFIG.laneSummaryMaxChars)));
    const laneSemanticEnabled = readBoolean("RLM_PLUGIN_LANES_SEMANTIC_ENABLED", DEFAULT_CONFIG.laneSemanticEnabled);
    const laneSemanticTopK = Math.max(2, Math.floor(readNumber("RLM_PLUGIN_LANES_SEMANTIC_TOP_K", DEFAULT_CONFIG.laneSemanticTopK)));
    const laneSemanticWeight = clamp(readNumber("RLM_PLUGIN_LANES_SEMANTIC_WEIGHT", DEFAULT_CONFIG.laneSemanticWeight), 0, 1);
    const laneSemanticAmbiguityTopScore = clamp(readNumber("RLM_PLUGIN_LANES_SEMANTIC_AMBIGUITY_TOP_SCORE", DEFAULT_CONFIG.laneSemanticAmbiguityTopScore), 0.05, 0.99);
    const laneSemanticAmbiguityGap = clamp(readNumber("RLM_PLUGIN_LANES_SEMANTIC_AMBIGUITY_GAP", DEFAULT_CONFIG.laneSemanticAmbiguityGap), 0, 0.5);
    const laneMinHistoryTokenRatio = clamp(readNumber("RLM_PLUGIN_LANES_MIN_HISTORY_TOKEN_RATIO", DEFAULT_CONFIG.laneMinHistoryTokenRatio ?? 0.75), 0, 1);
    const laneVisualizationSessionLimit = Math.max(1, Math.floor(readNumber("RLM_PLUGIN_LANES_VIS_SESSION_LIMIT", DEFAULT_CONFIG.laneVisualizationSessionLimit ?? 8)));
    const laneVisualizationContextLimit = Math.max(1, Math.floor(readNumber("RLM_PLUGIN_LANES_VIS_CONTEXT_LIMIT", DEFAULT_CONFIG.laneVisualizationContextLimit ?? 16)));
    const laneVisualizationSwitchLimit = Math.max(1, Math.floor(readNumber("RLM_PLUGIN_LANES_VIS_SWITCH_LIMIT", DEFAULT_CONFIG.laneVisualizationSwitchLimit ?? 60)));
    const laneVisualizationMembershipLimit = Math.max(1, Math.floor(readNumber("RLM_PLUGIN_LANES_VIS_MEMBERSHIP_LIMIT", DEFAULT_CONFIG.laneVisualizationMembershipLimit ?? 240)));
    const laneVisualizationOutputPath = readString("RLM_PLUGIN_LANES_VIS_OUTPUT_PATH", DEFAULT_CONFIG.laneVisualizationOutputPath ?? ".opencode/rlm-context-lanes-visualization.html");
    const laneVisualizationWebHost = readString("RLM_PLUGIN_LANES_VIS_WEB_HOST", DEFAULT_CONFIG.laneVisualizationWebHost ?? "127.0.0.1");
    const laneVisualizationWebPort = Math.max(1, Math.floor(readNumber("RLM_PLUGIN_LANES_VIS_WEB_PORT", DEFAULT_CONFIG.laneVisualizationWebPort ?? 3799)));
    const laneVisualizationWebBasePath = readString("RLM_PLUGIN_LANES_VIS_WEB_BASE_PATH", DEFAULT_CONFIG.laneVisualizationWebBasePath ?? "/");
    const laneDbPath = readString("RLM_PLUGIN_LANES_DB_PATH", DEFAULT_CONFIG.laneDbPath);
    const laneBucketsUseSessions = readBoolean("RLM_PLUGIN_LANES_SESSION_BUCKETS_ENABLED", DEFAULT_CONFIG.laneBucketsUseSessions ?? false);
    const laneSessionTitlePrefix = readString("RLM_PLUGIN_LANES_SESSION_TITLE_PREFIX", DEFAULT_CONFIG.laneSessionTitlePrefix ?? "Project");
    const keepRecentMessages = Math.max(2, Math.floor(readNumber("RLM_PLUGIN_KEEP_RECENT", DEFAULT_CONFIG.keepRecentMessages)));
    const maxArchiveChars = Math.max(2000, Math.floor(readNumber("RLM_PLUGIN_MAX_ARCHIVE_CHARS", DEFAULT_CONFIG.maxArchiveChars)));
    const maxFocusedContextChars = Math.max(500, Math.floor(readNumber("RLM_PLUGIN_MAX_FOCUSED_CHARS", DEFAULT_CONFIG.maxFocusedContextChars)));
    const shallowMaxDepth = Math.max(1, Math.floor(readNumber("RLM_PLUGIN_SHALLOW_MAX_DEPTH", DEFAULT_CONFIG.shallowMaxDepth)));
    const shallowMaxIterations = Math.max(1, Math.floor(readNumber("RLM_PLUGIN_SHALLOW_MAX_ITERATIONS", DEFAULT_CONFIG.shallowMaxIterations)));
    const maxDepth = Math.max(1, Math.floor(readNumber("RLM_PLUGIN_MAX_DEPTH", DEFAULT_CONFIG.maxDepth)));
    const maxIterations = Math.max(1, Math.floor(readNumber("RLM_PLUGIN_MAX_ITERATIONS", DEFAULT_CONFIG.maxIterations)));
    const timeoutMs = Math.max(1000, Math.floor(readNumber("RLM_PLUGIN_TIMEOUT_MS", DEFAULT_CONFIG.timeoutMs)));
    const pythonBin = readString("RLM_PLUGIN_PYTHON_BIN", DEFAULT_CONFIG.pythonBin);
    const backend = readString("RLM_PLUGIN_BACKEND", DEFAULT_CONFIG.backend);
    const model = readString("RLM_PLUGIN_MODEL", DEFAULT_CONFIG.model);
    const environment = readString("RLM_PLUGIN_ENVIRONMENT", DEFAULT_CONFIG.environment);
    const opencodeProviderID = readOptionalString("RLM_PLUGIN_OPENCODE_PROVIDER_ID");
    const opencodeModelID = readOptionalString("RLM_PLUGIN_OPENCODE_MODEL_ID");
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
        laneSemanticEnabled,
        laneSemanticTopK,
        laneSemanticWeight,
        laneSemanticAmbiguityTopScore,
        laneSemanticAmbiguityGap,
        laneMinHistoryTokenRatio,
        laneVisualizationSessionLimit,
        laneVisualizationContextLimit,
        laneVisualizationSwitchLimit,
        laneVisualizationMembershipLimit,
        laneVisualizationOutputPath,
        laneVisualizationWebHost,
        laneVisualizationWebPort,
        laneVisualizationWebBasePath,
        laneDbPath,
        laneBucketsUseSessions,
        laneSessionTitlePrefix,
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
    };
}
