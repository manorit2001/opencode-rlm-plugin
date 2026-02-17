# RLM Plugin Architecture (UML)

This document captures the runtime architecture of the OpenCode RLM plugin and the message-time interaction path.

## Component Diagram

```plantuml
@startuml
skinparam componentStyle rectangle

actor "OpenCode Runtime" as Runtime

component "Plugin Entry\nindex.ts" as Entry
component "Config Loader\nlib/config.ts" as Config
component "Transform Engine\nlib/transform.ts" as Transform
component "Token Estimator\nlib/token-estimator.ts" as Estimator
component "RLM Bridge\nlib/rlm-bridge.ts" as Bridge

node "Python Process" as PythonProc
component "Official RLM Library\nfrom rlm import RLM" as RLM
cloud "LLM Backend\n(OpenAI/others)" as Backend
database "Session History API" as SessionAPI

Runtime --> Entry : chat.message hook
Entry --> Config : getConfig()
Entry --> SessionAPI : session.messages(sessionID)
Entry --> Transform : computeFocusedContext(history, config)
Transform --> Estimator : estimateConversationTokens(messages)
Transform --> Bridge : generateFocusedContextWithRLM()
Bridge --> PythonProc : spawn python -c
PythonProc --> RLM : RLM(...).completion(prompt)
RLM --> Backend : model call(s)
Bridge --> Transform : focusedContext
Transform --> Entry : TransformRun
Entry --> Runtime : prepend [RLM_FOCUSED_CONTEXT]

@enduml
```

## Sequence Diagram

```plantuml
@startuml
actor User
participant "OpenCode Runtime" as Runtime
participant "Plugin(index.ts)" as Plugin
participant "Transform" as Transform
participant "RLM Bridge" as Bridge
participant "Python + RLM" as PyRLM
participant "LLM Backend" as Backend
database "Session API" as Session

User -> Runtime : Sends message
Runtime -> Plugin : chat.message(output)
Plugin -> Session : messages(sessionID)
Session --> Plugin : history
Plugin -> Transform : computeFocusedContext(history, config)
Transform -> Transform : estimate pressure

alt pressure below threshold
  Transform --> Plugin : compacted=false
  Plugin --> Runtime : no change
else pressure above threshold
  Transform -> Bridge : generateFocusedContextWithRLM(archive, goal)
  Bridge -> PyRLM : spawn + payload
  PyRLM -> Backend : recursive completion
  Backend --> PyRLM : completion result
  PyRLM --> Bridge : {focused_context}
  Bridge --> Transform : focusedContext
  Transform --> Plugin : compacted=true
  Plugin -> Plugin : prepend focused context tag
  Plugin --> Runtime : modified message parts
end

Runtime --> User : Assistant response uses focused context
@enduml
```

## Module Responsibilities

- `index.ts`: hook integration, session fetch, and focused-context insertion into outgoing user text.
- `lib/config.ts`: environment-driven runtime policy and bridge settings.
- `lib/transform.ts`: pressure gating, archive extraction, goal detection, bridge orchestration.
- `lib/rlm-bridge.ts`: subprocess bridge to official Python RLM package and response validation.
- `lib/token-estimator.ts`: lightweight token approximation used for pressure detection.
