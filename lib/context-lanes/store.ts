import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import type {
  ContextLane,
  ContextSnapshotRecord,
  ContextStatus,
  ContextSwitchEvent,
  LaneEventRecord,
  MessageContextMembership,
  MessageIntentBucketAssignment,
  MessageProgressionStep,
} from "./types.js"

interface StatementLike {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

interface DatabaseLike {
  exec(sql: string): void
  prepare(sql: string): StatementLike
}

type DatabaseCtor = new (path: string) => DatabaseLike
type SQLiteModuleName = "node:sqlite" | "bun:sqlite"

interface LoadedSQLiteBackend {
  moduleName: SQLiteModuleName
  createDatabase(path: string): DatabaseLike
}

interface MembershipRow {
  message_id: string
  context_id: string
}

interface MembershipEventRow {
  message_id: string
  context_id: string
  relevance: number
  is_primary: number
  created_at: number
}

interface SessionActivityRow {
  session_id: string
  last_activity_at: number
}

interface ContextRow {
  id: string
  session_id: string
  owner_session_id: string | null
  title: string
  summary: string
  status: ContextStatus
  msg_count: number
  last_active_at: number
  created_at: number
  updated_at: number
}

interface SwitchRow {
  from_context_id: string | null
  to_context_id: string
  confidence: number
  reason: string
  created_at: number
}

interface IntentBucketRow {
  session_id: string
  message_id: string
  bucket_type: string
  context_id: string
  score: number
  bucket_rank: number
  reason: string
  created_at: number
}

interface ProgressionStepRow {
  session_id: string
  message_id: string
  step_order: number
  step_type: string
  detail_json: string
  created_at: number
}

interface ContextSnapshotRow {
  session_id: string
  message_id: string
  snapshot_kind: string
  snapshot_index: number
  payload_json: string
  created_at: number
}

interface LaneEventRow {
  seq: number
  session_id: string
  message_id: string
  event_type: string
  payload_json: string
  created_at: number
}

interface FallbackMembership {
  sessionID: string
  messageID: string
  contextID: string
  relevance: number
  isPrimary: boolean
  createdAt: number
}

export interface SessionActivity {
  sessionID: string
  lastActivityAt: number
}

export interface ContextMembershipEvent {
  messageID: string
  contextID: string
  relevance: number
  isPrimary: boolean
  createdAt: number
}

interface FallbackSwitch {
  sessionID: string
  messageID: string
  fromContextID: string | null
  toContextID: string
  confidence: number
  reason: string
  createdAt: number
}

interface FallbackOverride {
  sessionID: string
  contextID: string
  expiresAt: number
}

interface FallbackIntentBucket {
  sessionID: string
  messageID: string
  bucketType: string
  contextID: string
  score: number
  bucketRank: number
  reason: string
  createdAt: number
}

interface FallbackProgressionStep {
  sessionID: string
  messageID: string
  stepOrder: number
  stepType: string
  detailJSON: string
  createdAt: number
}

interface FallbackContextSnapshot {
  sessionID: string
  messageID: string
  snapshotKind: string
  snapshotIndex: number
  payloadJSON: string
  createdAt: number
}

interface FallbackLaneEvent {
  seq: number
  sessionID: string
  messageID: string
  eventType: string
  payloadJSON: string
  createdAt: number
}

const require = createRequire(import.meta.url)

function resolveDBPath(baseDirectory: string, dbPath: string): string {
  return isAbsolute(dbPath) ? dbPath : resolve(baseDirectory, dbPath)
}

function toContextLane(row: ContextRow): ContextLane {
  return {
    id: row.id,
    sessionID: row.session_id,
    ownerSessionID: row.owner_session_id ?? undefined,
    title: row.title,
    summary: row.summary,
    status: row.status,
    msgCount: row.msg_count,
    lastActiveAt: row.last_active_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function isDatabaseCtor(value: unknown): value is DatabaseCtor {
  return typeof value === "function"
}

function loadDatabaseCtor(moduleName: SQLiteModuleName, exportName: string): DatabaseCtor | null {
  try {
    const loaded = require(moduleName) as Record<string, unknown>
    const exported = loaded[exportName]
    if (isDatabaseCtor(exported)) {
      return exported
    }

    const defaultExport = loaded.default
    if (moduleName === "bun:sqlite" && isDatabaseCtor(defaultExport)) {
      return defaultExport
    }
  } catch {
    return null
  }

  return null
}

function loadDatabaseBackend(): LoadedSQLiteBackend | null {
  if (process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE === "1" || process.env.RLM_PLUGIN_DISABLE_SQLITE === "1") {
    return null
  }

  const nodeCtor = loadDatabaseCtor("node:sqlite", "DatabaseSync")
  if (nodeCtor) {
    return {
      moduleName: "node:sqlite",
      createDatabase(path: string) {
        return new nodeCtor(path)
      },
    }
  }

  const bunCtor = loadDatabaseCtor("bun:sqlite", "Database")
  if (bunCtor) {
    return {
      moduleName: "bun:sqlite",
      createDatabase(path: string) {
        return new bunCtor(path)
      },
    }
  }

  return null
}

export class ContextLaneStore {
  private readonly db: DatabaseLike | null
  private readonly fallbackContexts: ContextLane[] = []
  private readonly fallbackMemberships: FallbackMembership[] = []
  private readonly fallbackSwitches: FallbackSwitch[] = []
  private readonly fallbackOverrides: FallbackOverride[] = []
  private readonly fallbackIntentBuckets: FallbackIntentBucket[] = []
  private readonly fallbackProgressionSteps: FallbackProgressionStep[] = []
  private readonly fallbackContextSnapshots: FallbackContextSnapshot[] = []
  private readonly fallbackLaneEvents: FallbackLaneEvent[] = []
  private fallbackLaneEventSeq = 1

  constructor(baseDirectory: string, dbPath: string) {
    const resolved = resolveDBPath(baseDirectory, dbPath)
    mkdirSync(dirname(resolved), { recursive: true })

    const backend = loadDatabaseBackend()
    if (!backend) {
      this.db = null
      if (process.env.RLM_PLUGIN_DEBUG === "1") {
        console.warn("RLM context lanes: sqlite backends unavailable, using in-memory store")
      }
      return
    }

    this.db = backend.createDatabase(resolved)
    if (process.env.RLM_PLUGIN_DEBUG === "1") {
      console.warn(`RLM context lanes: using ${backend.moduleName} backend`)
    }
    this.db.exec("PRAGMA journal_mode = WAL")
    this.ensureSchema()
  }

  private ensureSchema(): void {
    const db = this.db
    if (!db) {
      return
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS contexts (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        owner_session_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        msg_count INTEGER NOT NULL DEFAULT 0,
        last_active_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, id)
      );

      CREATE TABLE IF NOT EXISTS context_memberships (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        relevance REAL NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, message_id, context_id)
      );

      CREATE INDEX IF NOT EXISTS idx_context_memberships_session_time
        ON context_memberships (session_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_context_memberships_message
        ON context_memberships (session_id, message_id);

      CREATE TABLE IF NOT EXISTS context_switch_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        from_context_id TEXT,
        to_context_id TEXT NOT NULL,
        confidence REAL NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_context_switch_events_session_time
        ON context_switch_events (session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS context_overrides (
        session_id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_intent_buckets (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        bucket_type TEXT NOT NULL,
        context_id TEXT NOT NULL,
        score REAL NOT NULL,
        bucket_rank INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, message_id, bucket_type, context_id)
      );

      CREATE INDEX IF NOT EXISTS idx_message_intent_buckets_message
        ON message_intent_buckets (session_id, message_id, bucket_rank ASC);

      CREATE TABLE IF NOT EXISTS message_step_progression (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        step_order INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, message_id, step_order)
      );

      CREATE INDEX IF NOT EXISTS idx_message_step_progression_message
        ON message_step_progression (session_id, message_id, step_order ASC);

      CREATE TABLE IF NOT EXISTS context_snapshots (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        snapshot_kind TEXT NOT NULL,
        snapshot_index INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, message_id, snapshot_kind, snapshot_index)
      );

      CREATE INDEX IF NOT EXISTS idx_context_snapshots_message
        ON context_snapshots (session_id, message_id, snapshot_kind, snapshot_index ASC);

      CREATE TABLE IF NOT EXISTS lane_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lane_events_session_seq
        ON lane_events (session_id, seq ASC);
    `)

    try {
      db.exec(`ALTER TABLE contexts ADD COLUMN owner_session_id TEXT`)
    } catch {
    }
  }

  countActiveContexts(sessionID: string): number {
    const db = this.db
    if (!db) {
      return this.fallbackContexts.filter((context) => context.sessionID === sessionID && context.status === "active")
        .length
    }

    const row = db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM contexts
         WHERE session_id = ? AND status = 'active'`,
      )
      .get(sessionID) as { count?: number } | undefined

    return row?.count ?? 0
  }

  listSessions(limit: number): SessionActivity[] {
    const normalizedLimit = Math.max(1, Math.floor(limit))
    const db = this.db
    if (!db) {
      const bySession = new Map<string, number>()

      for (const context of this.fallbackContexts) {
        const previous = bySession.get(context.sessionID) ?? 0
        bySession.set(context.sessionID, Math.max(previous, context.lastActiveAt))
      }

      for (const membership of this.fallbackMemberships) {
        const previous = bySession.get(membership.sessionID) ?? 0
        bySession.set(membership.sessionID, Math.max(previous, membership.createdAt))
      }

      for (const event of this.fallbackSwitches) {
        const previous = bySession.get(event.sessionID) ?? 0
        bySession.set(event.sessionID, Math.max(previous, event.createdAt))
      }

      return [...bySession.entries()]
        .map(([sessionID, lastActivityAt]) => ({ sessionID, lastActivityAt }))
        .sort((left, right) => {
          if (right.lastActivityAt !== left.lastActivityAt) {
            return right.lastActivityAt - left.lastActivityAt
          }
          return left.sessionID.localeCompare(right.sessionID)
        })
        .slice(0, normalizedLimit)
    }

    const rows = db
      .prepare(
        `SELECT session_id, MAX(ts) AS last_activity_at
         FROM (
           SELECT session_id, last_active_at AS ts FROM contexts
           UNION ALL
           SELECT session_id, created_at AS ts FROM context_memberships
           UNION ALL
           SELECT session_id, created_at AS ts FROM context_switch_events
         )
         GROUP BY session_id
         ORDER BY last_activity_at DESC, session_id ASC
         LIMIT ?`,
      )
      .all(normalizedLimit) as unknown as SessionActivityRow[]

    return rows.map((row) => ({
      sessionID: row.session_id,
      lastActivityAt: row.last_activity_at,
    }))
  }

  listActiveContexts(sessionID: string, limit: number): ContextLane[] {
    const db = this.db
    if (!db) {
      return this.fallbackContexts
        .filter((context) => context.sessionID === sessionID && context.status === "active")
        .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
        .slice(0, limit)
        .map((context) => ({ ...context }))
    }

    const rows = db
      .prepare(
        `SELECT id, session_id, owner_session_id, title, summary, status, msg_count, last_active_at, created_at, updated_at
         FROM contexts
         WHERE session_id = ? AND status = 'active'
         ORDER BY last_active_at DESC
         LIMIT ?`,
      )
      .all(sessionID, limit) as unknown as ContextRow[]

    return rows.map(toContextLane)
  }

  listContexts(sessionID: string, limit: number): ContextLane[] {
    const db = this.db
    if (!db) {
      return this.fallbackContexts
        .filter((context) => context.sessionID === sessionID)
        .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
        .slice(0, limit)
        .map((context) => ({ ...context }))
    }

    const rows = db
      .prepare(
        `SELECT id, session_id, owner_session_id, title, summary, status, msg_count, last_active_at, created_at, updated_at
         FROM contexts
         WHERE session_id = ?
         ORDER BY last_active_at DESC
         LIMIT ?`,
      )
      .all(sessionID, limit) as unknown as ContextRow[]

    return rows.map(toContextLane)
  }

  getContext(sessionID: string, contextID: string): ContextLane | null {
    const db = this.db
    if (!db) {
      const lane = this.fallbackContexts.find((context) => context.sessionID === sessionID && context.id === contextID)
      return lane ? { ...lane } : null
    }

    const row = db
      .prepare(
        `SELECT id, session_id, owner_session_id, title, summary, status, msg_count, last_active_at, created_at, updated_at
         FROM contexts
         WHERE session_id = ? AND id = ?`,
      )
      .get(sessionID, contextID) as ContextRow | undefined

    return row ? toContextLane(row) : null
  }

  createContext(
    sessionID: string,
    title: string,
    summary: string,
    now: number,
    preferredContextID?: string,
    ownerSessionID?: string,
  ): ContextLane {
    const candidateID = typeof preferredContextID === "string" ? preferredContextID.trim() : ""
    const id = candidateID.length > 0 ? candidateID : randomUUID()
    const normalizedOwnerSessionID = typeof ownerSessionID === "string" && ownerSessionID.trim().length > 0 ? ownerSessionID.trim() : undefined
    const db = this.db
    if (!db) {
      const lane: ContextLane = {
        id,
        sessionID,
        ownerSessionID: normalizedOwnerSessionID,
        title,
        summary,
        status: "active",
        msgCount: 0,
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
      }
      this.fallbackContexts.push(lane)
      return { ...lane }
    }

    db
      .prepare(
        `INSERT INTO contexts (session_id, id, owner_session_id, title, summary, status, msg_count, last_active_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
      )
      .run(sessionID, id, normalizedOwnerSessionID ?? null, title, summary, now, now, now)

    return {
      id,
      sessionID,
      ownerSessionID: normalizedOwnerSessionID,
      title,
      summary,
      status: "active",
      msgCount: 0,
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now,
    }
  }

  updateContextSummary(sessionID: string, contextID: string, summary: string, now: number): void {
    const db = this.db
    if (!db) {
      const lane = this.fallbackContexts.find((context) => context.sessionID === sessionID && context.id === contextID)
      if (!lane) {
        return
      }
      lane.summary = summary
      lane.msgCount += 1
      lane.lastActiveAt = now
      lane.updatedAt = now
      return
    }

    db
      .prepare(
        `UPDATE contexts
         SET summary = ?,
             msg_count = msg_count + 1,
             last_active_at = ?,
             updated_at = ?
         WHERE session_id = ? AND id = ?`,
      )
      .run(summary, now, now, sessionID, contextID)
  }

  latestPrimaryContextID(sessionID: string): string | null {
    const db = this.db
    if (!db) {
      const latest = this.fallbackMemberships
        .filter((membership) => membership.sessionID === sessionID && membership.isPrimary)
        .sort((left, right) => right.createdAt - left.createdAt)[0]

      return latest?.contextID ?? null
    }

    const row = db
      .prepare(
        `SELECT context_id
         FROM context_memberships
         WHERE session_id = ? AND is_primary = 1
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(sessionID) as { context_id?: string } | undefined

    return row?.context_id ?? null
  }

  saveMemberships(
    sessionID: string,
    messageID: string,
    memberships: MessageContextMembership[],
    now: number,
  ): void {
    const db = this.db
    if (!db) {
      for (const membership of memberships) {
        const existing = this.fallbackMemberships.find(
          (item) =>
            item.sessionID === sessionID &&
            item.messageID === messageID &&
            item.contextID === membership.contextID,
        )

        if (existing) {
          existing.relevance = membership.relevance
          existing.isPrimary = membership.isPrimary
          existing.createdAt = now
          continue
        }

        this.fallbackMemberships.push({
          sessionID,
          messageID,
          contextID: membership.contextID,
          relevance: membership.relevance,
          isPrimary: membership.isPrimary,
          createdAt: now,
        })
      }
      return
    }

    const statement = db.prepare(
      `INSERT OR REPLACE INTO context_memberships (
        session_id,
        message_id,
        context_id,
        relevance,
        is_primary,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )

    for (const membership of memberships) {
      statement.run(
        sessionID,
        messageID,
        membership.contextID,
        membership.relevance,
        membership.isPrimary ? 1 : 0,
        now,
      )
    }
  }

  getMembershipContextMap(sessionID: string, messageIDs: string[]): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>()
    if (messageIDs.length === 0) {
      return map
    }

    const db = this.db
    if (!db) {
      const messageIDSet = new Set(messageIDs)
      for (const membership of this.fallbackMemberships) {
        if (membership.sessionID !== sessionID || !messageIDSet.has(membership.messageID)) {
          continue
        }

        const set = map.get(membership.messageID) ?? new Set<string>()
        set.add(membership.contextID)
        map.set(membership.messageID, set)
      }
      return map
    }

    const placeholders = messageIDs.map(() => "?").join(",")
    const statement = db.prepare(
      `SELECT message_id, context_id
       FROM context_memberships
       WHERE session_id = ?
         AND message_id IN (${placeholders})`,
    )

    const rows = statement.all(sessionID, ...messageIDs) as unknown as MembershipRow[]
    for (const row of rows) {
      const set = map.get(row.message_id) ?? new Set<string>()
      set.add(row.context_id)
      map.set(row.message_id, set)
    }

    return map
  }

  recordSwitch(
    sessionID: string,
    messageID: string,
    fromContextID: string | null,
    toContextID: string,
    confidence: number,
    reason: string,
    now: number,
  ): void {
    const db = this.db
    if (!db) {
      this.fallbackSwitches.push({
        sessionID,
        messageID,
        fromContextID,
        toContextID,
        confidence,
        reason,
        createdAt: now,
      })
      return
    }

    db
      .prepare(
        `INSERT INTO context_switch_events (
          session_id,
          message_id,
          from_context_id,
          to_context_id,
          confidence,
          reason,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionID, messageID, fromContextID, toContextID, confidence, reason, now)
  }

  listMembershipEvents(sessionID: string, limit: number): ContextMembershipEvent[] {
    const normalizedLimit = Math.max(1, Math.floor(limit))
    const db = this.db
    if (!db) {
      return this.fallbackMemberships
        .filter((membership) => membership.sessionID === sessionID)
        .sort((left, right) => {
          if (right.createdAt !== left.createdAt) {
            return right.createdAt - left.createdAt
          }
          if (right.messageID !== left.messageID) {
            return right.messageID.localeCompare(left.messageID)
          }
          return right.contextID.localeCompare(left.contextID)
        })
        .slice(0, normalizedLimit)
        .map((membership) => ({
          messageID: membership.messageID,
          contextID: membership.contextID,
          relevance: membership.relevance,
          isPrimary: membership.isPrimary,
          createdAt: membership.createdAt,
        }))
    }

    const rows = db
      .prepare(
        `SELECT message_id, context_id, relevance, is_primary, created_at
         FROM context_memberships
         WHERE session_id = ?
         ORDER BY created_at DESC, message_id DESC, context_id DESC
         LIMIT ?`,
      )
      .all(sessionID, normalizedLimit) as unknown as MembershipEventRow[]

    return rows.map((row) => ({
      messageID: row.message_id,
      contextID: row.context_id,
      relevance: row.relevance,
      isPrimary: row.is_primary === 1,
      createdAt: row.created_at,
    }))
  }

  listSwitchEvents(sessionID: string, limit: number): ContextSwitchEvent[] {
    const db = this.db
    if (!db) {
      return this.fallbackSwitches
        .filter((event) => event.sessionID === sessionID)
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, limit)
        .map((event) => ({
          fromContextID: event.fromContextID,
          toContextID: event.toContextID,
          confidence: event.confidence,
          reason: event.reason,
          createdAt: event.createdAt,
        }))
    }

    const rows = db
      .prepare(
        `SELECT from_context_id, to_context_id, confidence, reason, created_at
         FROM context_switch_events
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sessionID, limit) as unknown as SwitchRow[]

    return rows.map((row) => ({
      fromContextID: row.from_context_id,
      toContextID: row.to_context_id,
      confidence: row.confidence,
      reason: row.reason,
      createdAt: row.created_at,
    }))
  }

  saveIntentBucketAssignments(
    sessionID: string,
    messageID: string,
    assignments: Omit<MessageIntentBucketAssignment, "sessionID" | "messageID" | "createdAt">[],
    now: number,
  ): void {
    const db = this.db
    if (!db) {
      const remaining = this.fallbackIntentBuckets.filter(
        (item) => !(item.sessionID === sessionID && item.messageID === messageID),
      )
      this.fallbackIntentBuckets.length = 0
      this.fallbackIntentBuckets.push(...remaining)
      for (const assignment of assignments) {
        this.fallbackIntentBuckets.push({
          sessionID,
          messageID,
          bucketType: assignment.bucketType,
          contextID: assignment.contextID,
          score: assignment.score,
          bucketRank: assignment.bucketRank,
          reason: assignment.reason,
          createdAt: now,
        })
      }
      return
    }

    db
      .prepare(`DELETE FROM message_intent_buckets WHERE session_id = ? AND message_id = ?`)
      .run(sessionID, messageID)
    const statement = db.prepare(
      `INSERT INTO message_intent_buckets (
        session_id,
        message_id,
        bucket_type,
        context_id,
        score,
        bucket_rank,
        reason,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const assignment of assignments) {
      statement.run(
        sessionID,
        messageID,
        assignment.bucketType,
        assignment.contextID,
        assignment.score,
        assignment.bucketRank,
        assignment.reason,
        now,
      )
    }
  }

  listIntentBucketAssignments(sessionID: string, messageID: string, limit: number): MessageIntentBucketAssignment[] {
    const normalizedLimit = Math.max(1, Math.floor(limit))
    const db = this.db
    if (!db) {
      return this.fallbackIntentBuckets
        .filter((item) => item.sessionID === sessionID && item.messageID === messageID)
        .sort((left, right) => {
          if (left.bucketRank !== right.bucketRank) {
            return left.bucketRank - right.bucketRank
          }
          if (right.score !== left.score) {
            return right.score - left.score
          }
          return left.contextID.localeCompare(right.contextID)
        })
        .slice(0, normalizedLimit)
        .map((item) => ({
          sessionID: item.sessionID,
          messageID: item.messageID,
          bucketType: item.bucketType,
          contextID: item.contextID,
          score: item.score,
          bucketRank: item.bucketRank,
          reason: item.reason,
          createdAt: item.createdAt,
        }))
    }

    const rows = db
      .prepare(
        `SELECT session_id, message_id, bucket_type, context_id, score, bucket_rank, reason, created_at
         FROM message_intent_buckets
         WHERE session_id = ? AND message_id = ?
         ORDER BY bucket_rank ASC, score DESC, context_id ASC
         LIMIT ?`,
      )
      .all(sessionID, messageID, normalizedLimit) as unknown as IntentBucketRow[]

    return rows.map((row) => ({
      sessionID: row.session_id,
      messageID: row.message_id,
      bucketType: row.bucket_type,
      contextID: row.context_id,
      score: row.score,
      bucketRank: row.bucket_rank,
      reason: row.reason,
      createdAt: row.created_at,
    }))
  }

  appendProgressionStep(
    sessionID: string,
    messageID: string,
    stepType: string,
    detailJSON: string,
    now: number,
  ): MessageProgressionStep {
    const db = this.db
    if (!db) {
      let stepOrder = 1
      for (const step of this.fallbackProgressionSteps) {
        if (step.sessionID === sessionID && step.messageID === messageID) {
          stepOrder = Math.max(stepOrder, step.stepOrder + 1)
        }
      }
      const next: FallbackProgressionStep = {
        sessionID,
        messageID,
        stepOrder,
        stepType,
        detailJSON,
        createdAt: now,
      }
      this.fallbackProgressionSteps.push(next)
      return {
        sessionID,
        messageID,
        stepOrder,
        stepType,
        detailJSON,
        createdAt: now,
      }
    }

    const row = db
      .prepare(
        `SELECT COALESCE(MAX(step_order), 0) + 1 AS next_step
         FROM message_step_progression
         WHERE session_id = ? AND message_id = ?`,
      )
      .get(sessionID, messageID) as { next_step?: number } | undefined
    const stepOrder = row?.next_step ?? 1

    db
      .prepare(
        `INSERT INTO message_step_progression (session_id, message_id, step_order, step_type, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionID, messageID, stepOrder, stepType, detailJSON, now)

    return {
      sessionID,
      messageID,
      stepOrder,
      stepType,
      detailJSON,
      createdAt: now,
    }
  }

  listProgressionSteps(sessionID: string, messageID: string, limit: number): MessageProgressionStep[] {
    const normalizedLimit = Math.max(1, Math.floor(limit))
    const db = this.db
    if (!db) {
      return this.fallbackProgressionSteps
        .filter((step) => step.sessionID === sessionID && step.messageID === messageID)
        .sort((left, right) => left.stepOrder - right.stepOrder)
        .slice(0, normalizedLimit)
        .map((step) => ({
          sessionID: step.sessionID,
          messageID: step.messageID,
          stepOrder: step.stepOrder,
          stepType: step.stepType,
          detailJSON: step.detailJSON,
          createdAt: step.createdAt,
        }))
    }

    const rows = db
      .prepare(
        `SELECT session_id, message_id, step_order, step_type, detail_json, created_at
         FROM message_step_progression
         WHERE session_id = ? AND message_id = ?
         ORDER BY step_order ASC
         LIMIT ?`,
      )
      .all(sessionID, messageID, normalizedLimit) as unknown as ProgressionStepRow[]

    return rows.map((row) => ({
      sessionID: row.session_id,
      messageID: row.message_id,
      stepOrder: row.step_order,
      stepType: row.step_type,
      detailJSON: row.detail_json,
      createdAt: row.created_at,
    }))
  }

  saveContextSnapshot(
    sessionID: string,
    messageID: string,
    snapshotKind: string,
    snapshotIndex: number,
    payloadJSON: string,
    now: number,
  ): ContextSnapshotRecord {
    const db = this.db
    if (!db) {
      const remaining = this.fallbackContextSnapshots.filter(
        (snapshot) =>
          !(
            snapshot.sessionID === sessionID &&
            snapshot.messageID === messageID &&
            snapshot.snapshotKind === snapshotKind &&
            snapshot.snapshotIndex === snapshotIndex
          ),
      )
      this.fallbackContextSnapshots.length = 0
      this.fallbackContextSnapshots.push(...remaining)
      this.fallbackContextSnapshots.push({
        sessionID,
        messageID,
        snapshotKind,
        snapshotIndex,
        payloadJSON,
        createdAt: now,
      })
      return { sessionID, messageID, snapshotKind, snapshotIndex, payloadJSON, createdAt: now }
    }

    db
      .prepare(
        `INSERT OR REPLACE INTO context_snapshots (
           session_id,
           message_id,
           snapshot_kind,
           snapshot_index,
           payload_json,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionID, messageID, snapshotKind, snapshotIndex, payloadJSON, now)

    return { sessionID, messageID, snapshotKind, snapshotIndex, payloadJSON, createdAt: now }
  }

  listContextSnapshots(
    sessionID: string,
    messageID: string,
    snapshotKind: string | null,
    limit: number,
  ): ContextSnapshotRecord[] {
    const normalizedLimit = Math.max(1, Math.floor(limit))
    const db = this.db
    if (!db) {
      const filtered = this.fallbackContextSnapshots.filter((snapshot) => {
        if (snapshot.sessionID !== sessionID || snapshot.messageID !== messageID) {
          return false
        }
        return snapshotKind === null ? true : snapshot.snapshotKind === snapshotKind
      })
      return filtered
        .sort((left, right) => {
          if (left.snapshotKind !== right.snapshotKind) {
            return left.snapshotKind.localeCompare(right.snapshotKind)
          }
          return left.snapshotIndex - right.snapshotIndex
        })
        .slice(0, normalizedLimit)
        .map((snapshot) => ({
          sessionID: snapshot.sessionID,
          messageID: snapshot.messageID,
          snapshotKind: snapshot.snapshotKind,
          snapshotIndex: snapshot.snapshotIndex,
          payloadJSON: snapshot.payloadJSON,
          createdAt: snapshot.createdAt,
        }))
    }

    if (snapshotKind === null) {
      const rows = db
        .prepare(
          `SELECT session_id, message_id, snapshot_kind, snapshot_index, payload_json, created_at
           FROM context_snapshots
           WHERE session_id = ? AND message_id = ?
           ORDER BY snapshot_kind ASC, snapshot_index ASC
           LIMIT ?`,
        )
        .all(sessionID, messageID, normalizedLimit) as unknown as ContextSnapshotRow[]

      return rows.map((row) => ({
        sessionID: row.session_id,
        messageID: row.message_id,
        snapshotKind: row.snapshot_kind,
        snapshotIndex: row.snapshot_index,
        payloadJSON: row.payload_json,
        createdAt: row.created_at,
      }))
    }

    const rows = db
      .prepare(
        `SELECT session_id, message_id, snapshot_kind, snapshot_index, payload_json, created_at
         FROM context_snapshots
         WHERE session_id = ? AND message_id = ? AND snapshot_kind = ?
         ORDER BY snapshot_index ASC
         LIMIT ?`,
      )
      .all(sessionID, messageID, snapshotKind, normalizedLimit) as unknown as ContextSnapshotRow[]

    return rows.map((row) => ({
      sessionID: row.session_id,
      messageID: row.message_id,
      snapshotKind: row.snapshot_kind,
      snapshotIndex: row.snapshot_index,
      payloadJSON: row.payload_json,
      createdAt: row.created_at,
    }))
  }

  appendLaneEvent(sessionID: string, messageID: string, eventType: string, payloadJSON: string, now: number): LaneEventRecord {
    const db = this.db
    if (!db) {
      const record: FallbackLaneEvent = {
        seq: this.fallbackLaneEventSeq++,
        sessionID,
        messageID,
        eventType,
        payloadJSON,
        createdAt: now,
      }
      this.fallbackLaneEvents.push(record)
      return {
        seq: record.seq,
        sessionID,
        messageID,
        eventType,
        payloadJSON,
        createdAt: now,
      }
    }

    db
      .prepare(
        `INSERT INTO lane_events (session_id, message_id, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionID, messageID, eventType, payloadJSON, now)

    const row = db
      .prepare(`SELECT seq FROM lane_events WHERE rowid = last_insert_rowid()`)
      .get() as { seq?: number } | undefined

    return {
      seq: row?.seq ?? 0,
      sessionID,
      messageID,
      eventType,
      payloadJSON,
      createdAt: now,
    }
  }

  listLaneEventsAfter(sessionID: string, afterSeq: number, limit: number): LaneEventRecord[] {
    const normalizedAfter = Math.max(0, Math.floor(afterSeq))
    const normalizedLimit = Math.max(1, Math.floor(limit))
    const db = this.db
    if (!db) {
      return this.fallbackLaneEvents
        .filter((event) => event.sessionID === sessionID && event.seq > normalizedAfter)
        .sort((left, right) => left.seq - right.seq)
        .slice(0, normalizedLimit)
        .map((event) => ({
          seq: event.seq,
          sessionID: event.sessionID,
          messageID: event.messageID,
          eventType: event.eventType,
          payloadJSON: event.payloadJSON,
          createdAt: event.createdAt,
        }))
    }

    const rows = db
      .prepare(
        `SELECT seq, session_id, message_id, event_type, payload_json, created_at
         FROM lane_events
         WHERE session_id = ? AND seq > ?
         ORDER BY seq ASC
         LIMIT ?`,
      )
      .all(sessionID, normalizedAfter, normalizedLimit) as unknown as LaneEventRow[]

    return rows.map((row) => ({
      seq: row.seq,
      sessionID: row.session_id,
      messageID: row.message_id,
      eventType: row.event_type,
      payloadJSON: row.payload_json,
      createdAt: row.created_at,
    }))
  }

  setManualOverride(sessionID: string, contextID: string, expiresAt: number): void {
    const db = this.db
    if (!db) {
      const existing = this.fallbackOverrides.find((override) => override.sessionID === sessionID)
      if (existing) {
        existing.contextID = contextID
        existing.expiresAt = expiresAt
      } else {
        this.fallbackOverrides.push({ sessionID, contextID, expiresAt })
      }
      return
    }

    db
      .prepare(
        `INSERT OR REPLACE INTO context_overrides (session_id, context_id, expires_at)
         VALUES (?, ?, ?)`,
      )
      .run(sessionID, contextID, expiresAt)
  }

  clearManualOverride(sessionID: string): void {
    const db = this.db
    if (!db) {
      const remaining = this.fallbackOverrides.filter((override) => override.sessionID !== sessionID)
      this.fallbackOverrides.length = 0
      this.fallbackOverrides.push(...remaining)
      return
    }

    db.prepare(`DELETE FROM context_overrides WHERE session_id = ?`).run(sessionID)
  }

  getManualOverride(sessionID: string, now: number): string | null {
    const db = this.db
    if (!db) {
      const row = this.fallbackOverrides.find((override) => override.sessionID === sessionID)
      if (!row) {
        return null
      }

      if (row.expiresAt < now) {
        this.clearManualOverride(sessionID)
        return null
      }

      return row.contextID
    }

    const row = db
      .prepare(
        `SELECT context_id, expires_at
         FROM context_overrides
         WHERE session_id = ?`,
      )
      .get(sessionID) as { context_id?: string; expires_at?: number } | undefined

    if (!row?.context_id || !row.expires_at) {
      return null
    }

    if (row.expires_at < now) {
      this.clearManualOverride(sessionID)
      return null
    }

    return row.context_id
  }
}
