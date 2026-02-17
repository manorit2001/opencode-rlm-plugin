import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import type { ContextLane, ContextStatus, ContextSwitchEvent, MessageContextMembership } from "./types.js"

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

export class ContextLaneStore {
  private readonly db: DatabaseSync

  constructor(baseDirectory: string, dbPath: string) {
    const resolved = resolveDBPath(baseDirectory, dbPath)
    mkdirSync(dirname(resolved), { recursive: true })
    this.db = new DatabaseSync(resolved)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.ensureSchema()
  }

  private ensureSchema(): void {
    this.db.exec(`
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
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM contexts
         WHERE session_id = ? AND status = 'active'`,
      )
      .get(sessionID) as { count?: number } | undefined

    return row?.count ?? 0
  }

  listActiveContexts(sessionID: string, limit: number): ContextLane[] {
    const rows = this.db
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
    const rows = this.db
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
    const row = this.db
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
    this.db
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
    this.db
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
    const row = this.db
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
    const statement = this.db.prepare(
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

    const placeholders = messageIDs.map(() => "?").join(",")
    const statement = this.db.prepare(
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
    this.db
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
    const rows = this.db
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
    this.db
      .prepare(
        `INSERT OR REPLACE INTO context_overrides (session_id, context_id, expires_at)
         VALUES (?, ?, ?)`,
      )
      .run(sessionID, contextID, expiresAt)
  }

  clearManualOverride(sessionID: string): void {
    this.db.prepare(`DELETE FROM context_overrides WHERE session_id = ?`).run(sessionID)
  }

  getManualOverride(sessionID: string, now: number): string | null {
    const row = this.db
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
