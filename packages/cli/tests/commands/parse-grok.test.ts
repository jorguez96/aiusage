import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initializeDatabase } from '../../src/db/index.js'

const { testDir } = vi.hoisted(() => ({
  testDir: '/tmp/aiusage-parse-grok-test',
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => testDir,
  }
})

const { runParse } = await import('../../src/commands/parse.js')

function update(options: {
  sessionId: string
  totalTokens?: number
  sessionUpdate?: string
  modelId?: string
  timestamp: number
  method?: string
  usage?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    method: options.method ?? 'session/update',
    params: {
      sessionId: options.sessionId,
      update: {
        sessionUpdate: options.sessionUpdate ?? 'agent_message_chunk',
        ...(options.modelId ? { _meta: { modelId: options.modelId } } : {}),
        ...(options.usage ? { usage: options.usage } : {}),
      },
      _meta: {
        ...(options.totalTokens == null ? {} : { totalTokens: options.totalTokens }),
        agentTimestampMs: options.timestamp,
      },
    },
  }
}

function writeJsonl(filePath: string, rows: Record<string, unknown>[]): void {
  writeFileSync(filePath, jsonl(rows))
}

function appendJsonl(filePath: string, rows: Record<string, unknown>[]): void {
  appendFileSync(filePath, jsonl(rows))
}

function jsonl(rows: Record<string, unknown>[]): string {
  return `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
}

function turnUsage(): Record<string, unknown> {
  return {
    inputTokens: 485_698,
    outputTokens: 1_364,
    cachedReadTokens: 483_584,
    cacheCreationTokens: 0,
    reasoningTokens: 1_204,
    totalTokens: 487_062,
    costUsdTicks: 864_293_600,
    modelUsage: { 'grok-4.6-build': { inputTokens: 485_698, outputTokens: 1_364 } },
  }
}

describe('runParse with Grok Build data', () => {
  let cacheDb: Database.Database

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(join(testDir, '.aiusage'), { recursive: true })
    cacheDb = new Database(':memory:')
    initializeDatabase(cacheDb)
  })

  afterEach(() => {
    cacheDb.close()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('replays stale watermarks once and keeps Grok sessions isolated', async () => {
    const sessionsRoot = join(testDir, '.grok', 'sessions')
    const sessionADir = join(sessionsRoot, '%43%3A%5Cworkspace%5Capp', 'session-a')
    const sessionBDir = join(sessionsRoot, '%2Fworkspace%2Fother', 'session-b')
    mkdirSync(sessionADir, { recursive: true })
    mkdirSync(sessionBDir, { recursive: true })
    const sessionAPath = join(sessionADir, 'updates.jsonl')
    const sessionBPath = join(sessionBDir, 'updates.jsonl')

    writeJsonl(sessionAPath, [
      update({ sessionId: 'session-a', totalTokens: 100, timestamp: 1_700_000_000_000 }),
      update({ sessionId: 'session-a', sessionUpdate: 'user_message_chunk', modelId: 'grok-composer-2.5-fast', timestamp: 1_700_000_001_000 }),
      update({ sessionId: 'session-a', totalTokens: 300, timestamp: 1_700_000_002_000 }),
      update({ sessionId: 'session-a', sessionUpdate: 'user_message_chunk', modelId: 'grok-composer-2.5-fast', timestamp: 1_700_000_003_000 }),
      update({ sessionId: 'session-a', totalTokens: 450, timestamp: 1_700_000_004_000 }),
    ])
    writeJsonl(sessionBPath, [
      update({ sessionId: 'session-b', totalTokens: 20, timestamp: 1_700_000_010_000 }),
      update({ sessionId: 'session-b', sessionUpdate: 'user_message_chunk', modelId: 'grok-3', timestamp: 1_700_000_011_000 }),
      update({ sessionId: 'session-b', totalTokens: 70, timestamp: 1_700_000_012_000 }),
    ])

    writeFileSync(join(testDir, '.aiusage', 'config.json'), JSON.stringify({
      sources: { grok: sessionsRoot },
    }))

    const initial = await runParse(cacheDb, 'grok')
    expect(initial.errors).toEqual([])
    expect(initial.parsedCount).toBe(3)

    writeFileSync(join(testDir, '.aiusage', 'watermark.json'), JSON.stringify({
      files: {
        grok: {
          [sessionAPath]: {
            offset: statSync(sessionAPath).size,
            size: statSync(sessionAPath).size,
            mtime: statSync(sessionAPath).mtimeMs,
          },
          [sessionBPath]: {
            offset: statSync(sessionBPath).size,
            size: statSync(sessionBPath).size,
            mtime: statSync(sessionBPath).mtimeMs,
          },
        },
      },
      grokParserVersion: 1,
    }))

    const first = await runParse(cacheDb, 'grok')
    expect(first.errors).toEqual([])
    expect(first.parsedCount).toBe(3)

    const rows = cacheDb.prepare(`
      SELECT session_id, model, input_tokens, cwd
      FROM records
      WHERE tool = 'grok'
      ORDER BY session_id, line_offset
    `).all()
    expect(rows).toEqual([
      { session_id: 'session-a', model: 'grok-composer-2.5-fast', input_tokens: 200, cwd: 'C:\\workspace\\app' },
      { session_id: 'session-a', model: 'grok-composer-2.5-fast', input_tokens: 150, cwd: 'C:\\workspace\\app' },
      { session_id: 'session-b', model: 'grok-3', input_tokens: 50, cwd: '/workspace/other' },
    ])

    const second = await runParse(cacheDb, 'grok')
    expect(second.errors).toEqual([])
    expect(second.parsedCount).toBe(0)
    expect(cacheDb.prepare("SELECT COUNT(*) AS count FROM records WHERE tool = 'grok'").get()).toEqual({ count: 3 })
  })

  it('replaces a totalTokens fallback with turn usage appended on the next parse', async () => {
    const sessionsRoot = join(testDir, '.grok', 'sessions')
    const sessionDir = join(sessionsRoot, '%2Fworkspace%2Fapp', 'session-usage')
    mkdirSync(sessionDir, { recursive: true })
    const updatesPath = join(sessionDir, 'updates.jsonl')

    writeJsonl(updatesPath, [
      update({
        sessionId: 'session-usage',
        totalTokens: 1_900,
        timestamp: 1_700_000_021_000,
      }),
    ])

    writeFileSync(join(testDir, '.aiusage', 'config.json'), JSON.stringify({
      sources: { grok: sessionsRoot },
    }))

    const first = await runParse(cacheDb, 'grok')
    expect(first.errors).toEqual([])
    expect(cacheDb.prepare(`
      SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens
      FROM records
      WHERE tool = 'grok'
    `).all()).toEqual([{
      input_tokens: 1_900,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      thinking_tokens: 0,
    }])
    expect(first.parsedCount).toBe(1)
    const firstId = (cacheDb.prepare("SELECT id FROM records WHERE tool = 'grok'").get() as { id: string }).id

    appendJsonl(updatesPath, [
      update({
        sessionId: 'session-usage',
        sessionUpdate: 'user_message_chunk',
        modelId: 'grok-4.6',
        timestamp: 1_700_000_021_500,
      }),
    ])

    const intermediate = await runParse(cacheDb, 'grok')
    expect(intermediate.errors).toEqual([])
    expect(intermediate.parsedCount).toBe(0)
    expect(cacheDb.prepare("SELECT COUNT(*) AS count FROM records WHERE tool = 'grok'").get()).toEqual({ count: 1 })

    appendJsonl(updatesPath, [
      update({
        sessionId: 'session-usage',
        method: '_x.ai/session/update',
        sessionUpdate: 'turn_completed',
        timestamp: 1_700_000_022_000,
        usage: turnUsage(),
      }),
    ])

    const second = await runParse(cacheDb, 'grok')
    expect(second.errors).toEqual([])
    expect(second.parsedCount).toBe(1)
    expect(cacheDb.prepare(`
      SELECT id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             thinking_tokens, cost, cost_source, model, line_offset
      FROM records
      WHERE tool = 'grok'
    `).all()).toEqual([{
      id: firstId,
      input_tokens: 2_114,
      output_tokens: 1_364,
      cache_read_tokens: 483_584,
      cache_write_tokens: 0,
      thinking_tokens: 1_204,
      cost: 0.08642936,
      cost_source: 'log',
      model: 'grok-4.6',
      line_offset: 0,
    }])
  })

  it('replaces an active totalTokens fallback when usage is the only appended event', async () => {
    const sessionsRoot = join(testDir, '.grok', 'sessions')
    const sessionDir = join(sessionsRoot, '%2Fworkspace%2Fapp', 'session-active')
    mkdirSync(sessionDir, { recursive: true })
    const updatesPath = join(sessionDir, 'updates.jsonl')

    writeJsonl(updatesPath, [
      update({
        sessionId: 'session-active',
        sessionUpdate: 'user_message_chunk',
        modelId: 'grok-4.6',
        timestamp: 1_700_000_030_000,
      }),
      update({
        sessionId: 'session-active',
        totalTokens: 1_900,
        timestamp: 1_700_000_031_000,
      }),
    ])
    writeFileSync(join(testDir, '.aiusage', 'config.json'), JSON.stringify({
      sources: { grok: sessionsRoot },
    }))

    await runParse(cacheDb, 'grok')
    const firstId = (cacheDb.prepare("SELECT id FROM records WHERE tool = 'grok'").get() as { id: string }).id

    appendJsonl(updatesPath, [
      update({
        sessionId: 'session-active',
        method: '_x.ai/session/update',
        sessionUpdate: 'turn_completed',
        timestamp: 1_700_000_032_000,
        usage: turnUsage(),
      }),
    ])

    const second = await runParse(cacheDb, 'grok')
    expect(second.errors).toEqual([])
    expect(second.parsedCount).toBe(1)
    expect(cacheDb.prepare(`
      SELECT id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             thinking_tokens, cost, cost_source, model
      FROM records
      WHERE tool = 'grok'
    `).all()).toEqual([{
      id: firstId,
      input_tokens: 2_114,
      output_tokens: 1_364,
      cache_read_tokens: 483_584,
      cache_write_tokens: 0,
      thinking_tokens: 1_204,
      cost: 0.08642936,
      cost_source: 'log',
      model: 'grok-4.6',
    }])
  })

  it('rebuilds an existing fallback when the Grok parser version resets the watermark', async () => {
    const sessionsRoot = join(testDir, '.grok', 'sessions')
    const sessionDir = join(sessionsRoot, '%2Fworkspace%2Fapp', 'session-version-reset')
    mkdirSync(sessionDir, { recursive: true })
    const updatesPath = join(sessionDir, 'updates.jsonl')
    const watermarkPath = join(testDir, '.aiusage', 'watermark.json')

    writeJsonl(updatesPath, [
      update({
        sessionId: 'session-version-reset',
        totalTokens: 1_900,
        timestamp: 1_700_000_040_000,
      }),
    ])
    writeFileSync(join(testDir, '.aiusage', 'config.json'), JSON.stringify({
      sources: { grok: sessionsRoot },
    }))

    await runParse(cacheDb, 'grok')
    const firstId = (cacheDb.prepare("SELECT id FROM records WHERE tool = 'grok'").get() as { id: string }).id

    appendJsonl(updatesPath, [
      update({
        sessionId: 'session-version-reset',
        sessionUpdate: 'user_message_chunk',
        modelId: 'grok-4.6',
        timestamp: 1_700_000_040_500,
      }),
      update({
        sessionId: 'session-version-reset',
        method: '_x.ai/session/update',
        sessionUpdate: 'turn_completed',
        timestamp: 1_700_000_041_000,
        usage: turnUsage(),
      }),
    ])

    const stat = statSync(updatesPath)
    writeFileSync(watermarkPath, JSON.stringify({
      files: {
        grok: {
          [updatesPath]: { offset: stat.size, size: stat.size, mtime: stat.mtimeMs },
        },
      },
      grokParserVersion: 1,
    }))

    const rebuilt = await runParse(cacheDb, 'grok')
    expect(rebuilt.errors).toEqual([])
    expect(rebuilt.parsedCount).toBe(1)
    expect(cacheDb.prepare(`
      SELECT id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
             thinking_tokens, cost, cost_source, model
      FROM records
      WHERE tool = 'grok'
    `).all()).toEqual([{
      id: firstId,
      input_tokens: 2_114,
      output_tokens: 1_364,
      cache_read_tokens: 483_584,
      cache_write_tokens: 0,
      thinking_tokens: 1_204,
      cost: 0.08642936,
      cost_source: 'log',
      model: 'grok-4.6',
    }])
  })
})
