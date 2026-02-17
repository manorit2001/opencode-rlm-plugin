# Multi-Context Lane Architecture (UML)

This document describes a simple, modular lane-based context system for OpenCode RLM.
It focuses on data flow, routing, and observability while keeping inference overhead low.

## Goals

- Route each incoming message to one or more active context lanes.
- Keep lane context bounded and relevant before focused-context generation.
- Preserve full session history while operating on compact lane-specific working context.
- Expose lane state and switches through plugin utilities.

## Component Diagram

```plantuml
@startuml
skinparam componentStyle rectangle

actor "User" as User
actor "OpenCode Runtime" as Runtime

component "Plugin Entry\nindex.ts" as Entry
component "Lane Orchestrator\nlib/context-lanes/orchestrator.ts" as Orchestrator
component "Lane Router\nlib/context-lanes/router.ts" as Router
component "Lane Summarizer\nlib/context-lanes/summarizer.ts" as Summarizer
component "Transform Engine\nlib/transform.ts" as Transform
component "Drift Detector\nlib/drift-embeddings.ts" as Drift
component "Focused Context Bridge\nlib/opencode-bridge.ts | lib/rlm-bridge.ts" as FocusBridge
component "Slash Utilities\nplugin tool hooks" as Utilities

database "SQLite Lane Store\nlib/context-lanes/store.ts" as Store
component "Embedding Provider\nOllama /api/embed" as Embed
database "OpenCode Session API" as SessionAPI

User --> Runtime : message / slash utility
Runtime --> Entry : chat.message/tool invocation

Entry --> SessionAPI : read session history
Entry --> Orchestrator : process message + history
Orchestrator --> Router : score lanes
Router --> Embed : optional embed(message)
Router --> Store : read lane summaries/centroids
Orchestrator --> Store : persist memberships/switch events
Orchestrator --> Summarizer : refresh lane summary (as needed)
Summarizer --> FocusBridge : optional model summarization
Summarizer --> Store : save summary + centroid

Orchestrator --> Transform : computeFocusedContext(lane scoped)
Transform --> Drift : optional drift check
Transform --> FocusBridge : focused context generation
Transform --> Entry : compacted focused context

Entry --> Runtime : prepend focused context to outgoing user message
Entry --> Utilities : expose lane status and controls
Utilities --> Store : query/update lanes

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
database "SQLite Store" as Store
participant "Embedding Provider" as Embed
participant "Transform" as Transform
participant "Focused Context Bridge" as Bridge

User -> Runtime : sends message M
Runtime -> Entry : chat.message(output)
Entry -> Orch : handle(M, sessionID)
Orch -> Store : load active lanes + summaries
Orch -> Router : route(M, lanes)

alt lexical continuity decisive
  Router --> Orch : lane scores (no embed)
else ambiguous
  Router -> Embed : embed(M)
  Embed --> Router : vector
  Router --> Orch : lane scores + memberships
end

alt no lane above threshold
  Orch -> Store : create new lane
else lane(s) selected
  Orch -> Store : save memberships
end

Orch -> Store : save switch event (if primary changed)
Orch -> Transform : computeFocusedContext(lane scoped history)

alt focused context needed
  Transform -> Bridge : generate focused context
  Bridge --> Transform : focused_context
  Transform --> Orch : compacted context
else no compaction
  Transform --> Orch : no-op
end

Orch --> Entry : primary lane + focused context
Entry --> Runtime : updated outgoing parts
Runtime --> User : assistant response
@enduml
```

## Slash Utility Sequence

```plantuml
@startuml
actor User
participant "Runtime" as Runtime
participant "Plugin Utilities" as Utilities
database "SQLite Store" as Store

User -> Runtime : /contexts
Runtime -> Utilities : execute tool
Utilities -> Store : count active lanes
Store --> Utilities : lane summary rows
Utilities --> Runtime : active lane count + list

User -> Runtime : /contexts switch <lane>
Runtime -> Utilities : execute tool
Utilities -> Store : set lane override + event
Utilities --> Runtime : switch confirmation
@enduml
```

## Data Model Diagram

```plantuml
@startuml
hide methods
hide stereotypes

class contexts {
  +id: TEXT PK
  +session_id: TEXT
  +title: TEXT
  +summary: TEXT
  +status: TEXT(active|archived)
  +embedding_model: TEXT
  +centroid_json: TEXT
  +msg_count: INTEGER
  +last_active_at: INTEGER
  +created_at: INTEGER
  +updated_at: INTEGER
}

class context_memberships {
  +id: INTEGER PK
  +session_id: TEXT
  +message_id: TEXT
  +context_id: TEXT FK
  +relevance: REAL
  +is_primary: INTEGER
  +created_at: INTEGER
}

class context_switch_events {
  +id: INTEGER PK
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

class context_embeddings_cache {
  +id: INTEGER PK
  +text_hash: TEXT
  +model: TEXT
  +vector_json: TEXT
  +created_at: INTEGER
}

contexts "1" -- "many" context_memberships
contexts "1" -- "many" context_switch_events
contexts "1" -- "many" context_overrides

@enduml
```

## Lane Lifecycle (State)

```plantuml
@startuml
[*] --> Active
Active --> Active : receives relevant messages
Active --> Cooling : no primary hits for TTL
Cooling --> Active : receives relevant message
Cooling --> Archived : inactivity timeout reached
Archived --> Active : explicitly reactivated
@enduml
```

## Implementation Order

1. Add SQLite lane store and migrations.
2. Add router service (scores, thresholds, multi-membership).
3. Add orchestrator and integrate with `chat.message` path.
4. Add utility tools (`/contexts`, `/contexts list`, `/contexts switch`, `/contexts explain`).
5. Add switch event feed for UI surface.
6. Add tests for routing, lane creation, switch hysteresis, and utility output.
