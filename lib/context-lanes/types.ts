import type { ChatMessage, RecursiveConfig } from "../types.js"

export type ContextStatus = "active" | "archived"

export interface ContextLane {
  id: string
  sessionID: string
  ownerSessionID?: string
  title: string
  summary: string
  status: ContextStatus
  msgCount: number
  lastActiveAt: number
  createdAt: number
  updatedAt: number
}

export interface ContextLaneScore {
  contextID: string
  score: number
  title: string
}

export interface ContextLaneSelection {
  primaryContextID: string
  secondaryContextIDs: string[]
  scores: ContextLaneScore[]
  createdNewContext: boolean
}

export interface MessageContextMembership {
  contextID: string
  relevance: number
  isPrimary: boolean
}

export interface ContextRoutingInput {
  sessionID: string
  messageID: string
  latestUserText: string
  history: ChatMessage[]
  config: RecursiveConfig
  now: number
}

export interface ContextRoutingResult {
  selection: ContextLaneSelection
  laneHistory: ChatMessage[]
  activeContextCount: number
  ownerRoutes: ContextOwnerRoute[]
}

export interface ContextOwnerRoute {
  ownerSessionID: string
  contextID: string
  contextTitle: string
  isPrimary: boolean
}

export interface ContextSwitchEvent {
  fromContextID: string | null
  toContextID: string
  confidence: number
  reason: string
  createdAt: number
}

export interface MessageIntentBucketAssignment {
  sessionID: string
  messageID: string
  bucketType: string
  contextID: string
  score: number
  bucketRank: number
  reason: string
  createdAt: number
}

export interface MessageProgressionStep {
  sessionID: string
  messageID: string
  stepOrder: number
  stepType: string
  detailJSON: string
  createdAt: number
}

export interface ContextSnapshotRecord {
  sessionID: string
  messageID: string
  snapshotKind: string
  snapshotIndex: number
  payloadJSON: string
  createdAt: number
}

export interface LaneEventRecord {
  seq: number
  sessionID: string
  messageID: string
  eventType: string
  payloadJSON: string
  createdAt: number
}
