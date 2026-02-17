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
- RLM returns a recursive focused context artifact.
- The plugin prepends that artifact to the current user text message as a focused context block.

This is intentionally simple: RLM is the engine, OpenCode plugin is the integration layer.

## Architecture

See `ARCHITECTURE_UML.md` for component and sequence UML diagrams.

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
