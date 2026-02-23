# Multi-Context Lane Architecture (UML)

This document describes the lane-routing architecture used by OpenCode RLM.
It reflects implemented flow in `index.ts` and `lib/context-lanes/*`, and the active design target for intent buckets, session delegation/reuse, and live progression visualization.

## Goals

- Route each incoming message to the most relevant active lane while preserving continuity.
- Classify each message into deterministic intent buckets before routing.
- Keep transform input bounded by selecting lane-relevant history plus recent tail safety context.
- Track lane assignments, primary-lane switches, and temporary manual overrides.
- Expose lane state, live progression, and delegation hints through plugin tools and web visualization.

## Component Diagram

PlantUML sources:

- `docs/uml/context-lanes-component.puml`
- `docs/uml/context-lanes-component.uml`

## Message Routing Sequence

PlantUML sources:

- `docs/uml/context-lanes-message-routing-sequence.puml`
- `docs/uml/context-lanes-message-routing-sequence.uml`

## Lane Utility Tools Sequence

PlantUML sources:

- `docs/uml/context-lanes-tools-sequence.puml`
- `docs/uml/context-lanes-tools-sequence.uml`

## Data Model Diagram

PlantUML sources:

- `docs/uml/context-lanes-data-model.puml`
- `docs/uml/context-lanes-data-model.uml`

## Lane Lifecycle (State)

PlantUML sources:

- `docs/uml/context-lanes-lifecycle-state.puml`
- `docs/uml/context-lanes-lifecycle-state.uml`

## Current Implementation Notes

1. Lane store is implemented with SQLite (`node:sqlite` or `bun:sqlite`) and an in-memory fallback.
2. Routing uses lexical scoring first, with optional semantic rerank for ambiguous top candidates.
3. Lane history includes selected-lane memberships plus recent-tail safety context; it falls back to full history when too small.
4. Utility tools are implemented as `contexts`, `contexts-switch`, `contexts-clear-override`, `contexts-events`, `contexts-stats`, and `contexts-efficiency`.
5. Visualization tooling currently serves lane snapshots over HTTP (`/`, `/api/snapshot`, `/health`) with base-path support.
6. Session-backed lanes are available via `RLM_PLUGIN_LANES_SESSION_BUCKETS_ENABLED`; owner-session links are persisted in lane records.
7. Active design target includes an append-only progression/event ledger, incremental event APIs (`/api/events?afterSeq=`), and per-message context snapshots for replay/static analysis.
