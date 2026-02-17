import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ContextLaneStore } from "../lib/context-lanes/store.js"

const require = createRequire(import.meta.url)

function hasNodeSqlite(): boolean {
  try {
    const loaded = require("node:sqlite") as { DatabaseSync?: unknown }
    return typeof loaded.DatabaseSync === "function"
  } catch {
    return false
  }
}

test("ContextLaneStore works with in-memory fallback when node:sqlite is disabled", () => {
  const previousDisableNode = process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE
  const previousDisableGeneric = process.env.RLM_PLUGIN_DISABLE_SQLITE
  process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE = "1"
  process.env.RLM_PLUGIN_DISABLE_SQLITE = "1"

  try {
    const dir = mkdtempSync(join(tmpdir(), "rlm-lanes-fallback-"))
    const store = new ContextLaneStore(dir, "lane-state.sqlite")
    const now = Date.now()

    const created = store.createContext("session-fallback", "Fallback Lane", "Initial fallback summary", now)
    assert.equal(store.countActiveContexts("session-fallback"), 1)

    store.updateContextSummary("session-fallback", created.id, "Updated fallback summary", now + 1_000)
    const loaded = store.getContext("session-fallback", created.id)
    assert.ok(loaded)
    assert.equal(loaded?.summary, "Updated fallback summary")

    store.saveMemberships(
      "session-fallback",
      "msg-1",
      [
        {
          contextID: created.id,
          relevance: 0.8,
          isPrimary: true,
        },
      ],
      now + 2_000,
    )

    assert.equal(store.latestPrimaryContextID("session-fallback"), created.id)

    const membershipMap = store.getMembershipContextMap("session-fallback", ["msg-1"])
    assert.equal(membershipMap.get("msg-1")?.has(created.id), true)

    store.recordSwitch(
      "session-fallback",
      "msg-1",
      null,
      created.id,
      0.9,
      "created-new-context",
      now + 3_000,
    )
    const switches = store.listSwitchEvents("session-fallback", 10)
    assert.equal(switches.length, 1)
    assert.equal(switches[0]?.toContextID, created.id)

    store.setManualOverride("session-fallback", created.id, now + 10_000)
    assert.equal(store.getManualOverride("session-fallback", now + 5_000), created.id)
    assert.equal(store.getManualOverride("session-fallback", now + 20_000), null)
  } finally {
    if (previousDisableNode === undefined) {
      delete process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE
    } else {
      process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE = previousDisableNode
    }

    if (previousDisableGeneric === undefined) {
      delete process.env.RLM_PLUGIN_DISABLE_SQLITE
    } else {
      process.env.RLM_PLUGIN_DISABLE_SQLITE = previousDisableGeneric
    }
  }
})

test("ContextLaneStore persists data when sqlite backend is available", { skip: !hasNodeSqlite() }, () => {
  const previousDisableNode = process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE
  const previousDisableGeneric = process.env.RLM_PLUGIN_DISABLE_SQLITE
  delete process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE
  delete process.env.RLM_PLUGIN_DISABLE_SQLITE

  const dir = mkdtempSync(join(tmpdir(), "rlm-lanes-sqlite-"))

  try {
    const store = new ContextLaneStore(dir, "lane-state.sqlite")
    const now = Date.now()
    const created = store.createContext("session-sqlite", "SQLite Lane", "Persisted summary", now)
    assert.equal(store.countActiveContexts("session-sqlite"), 1)

    const reopened = new ContextLaneStore(dir, "lane-state.sqlite")
    assert.equal(reopened.countActiveContexts("session-sqlite"), 1)

    const loaded = reopened.getContext("session-sqlite", created.id)
    assert.ok(loaded)
    assert.equal(loaded.summary, "Persisted summary")
  } finally {
    rmSync(dir, { recursive: true, force: true })

    if (previousDisableNode === undefined) {
      delete process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE
    } else {
      process.env.RLM_PLUGIN_DISABLE_NODE_SQLITE = previousDisableNode
    }

    if (previousDisableGeneric === undefined) {
      delete process.env.RLM_PLUGIN_DISABLE_SQLITE
    } else {
      process.env.RLM_PLUGIN_DISABLE_SQLITE = previousDisableGeneric
    }
  }
})
