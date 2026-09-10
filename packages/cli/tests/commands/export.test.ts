import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { exportData } from '../../src/commands/export.js'
import type { StatsRecord } from '@aiusage/core'

describe('Export Command', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
  })

  it('exports as CSV', () => {
    insertRecord(db, {
      id: 'r1', ts: 1776738085346, ingestedAt: 1776738085700, updatedAt: 1776738085700,
      lineOffset: 100, tool: 'claude-code', model: 'claude-sonnet-4-6', provider: 'anthropic',
      gateway: 'anthropic',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 200,
      thinkingTokens: 0, cost: 0.001, costSource: 'pricing', sessionId: 'abc123',
      sourceFile: '/path/to/file.jsonl', device: 'test-device', deviceInstanceId: 'device-123',
    })
    const csv = exportData(db, 'csv')
    expect(csv).toContain('timestamp,tool,model')
    expect(csv).toContain('claude-code')
    expect(csv).toContain('provider,gateway,')
  })

  it('exports as JSON', () => {
    insertRecord(db, {
      id: 'r1', ts: 1776738085346, ingestedAt: 1776738085700, updatedAt: 1776738085700,
      lineOffset: 100, tool: 'claude-code', model: 'claude-sonnet-4-6', provider: 'anthropic',
      gateway: 'anthropic',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 200,
      thinkingTokens: 0, cost: 0.001, costSource: 'pricing', sessionId: 'abc123',
      sourceFile: '/path/to/file.jsonl', device: 'test-device', deviceInstanceId: 'device-123',
    })
    const json = JSON.parse(exportData(db, 'json'))
    expect(Array.isArray(json)).toBe(true)
    expect(json[0].tool).toBe('claude-code')
    expect(json[0].gateway).toBe('anthropic')
  })

  it('exports as NDJSON', () => {
    insertRecord(db, {
      id: 'r1', ts: 1776738085346, ingestedAt: 1776738085700, updatedAt: 1776738085700,
      lineOffset: 100, tool: 'claude-code', model: 'claude-sonnet-4-6', provider: 'anthropic',
      gateway: 'anthropic',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 200,
      thinkingTokens: 0, cost: 0.001, costSource: 'pricing', sessionId: 'abc123',
      sourceFile: '/path/to/file.jsonl', device: 'test-device', deviceInstanceId: 'device-123',
    })
    const ndjson = exportData(db, 'ndjson')
    const lines = ndjson.trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0])
    expect(record.tool).toBe('claude-code')
    expect(record.gateway).toBe('anthropic')
  })

  it('exports real cost and gateway-scoped plan draw metadata', () => {
    insertRecord(db, {
      id: 'go-glm', ts: 1776738085346, ingestedAt: 1776738085700, updatedAt: 1776738085700,
      lineOffset: 101, tool: 'opencode', model: 'glm-5.3-flash', provider: 'zhipu',
      gateway: 'opencode-go',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      thinkingTokens: 0, cost: 1, costSource: 'log', sessionId: 'go-session',
      sourceFile: '/path/to/go.jsonl', device: 'test-device', deviceInstanceId: 'device-123',
    })
    insertRecord(db, {
      id: 'router-glm', ts: 1776738085347, ingestedAt: 1776738085700, updatedAt: 1776738085700,
      lineOffset: 102, tool: 'opencode', model: 'glm-5.3-flash', provider: 'zhipu',
      gateway: 'openrouter',
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      thinkingTokens: 0, cost: 1, costSource: 'log', sessionId: 'router-session',
      sourceFile: '/path/to/router.jsonl', device: 'test-device', deviceInstanceId: 'device-123',
    })

    const json = JSON.parse(exportData(db, 'json'))
    const go = json.find((record: { id?: string; sessionId: string }) => record.sessionId === 'go-session')
    const router = json.find((record: { sessionId: string }) => record.sessionId === 'router-session')

    expect(go).toMatchObject({
      cost: 1,
      realCost: 1,
      planDraw: 2,
      rateTier: 'standard',
      usageMultiplier: 2,
      usageMultiplierKnown: true,
      monthlyLimit: 60,
    })
    expect(router).toMatchObject({
      cost: 1,
      realCost: 1,
      planDraw: 1,
      usageMultiplier: 1,
      usageMultiplierKnown: false,
      monthlyLimit: null,
    })
  })

  it('exports the time-based rate tier and repriced plan draw', () => {
    insertRecord(db, {
      id: 'go-deepseek-peak', ts: Date.parse('2026-09-10T02:00:00.000Z'), ingestedAt: 1776738085700, updatedAt: 1776738085700,
      lineOffset: 103, tool: 'opencode', model: 'deepseek-v4.1-flash', provider: 'deepseek',
      gateway: 'opencode-go', inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0,
      thinkingTokens: 0, cost: 0.001, costSource: 'log', sessionId: 'deepseek-session',
      sourceFile: '/path/to/deepseek.jsonl', device: 'test-device', deviceInstanceId: 'device-123',
    })

    const json = JSON.parse(exportData(db, 'json'))
    expect(json[0]).toMatchObject({
      model: 'deepseek-v4.1-flash',
      realCost: 0.001,
      planDraw: 1.506,
      rateTier: 'peak',
    })

    const csv = exportData(db, 'csv')
    expect(csv.split('\n')[0]).toContain('plan_draw,rate_tier,usage_multiplier')
    expect(csv).toContain(',1.506,peak,1,')
  })
})
