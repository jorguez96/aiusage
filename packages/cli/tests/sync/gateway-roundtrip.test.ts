import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { generateSessionKey, generateSyncRecordId } from '@aiusage/core'
import type { StatsRecord, SyncRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { insertSyncedRecord, mergeSyncedRecordsIntoRecords } from '../../src/db/synced-records.js'
import { SyncOrchestrator } from '../../src/sync/index.js'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'
import { repairSyncContamination } from '../../src/sync/repair.js'
import { FakeSyncBackend } from './helpers/fake-backend.js'

const DEVICE_A = 'gateway-device-a'
const DEVICE_B = 'gateway-device-b'
const TARGET = 'gateway-sync-test'

function newDb(): Database.Database {
  const db = new Database(':memory:')
  initializeDatabase(db)
  return db
}

function localRecord(
  deviceInstanceId: string,
  id: string,
  model: string,
  gateway: string | undefined,
  ts: number,
): StatsRecord {
  return {
    id,
    ts,
    ingestedAt: ts + 1,
    updatedAt: ts + 1,
    lineOffset: 0,
    tool: 'opencode',
    model,
    provider: 'openai',
    gateway,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    cost: 0.01,
    costSource: 'pricing',
    sessionId: id,
    sourceFile: `/fixtures/${deviceInstanceId}.db`,
    cwd: '/fixtures',
    device: deviceInstanceId,
    deviceInstanceId,
    platform: 'linux',
  }
}

function orchestrator(db: Database.Database, backend: FakeSyncBackend, deviceInstanceId: string): SyncOrchestrator {
  return new SyncOrchestrator(db, backend, {
    deviceInstanceId,
    target: TARGET,
    consentVerified: true,
  })
}

function rowsWithGateway(db: Database.Database, table: 'records' | 'synced_records') {
  return db.prepare(`
    SELECT id, model, gateway${table === 'records' ? ', origin' : ''}, device_instance_id AS deviceInstanceId
    FROM ${table}
    ORDER BY id
  `).all() as Array<{
    id: string
    model: string
    gateway: string | null
    origin?: string
    deviceInstanceId: string
  }>
}

describe('gateway attribution across sync', () => {
  let backend: FakeSyncBackend
  let dbA: Database.Database
  let dbB: Database.Database

  beforeEach(() => {
    backend = new FakeSyncBackend()
    dbA = newDb()
    dbB = newDb()
  })

  afterEach(() => {
    dbA.close()
    dbB.close()
  })

  it('preserves attributed and null gateways in both directions and keeps model groups separate', async () => {
    const baseTs = Date.now() - 60_000
    const aAttributed = localRecord(DEVICE_A, 'a-attributed', 'gateway-model', 'opencode-go', baseTs)
    const aNull = localRecord(DEVICE_A, 'a-null', 'null-gateway-model', undefined, baseTs + 1_000)
    const aShared = localRecord(DEVICE_A, 'a-shared', 'shared-model', 'gateway-a', baseTs + 2_000)
    for (const record of [aAttributed, aNull, aShared]) insertRecord(dbA, record)

    // A → B: the real orchestrator writes the wire records and B persists them
    // through synced_records before merging them into its queryable records.
    const aToB = await orchestrator(dbA, backend, DEVICE_A).sync()
    expect(aToB).toMatchObject({ status: 'ok', uploadedCount: 3 })
    expect(backend.linesUnder(DEVICE_A).find(r => r.id === 'a-attributed')?.gateway).toBe('opencode-go')

    const bPull = await orchestrator(dbB, backend, DEVICE_B).sync()
    expect(bPull).toMatchObject({ status: 'ok', pulledCount: 3, mergedCount: 3, uploadedCount: 0 })
    expect(rowsWithGateway(dbB, 'synced_records')).toEqual([
      expect.objectContaining({ id: 'a-attributed', gateway: 'opencode-go' }),
      expect.objectContaining({ id: 'a-null', gateway: null }),
      expect.objectContaining({ id: 'a-shared', gateway: 'gateway-a' }),
    ])
    expect(rowsWithGateway(dbB, 'records')).toEqual([
      expect.objectContaining({ id: 'a-attributed', gateway: 'opencode-go', origin: 'synced' }),
      expect.objectContaining({ id: 'a-null', gateway: null, origin: 'synced' }),
      expect.objectContaining({ id: 'a-shared', gateway: 'gateway-a', origin: 'synced' }),
    ])

    // B → A: a second device's gateway reaches the first device without being
    // collapsed into A's same-model/different-gateway row.
    const bShared = localRecord(DEVICE_B, 'b-shared', 'shared-model', 'gateway-b', baseTs + 3_000)
    insertRecord(dbB, bShared)
    const bToA = await orchestrator(dbB, backend, DEVICE_B).sync()
    expect(bToA).toMatchObject({ status: 'ok', uploadedCount: 1 })

    const aPull = await orchestrator(dbA, backend, DEVICE_A).sync()
    expect(aPull).toMatchObject({ status: 'ok', pulledCount: 1, mergedCount: 1 })
    expect(rowsWithGateway(dbA, 'synced_records')).toEqual([
      expect.objectContaining({ id: 'b-shared', gateway: 'gateway-b' }),
    ])

    const modelGroups = dbB.prepare(`
      SELECT model, gateway, COUNT(*) AS count
      FROM records
      GROUP BY model, provider, gateway
      ORDER BY model, gateway
    `).all() as Array<{ model: string; gateway: string | null; count: number }>
    expect(modelGroups.filter(group => group.model === 'shared-model')).toEqual([
      { model: 'shared-model', gateway: 'gateway-a', count: 1 },
      { model: 'shared-model', gateway: 'gateway-b', count: 1 },
    ])
    expect(modelGroups.find(group => group.model === 'null-gateway-model')).toEqual({
      model: 'null-gateway-model',
      gateway: null,
      count: 1,
    })
  })

  it('does not corrupt gateway fields when repair removes a contaminated echo', async () => {
    const baseTs = Date.now() - 60_000
    const source = localRecord(DEVICE_A, 'a-repair-source', 'repair-model', 'opencode-go', baseTs)
    insertRecord(dbA, source)
    await orchestrator(dbA, backend, DEVICE_A).sync()

    const sourceWire = mapStatsRecordToSyncRecord(source)
    const echo: SyncRecord = {
      ...sourceWire,
      id: generateSyncRecordId(DEVICE_B, source.sourceFile, 0),
      deviceInstanceId: DEVICE_B,
      sessionKey: generateSessionKey(sourceWire.device, sourceWire.sessionKey),
      updatedAt: sourceWire.updatedAt + 1,
    }
    const bGenuine = localRecord(DEVICE_B, 'b-repair-own', 'repair-model', 'gateway-b', baseTs + 1_000)
    insertRecord(dbB, bGenuine)
    const bGenuineWire = mapStatsRecordToSyncRecord(bGenuine)
    const bPath = `${DEVICE_B}/1970/01/01.ndjson`
    backend.files.set(bPath, `${JSON.stringify(bGenuineWire)}\n${JSON.stringify(echo)}\n`)

    // Model the old contaminated local state: the echoed wire record has been
    // pulled and merged before the operator runs `sync --repair --apply`.
    insertSyncedRecord(dbB, echo)
    mergeSyncedRecordsIntoRecords(dbB)

    const report = await repairSyncContamination(dbB, {
      deviceInstanceId: DEVICE_B,
      backend,
      allNamespaces: true,
      apply: true,
    })

    expect(report.applied).toBe(true)
    expect(report.local.echoSyncedIds).toContain(echo.id)
    expect(report.remoteResult).toMatchObject({ rewritten: 1, deleted: 0 })
    expect(backend.linesUnder(DEVICE_A)).toEqual([
      expect.objectContaining({ id: sourceWire.id, gateway: 'opencode-go' }),
    ])
    expect(backend.linesUnder(DEVICE_B)).toEqual([
      expect.objectContaining({ id: bGenuineWire.id, gateway: 'gateway-b' }),
    ])
    expect(dbB.prepare('SELECT id FROM synced_records WHERE id = ?').get(echo.id)).toBeUndefined()
    expect(dbB.prepare('SELECT id FROM records WHERE id = ?').get(echo.id)).toBeUndefined()
    expect(dbB.prepare('SELECT gateway FROM records WHERE id = ?').get(bGenuine.id)).toEqual({ gateway: 'gateway-b' })
  })
})
