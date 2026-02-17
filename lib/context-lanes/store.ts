import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import type { ContextLane, ContextStatus, ContextSwitchEvent, MessageContextMembership } from "./types.js"

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

interface ContextRow {
  id: string
  session_id: string
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

interface FallbackMembership {
  sessionID: string
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

const require = createRequire(import.meta.url)

function resolveDBPath(baseDirectory: string, dbPath: string): string {
  return isAbsolute(dbPath) ? dbPath : resolve(baseDirectory, dbPath)
}

function toContextLane(row: ContextRow): ContextLane {
  return {
    id: row.id,
    sessionID: row.session_id,
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
    `)
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
        `SELECT id, session_id, title, summary, status, msg_count, last_active_at, created_at, updated_at
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
        `SELECT id, session_id, title, summary, status, msg_count, last_active_at, created_at, updated_at
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
        `SELECT id, session_id, title, summary, status, msg_count, last_active_at, created_at, updated_at
         FROM contexts
         WHERE session_id = ? AND id = ?`,
      )
      .get(sessionID, contextID) as ContextRow | undefined

    return row ? toContextLane(row) : null
  }

  createContext(sessionID: string, title: string, summary: string, now: number): ContextLane {
    const id = randomUUID()
    const db = this.db
    if (!db) {
      const lane: ContextLane = {
        id,
        sessionID,
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
        `INSERT INTO contexts (session_id, id, title, summary, status, msg_count, last_active_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?)`,
      )
      .run(sessionID, id, title, summary, now, now, now)

    return {
      id,
      sessionID,
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
