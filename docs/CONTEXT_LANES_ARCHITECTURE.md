# Multi-Context Lane Architecture (UML)

This document describes the current lane-routing architecture used by OpenCode RLM.
It reflects the implemented flow in `index.ts` and `lib/context-lanes/*`, including semantic reranking and lane utility tools.

## Goals

- Route each incoming message to the most relevant active lane while preserving continuity.
- Keep transform input bounded by selecting lane-relevant history plus recent tail safety context.
- Track lane assignments, primary-lane switches, and temporary manual overrides.
- Expose lane state and controls through plugin tools.

## Component Diagram

```plantuml
@startuml
skinparam componentStyle rectangle

actor "User" as User
actor "OpenCode Runtime" as Runtime

component "Plugin Entry\nindex.ts" as Entry
component "Lane Orchestrator\nlib/context-lanes/orchestrator.ts" as Orchestrator
component "Lane Router\nlib/context-lanes/router.ts" as Router
component "Semantic Reranker\nlib/context-lanes/semantic.ts" as Semantic
database "Lane Store (SQLite/fallback)\nlib/context-lanes/store.ts" as Store

component "Transform Engine\nlib/transform.ts" as Transform
component "Drift Detector\nlib/drift-embeddings.ts" as Drift
component "Focused Context Bridge\nlib/opencode-bridge.ts | lib/rlm-bridge.ts" as Bridge
component "Runtime Stats\nlib/runtime-stats.ts" as Stats

database "OpenCode Session API" as SessionAPI
component "Embedding Provider\nOllama /api/embed" as Embed

User --> Runtime : message / tool invocation
Runtime --> Entry : chat.message + lane tools

Entry --> SessionAPI : load full session history
Entry --> Orchestrator : route(session, message, latest text, history)
Orchestrator --> Store : read/update lanes, memberships, switches, overrides
Orchestrator --> Router : lexical scoring + lane selection
Router --> Semantic : optional rerank (ambiguity gate)
Semantic --> Embed : embedding calls
Orchestrator --> Entry : laneHistory + lane selection

Entry --> Transform : computeFocusedContext(laneHistory)
Transform --> Drift : optional drift check
Drift --> Embed : embedding calls
Transform --> Bridge : focused context generation
Transform --> Stats : transform counters and decision
Entry --> Stats : message/lane counters

Entry --> Runtime : prepend focused context to outgoing user message

@enduml
```

## Message Routing Sequence

```plantuml
@startuml
actor User
participant "OpenCode Runtime" as Runtime
participant "Plugin Entry" as Entry
participant "Lane Orchestrator" as Orch
participant "Lane Router" as Router
participant "Semantic Reranker" as Semantic
database "Lane Store" as Store
participant "Embedding Provider" as Embed
participant "Transform" as Transform
participant "Focused Context Bridge" as Bridge

User -> Runtime : sends message M
Runtime -> Entry : chat.message(output)
Entry -> Entry : extract latest user text
Entry -> Orch : route(sessionID, messageID, text, history)

Orch -> Store : list active lanes + latest primary
Orch -> Router : lexical scoring

alt ambiguity gate triggered
  Router -> Semantic : semantic rerank (top K)
  Semantic -> Embed : embeddings for query + candidate lanes
  Embed --> Semantic : vectors
  Semantic --> Router : similarity map
end

Router --> Orch : primary + secondary lane selection
Orch -> Store : apply manual override (if active)

alt no primary lane selected
  Orch -> Store : create new lane
else lane selected
  Orch -> Store : update lane summaries
end

Orch -> Store : save memberships
Orch -> Store : save switch event (if primary changed)
Orch -> Store : read memberships for lane history reconstruction
Orch --> Entry : laneHistory + selection

Entry -> Transform : computeFocusedContext(laneHistory)
alt compacted
  Transform -> Bridge : generate focused context
  Bridge --> Transform : focused_context
  Transform --> Entry : compacted=true
  Entry --> Runtime : prepend [RLM_FOCUSED_CONTEXT]
else no-op
  Transform --> Entry : compacted=false
end

Runtime --> User : assistant response
@enduml
```

## Lane Utility Tools Sequence

```plantuml
@startuml
actor User
participant "Runtime" as Runtime
participant "Plugin Tools" as Tools
participant "Lane Orchestrator" as Orch
database "Lane Store" as Store

User -> Runtime : contexts
Runtime -> Tools : execute `contexts`
Tools -> Orch : listContexts + currentPrimary
Orch -> Store : read lane rows
Tools --> Runtime : active lane list

User -> Runtime : contexts-switch <lane> [ttlMinutes]
Runtime -> Tools : execute `contexts-switch`
Tools -> Orch : switchContext(...)
Orch -> Store : set manual override (expires_at)
Tools --> Runtime : switch confirmation

User -> Runtime : contexts-events / contexts-clear-override / contexts-stats
Runtime -> Tools : execute tool
Tools -> Orch : list events or clear override
Orch -> Store : query/update override/events
Tools --> Runtime : formatted response
@enduml
```

## Data Model Diagram

```plantuml
@startuml
hide methods
hide stereotypes

class contexts {
  +session_id: TEXT (PK part)
  +id: TEXT (PK part)
  +title: TEXT
  +summary: TEXT
  +status: TEXT(active|archived)
  +msg_count: INTEGER
  +last_active_at: INTEGER
  +created_at: INTEGER
  +updated_at: INTEGER
}

class context_memberships {
  +session_id: TEXT (PK part)
  +message_id: TEXT (PK part)
  +context_id: TEXT (PK part)
  +relevance: REAL
  +is_primary: INTEGER
  +created_at: INTEGER
}

class context_switch_events {
  +id: INTEGER PK AUTOINCREMENT
  +session_id: TEXT
  +message_id: TEXT
  +from_context_id: TEXT
  +to_context_id: TEXT
  +confidence: REAL
  +reason: TEXT
  +created_at: INTEGER
}

class context_overrides {
  +session_id: TEXT PK
  +context_id: TEXT
  +expires_at: INTEGER
}

contexts "1" -- "many" context_memberships : context_id
contexts "1" -- "many" context_switch_events : from/to context ids
contexts "1" -- "0..1" context_overrides : active override

@enduml
```

## Lane Lifecycle (State)

```plantuml
@startuml
[*] --> Active
Active --> Active : routed as primary/secondary
Active --> Archived : manual/external archival policy
Archived --> Active : explicit reactivation
@enduml
```

## Current Implementation Notes

1. Lane store is implemented with SQLite (`node:sqlite` or `bun:sqlite`) and an in-memory fallback.
2. Routing uses lexical scoring first, with optional semantic rerank for ambiguous top candidates.
3. Lane history includes selected-lane memberships plus recent-tail safety context; it falls back to full history when too small.
4. Utility tools are implemented as `contexts`, `contexts-switch`, `contexts-clear-override`, `contexts-events`, and `contexts-stats`.
5. Archival lifecycle transitions are represented in the model, but automatic aging/archival policy is not currently enforced by the orchestrator.
