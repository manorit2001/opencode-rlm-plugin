# RLM Plugin Architecture (UML)

This document describes the runtime architecture of the OpenCode RLM plugin, including lane-aware routing, intent buckets, session delegation/reuse, live progression events, drift-triggered compaction, and dual focused-context generation backends.

## Component Diagram

PlantUML sources:

- `docs/uml/architecture-component.puml`
- `docs/uml/architecture-component.uml`

## Sequence Diagram

PlantUML sources:

- `docs/uml/architecture-sequence.puml`
- `docs/uml/architecture-sequence.uml`

## Module Responsibilities

- `index.ts`: plugin hooks, lane tools, session fetch, lane routing, focused-context insertion, and runtime stats updates.
- `lib/config.ts`: environment-driven runtime policy for thresholds, lanes, drift, and backend selection.
- `lib/transform.ts`: pressure/drift gating, archive extraction, recursion tier selection, and focused-context generation orchestration.
- `lib/opencode-bridge.ts`: OpenCode-authenticated focused-context generation via temporary child sessions.
- `lib/rlm-bridge.ts`: Python subprocess bridge to official `rlm` package for recursive generation.
- `lib/context-lanes/*`: lane routing (`router.ts`), semantic rerank (`semantic.ts`), orchestration (`orchestrator.ts`), and persistence (`store.ts`).
- `lib/context-lanes/visualization.ts`: snapshot assembly + dashboard HTML rendering from lane/session progression data.
- `lib/context-lanes/visualization-web.ts`: web server routes for dashboard, snapshot API, health, and incremental progression endpoints.
- `lib/drift-embeddings.ts`: embedding-based semantic drift detection for compaction triggers.
- `lib/runtime-stats.ts`: per-session runtime counters and formatted observability output.
- `lib/token-estimator.ts`: lightweight token approximation used in pressure estimation.

## Architecture Additions (Current Design Target)

- Introduce deterministic intent-bucket classification before lane routing.
- Persist per-message progression artifacts in SQLite (`intent buckets`, `step progression`, `context snapshots`, append-only `lane_events`).
- Add event bus + projector path so frontend can observe live progression and replay by sequence cursor.
- Extend session-backed lanes to prefer reusing an existing owner OpenCode session, and surface delegation hints (for example `opencode -s <ownerSessionID>`) in visualization/UI output.
