# OpenCode RLM Plugin

This plugin integrates the official Recursive Language Models library (`rlms`, import path `rlm`) into OpenCode context handling.

## Behavior

- On each `chat.message` hook, it reads session history and estimates context pressure.
- If pressure is below `RLM_PLUGIN_PRESSURE_THRESHOLD`, it does nothing.
- If pressure is high enough, it generates focused context through one of two backends:
  - `RLM_PLUGIN_BACKEND=opencode`: uses OpenCode-authenticated model calls (no external provider API key required).
  - Any other backend: uses `RLM(...).completion(...)` through the Python `rlms` bridge.
- The bridge uses a simple tiered policy:
  - `shallow` tier: lower recursion budget (`RLM_PLUGIN_SHALLOW_MAX_DEPTH`, `RLM_PLUGIN_SHALLOW_MAX_ITERATIONS`).
  - `deep` tier: full recursion budget (`RLM_PLUGIN_MAX_DEPTH`, `RLM_PLUGIN_MAX_ITERATIONS`) only when pressure is very high and current goal is dense.
- Optional drift gate (embeddings): when enabled, the plugin can trigger focused-context generation even below main pressure threshold if semantic drift is detected between recent context and archived context.
- Optional context lanes (multi-context buckets): each incoming message is scored against all active lanes, can match multiple lanes, and lane-scoped history is used for focused-context generation.
- RLM returns a recursive focused context artifact.
- The plugin prepends that artifact to the current user text message as a focused context block.

This is intentionally simple: RLM is the engine, OpenCode plugin is the integration layer.

## Architecture

See `ARCHITECTURE_UML.md` for component and sequence UML diagrams.

For lane-based routing architecture and data flow diagrams, see `docs/CONTEXT_LANES_ARCHITECTURE.md`.

## Install and Enable in OpenCode

### Option A: Keyless mode with OpenCode auth (recommended)

Use this when you want to avoid external provider API keys and rely on your OpenCode-authenticated model access.

1. Install and build this plugin:

```bash
npm install
npm run build
```

2. Enable plugin from OpenCode config (`opencode.json` or `opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-rlm-plugin"]
}
```

3. Set backend to OpenCode mode:

```bash
export RLM_PLUGIN_BACKEND=opencode
```

Optional model override (otherwise plugin uses the active session model):

```bash
export RLM_PLUGIN_OPENCODE_PROVIDER_ID=openai
export RLM_PLUGIN_OPENCODE_MODEL_ID=gpt-4.1-mini
```

### Option B: Python `rlms` backend mode

1. Install Python dependency:

```bash
python3 -m pip install rlms
```

2. Install and build this plugin:

```bash
npm install
npm run build
```

3. Enable plugin from OpenCode config (`opencode.json` or `opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-rlm-plugin"]
}
```

4. Configure backend credentials expected by your selected RLM backend.

OpenCode also auto-loads local plugins from:

- Project: `.opencode/plugins/`
- Global: `~/.config/opencode/plugins/`

If you install from npm config, OpenCode resolves/install dependencies via Bun at startup.

## Requirements

### OpenCode mode (`RLM_PLUGIN_BACKEND=opencode`)

- OpenCode CLI with authenticated model access.
- No `rlms` install and no external provider API key required.

### Python `rlms` mode (default non-opencode backend)

1. Python 3.11+
2. Install official package:

```bash
pip install rlms
```

3. Configure backend credentials expected by your selected RLM backend.

## Optional Drift Gate (Ollama embeddings)

Use this to invoke RLM only when semantic drift is detected, which helps reduce unnecessary compactions and token costs.

Recommended default model:

```bash
ollama pull embeddinggemma
```

Fallback model:

```bash
ollama pull all-minilm
```

Enable drift gate:

```bash
export RLM_PLUGIN_DRIFT_ENABLED=1
export RLM_PLUGIN_DRIFT_PROVIDER=ollama
export RLM_PLUGIN_DRIFT_MODEL=embeddinggemma
export RLM_PLUGIN_DRIFT_BASE_URL=http://127.0.0.1:11434
```

Notes:

- The plugin prefers Ollama `POST /api/embed` and falls back to legacy `POST /api/embeddings` when needed.
- `/api/embed` is preferred for new setups.

## Context Lanes (multi-context routing)

Context lanes keep multiple active work buckets and route each message to the most relevant lane(s).

- Primary lane: highest-confidence context for the current message.
- Secondary lanes: additional high-similarity lanes for cross-topic overlap.
- Lane-scoped history: focused-context generation runs on lane-filtered history plus recent messages.

Lane utilities (plugin tools):

- `contexts`: show active lane count, current primary lane, and lane list.
- `contexts-switch`: temporarily force a primary lane.
- `contexts-clear-override`: return to automatic lane routing.
- `contexts-events`: show recent context switch events.
- `contexts-stats`: show live per-session runtime stats (routing runs, compactions, pressure, last decision).

## Environment Variables

- `RLM_PLUGIN_ENABLED` (`0` disables)
- `RLM_PLUGIN_PRESSURE_THRESHOLD` (default `0.72`)
- `RLM_PLUGIN_DEEP_PRESSURE_THRESHOLD` (default `0.86`)
- `RLM_PLUGIN_DEEP_GOAL_MIN_CHARS` (default `120`)
- `RLM_PLUGIN_KEEP_RECENT` (default `8`)
- `RLM_PLUGIN_MAX_ARCHIVE_CHARS` (default `60000`)
- `RLM_PLUGIN_MAX_FOCUSED_CHARS` (default `4500`)
- `RLM_PLUGIN_PYTHON_BIN` (default `python3`)
- `RLM_PLUGIN_BACKEND` (default `opencode`)
- `RLM_PLUGIN_MODEL` (default `gpt-4.1-mini`)
- `RLM_PLUGIN_ENVIRONMENT` (default `local`)
- `RLM_PLUGIN_OPENCODE_PROVIDER_ID` (optional, used only with `RLM_PLUGIN_BACKEND=opencode`)
- `RLM_PLUGIN_OPENCODE_MODEL_ID` (optional, used only with `RLM_PLUGIN_BACKEND=opencode`)
- `RLM_PLUGIN_SHALLOW_MAX_DEPTH` (default `1`)
- `RLM_PLUGIN_SHALLOW_MAX_ITERATIONS` (default `2`)
- `RLM_PLUGIN_MAX_DEPTH` (default `3`)
- `RLM_PLUGIN_MAX_ITERATIONS` (default `8`)
- `RLM_PLUGIN_TIMEOUT_MS` (default `30000`)
- `RLM_PLUGIN_DRIFT_ENABLED` (default `0`)
- `RLM_PLUGIN_DRIFT_MIN_PRESSURE` (default `0.35`)
- `RLM_PLUGIN_DRIFT_THRESHOLD` (default `0.58`)
- `RLM_PLUGIN_DRIFT_PROVIDER` (default `ollama`)
- `RLM_PLUGIN_DRIFT_MODEL` (default `embeddinggemma`)
- `RLM_PLUGIN_DRIFT_BASE_URL` (default `http://127.0.0.1:11434`)
- `RLM_PLUGIN_DRIFT_TIMEOUT_MS` (default `5000`)
- `RLM_PLUGIN_DRIFT_MAX_CHARS` (default `8000`)
- `RLM_PLUGIN_LANES_ENABLED` (default `1`)
- `RLM_PLUGIN_LANES_PRIMARY_THRESHOLD` (default `0.38`)
- `RLM_PLUGIN_LANES_SECONDARY_THRESHOLD` (default `0.3`)
- `RLM_PLUGIN_LANES_SWITCH_MARGIN` (default `0.06`)
- `RLM_PLUGIN_LANES_MAX_ACTIVE` (default `8`)
- `RLM_PLUGIN_LANES_SUMMARY_MAX_CHARS` (default `1200`)
- `RLM_PLUGIN_LANES_SEMANTIC_ENABLED` (default `0`)
- `RLM_PLUGIN_LANES_SEMANTIC_TOP_K` (default `4`)
- `RLM_PLUGIN_LANES_SEMANTIC_WEIGHT` (default `0.2`)
- `RLM_PLUGIN_LANES_SEMANTIC_AMBIGUITY_TOP_SCORE` (default `0.62`)
- `RLM_PLUGIN_LANES_SEMANTIC_AMBIGUITY_GAP` (default `0.08`)
- `RLM_PLUGIN_LANES_DB_PATH` (default `.opencode/rlm-context-lanes.sqlite`)

## Visible Narrowing Test

Run a verbose side-by-side narrowing demo test (left noisy archive, right prepared context):

```bash
npm run test:verbose-narrowing
```

Run the same demo with a recursive trajectory tree (depth/phase/chunk counts and selected-line previews):

```bash
npm run test:verbose-trajectory
```

## Troubleshooting

- Temporarily disable plugins by setting `plugin: []` in OpenCode config.
- Move plugins out of `.opencode/plugins/` or `~/.config/opencode/plugins/` to isolate issues.
- Clear OpenCode plugin cache and restart:

```bash
rm -rf ~/.cache/opencode
```
