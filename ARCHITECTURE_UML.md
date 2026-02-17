# RLM Plugin Architecture (UML)

This document describes the current runtime architecture of the OpenCode RLM plugin, including lane-aware routing, drift-triggered compaction, and dual focused-context generation backends.

## Component Diagram

```plantuml
@startuml
skinparam componentStyle rectangle

actor "User" as User
actor "OpenCode Runtime" as Runtime

component "Plugin Entry\nindex.ts" as Entry
component "Config Loader\nlib/config.ts" as Config
component "Runtime Stats\nlib/runtime-stats.ts" as Stats

component "Lane Orchestrator\nlib/context-lanes/orchestrator.ts" as Orchestrator
component "Lane Router\nlib/context-lanes/router.ts" as Router
component "Lane Semantic Rerank\nlib/context-lanes/semantic.ts" as LaneSemantic
database "Lane Store (SQLite/fallback)\nlib/context-lanes/store.ts" as LaneStore

component "Transform Engine\nlib/transform.ts" as Transform
component "Token Estimator\nlib/token-estimator.ts" as Estimator
component "Drift Detector\nlib/drift-embeddings.ts" as Drift

component "OpenCode Bridge\nlib/opencode-bridge.ts" as OCBridge
component "Python Bridge\nlib/rlm-bridge.ts" as PyBridge
node "Python Process" as PythonProc
component "Official RLM Library\nfrom rlm import RLM" as RLM

component "Embedding Provider\nOllama /api/embed" as Embed
cloud "Model Backend" as Backend
database "OpenCode Session API" as SessionAPI

User --> Runtime : sends message / runs tools
Runtime --> Entry : chat.message + tool hooks
Entry --> Config : getConfig()
Entry --> Stats : update counters
Entry --> SessionAPI : session.messages(sessionID)

Entry --> Orchestrator : route(...) (if lanes enabled)
Orchestrator --> Router : score contexts
Router --> LaneSemantic : rerank candidates (if ambiguous)
LaneSemantic --> Embed : embedding calls
Orchestrator --> LaneStore : list/update lanes, memberships, switches
Orchestrator --> Entry : laneHistory + selection

Entry --> Transform : computeFocusedContext(historyForTransform, config)
Transform --> Estimator : estimateConversationTokens(...)
Transform --> Drift : detect drift (optional)
Drift --> Embed : embedding calls

Transform --> OCBridge : generate (backend=opencode)
OCBridge --> SessionAPI : create temp session + prompt + delete
OCBridge --> Backend : provider/model call via OpenCode auth

Transform --> PyBridge : generate (backend=python)
PyBridge --> PythonProc : spawn python -c
PythonProc --> RLM : RLM(...).completion(prompt)
RLM --> Backend : recursive completion

OCBridge --> Transform : focusedContext
PyBridge --> Transform : focusedContext
Transform --> Entry : TransformRun
Entry --> Runtime : prepend [RLM_FOCUSED_CONTEXT]

@enduml
```

## Sequence Diagram

```plantuml
@startuml
actor User
participant "OpenCode Runtime" as Runtime
participant "Plugin (index.ts)" as Plugin
database "Session API" as Session
participant "Lane Orchestrator" as Orchestrator
database "Lane Store" as LaneStore
participant "Transform" as Transform
participant "Drift Detector" as Drift
participant "Embedding Provider" as Embed
participant "OpenCode Bridge" as OCBridge
participant "Python Bridge" as PyBridge
participant "Model Backend" as Backend

User -> Runtime : sends message
Runtime -> Plugin : chat.message(output)

Plugin -> Plugin : skip if internal focused-context prompt
Plugin -> Session : messages(sessionID)
Session --> Plugin : history

alt lanes enabled and latest user text exists
  Plugin -> Orchestrator : route(sessionID, messageID, text, history)
  Orchestrator -> LaneStore : list active lanes + latest primary
  Orchestrator -> Orchestrator : lexical scoring
  alt lexical routing ambiguous and semantic enabled
    Orchestrator -> Embed : semantic embeddings (top candidates)
    Embed --> Orchestrator : similarities
  end
  Orchestrator -> LaneStore : save memberships/switch events
  Orchestrator --> Plugin : laneHistory
else lanes disabled
  Plugin -> Plugin : use full history
end

Plugin -> Transform : computeFocusedContext(historyForTransform, config)
Transform -> Transform : estimate pressure + build archive/recent

alt below pressure threshold and drift enabled
  Transform -> Drift : detectContextDrift(...)
  Drift -> Embed : drift embeddings
  Embed --> Drift : vectors
  Drift --> Transform : drift assessment
end

alt no pressure trigger and no drift trigger
  Transform --> Plugin : compacted=false
  Plugin --> Runtime : no message changes
else focused context needed
  alt backend = opencode
    Transform -> OCBridge : generateFocusedContextWithOpenCodeAuth(...)
    OCBridge -> Session : create temp child session + prompt
    Session -> Backend : model call
    Backend --> Session : response
    OCBridge -> Session : delete temp session
    OCBridge --> Transform : focusedContext
  else backend = python
    Transform -> PyBridge : generateFocusedContextWithRLM(...)
    PyBridge -> Backend : recursive completion via Python RLM
    Backend --> PyBridge : response
    PyBridge --> Transform : focusedContext
  end

  Transform --> Plugin : compacted=true + focusedContext
  Plugin -> Plugin : prepend [RLM_FOCUSED_CONTEXT]
  Plugin --> Runtime : modified user message parts
end

Runtime --> User : assistant response uses focused context
@enduml
```

## Module Responsibilities

- `index.ts`: plugin hooks, lane tools, session fetch, lane routing, focused-context insertion, and runtime stats updates.
- `lib/config.ts`: environment-driven runtime policy for thresholds, lanes, drift, and backend selection.
- `lib/transform.ts`: pressure/drift gating, archive extraction, recursion tier selection, and focused-context generation orchestration.
- `lib/opencode-bridge.ts`: OpenCode-authenticated focused-context generation via temporary child sessions.
- `lib/rlm-bridge.ts`: Python subprocess bridge to official `rlm` package for recursive generation.
- `lib/context-lanes/*`: lane routing (`router.ts`), semantic rerank (`semantic.ts`), orchestration (`orchestrator.ts`), and persistence (`store.ts`).
- `lib/drift-embeddings.ts`: embedding-based semantic drift detection for compaction triggers.
- `lib/runtime-stats.ts`: per-session runtime counters and formatted observability output.
- `lib/token-estimator.ts`: lightweight token approximation used in pressure estimation.
