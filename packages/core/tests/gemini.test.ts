import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GeminiParser } from '../src/parsers/gemini.js'
import { Aggregator } from '../src/aggregator.js'
import { removePriceOverride, setPriceOverride } from '../src/pricing.js'
import type { ParseContext } from '../src/types.js'

const FIXTURE = join(__dirname, 'fixtures', 'gemini', 'session-2026-09-23T22-18-83ac303f.jsonl')

function context(sourceFile = '/home/test/.gemini/tmp/aiusage/chats/session-2026-09-23T22-18-83ac303f.jsonl', lineOffset = 0): ParseContext {
  return {
    tool: 'gemini',
    sourceFile,
    lineOffset,
    sessionId: 'session-2026-09-23T22-18-83ac303f',
    now: 1_789_000_000_000,
    device: 'test-device',
    deviceInstanceId: 'device-1',
  }
}

function geminiRow(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'aee69a2a-4c31-48aa-a127-0f9a62e49ab7',
    timestamp: '2026-09-23T22:19:31.874Z',
    type: 'gemini',
    content: '',
    thoughts: [],
    tokens: { input: 22989, output: 47, cached: 20379, thoughts: 117, tool: 0, total: 23153 },
    model: 'gemini-3.5-flash',
    ...overrides,
  })
}

describe('GeminiParser', () => {
  it('parses the 0.60 fixture into gemini records with mapped token counts', () => {
    const parser = new GeminiParser()
    const lines = readFileSync(FIXTURE, 'utf-8').split('\n').filter((line) => line.trim())
    const records: unknown[] = []
    const toolCalls: unknown[] = []
    let byteOffset = 0
    for (const line of lines) {
      const result = parser.parseLine(line, context(undefined, byteOffset))
      if (result?.record) records.push(result.record)
      if (result) toolCalls.push(...result.toolCalls)
      byteOffset += Buffer.byteLength(line, 'utf-8') + 1
    }

    // Two unique assistant messages; each is delivered twice (plain + toolCalls
    // enriched) but counted once.
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      tool: 'gemini',
      model: 'gemini-3.5-flash',
      provider: 'google',
      inputTokens: 22989,
      outputTokens: 47,
      cacheReadTokens: 20379,
      cacheWriteTokens: 0,
      thinkingTokens: 117,
      sessionId: 'session-2026-09-23T22-18-83ac303f',
    })
    expect(records[1]).toMatchObject({
      tool: 'gemini',
      model: 'gemini-3.5-flash',
      inputTokens: 23256,
      outputTokens: 67,
      cacheReadTokens: 20372,
      thinkingTokens: 251,
    })
    // Tool calls from the enriched redelivery bind to the first record.
    expect(toolCalls).toHaveLength(2)
    expect(toolCalls[0]).toMatchObject({ recordId: (records[0] as { id: string }).id, name: 'read_file' })
    expect(toolCalls[1]).toMatchObject({ recordId: (records[1] as { id: string }).id, name: 'run_shell_command' })
  })

  it('ignores session meta, $set, user, error, and info rows', () => {
    const parser = new GeminiParser()
    const lines = [
      JSON.stringify({ sessionId: 's', startTime: '2026-09-23T22:18:07.295Z', kind: 'main' }),
      JSON.stringify({ $set: { lastUpdated: '2026-09-23T22:19:31.874Z' } }),
      JSON.stringify({ id: 'u1', timestamp: '2026-09-23T22:18:07.295Z', type: 'user', content: [{ text: 'hi' }] }),
      JSON.stringify({ id: 'e1', timestamp: '2026-09-23T22:18:42.015Z', type: 'error', content: 'boom' }),
      JSON.stringify({ id: 'i1', timestamp: '2026-09-23T22:18:42.015Z', type: 'info', content: 'note' }),
    ]
    for (const [index, line] of lines.entries()) {
      expect(parser.parseLine(line, context(undefined, index))).toBeNull()
    }
  })

  it('ignores token-less rows, zero-token rows, and non-assistant types', () => {
    const parser = new GeminiParser()
    expect(parser.parseLine(geminiRow({ tokens: undefined }), context())).toBeNull()
    expect(parser.parseLine(
      geminiRow({ tokens: { input: 0, output: 0, cached: 0, thoughts: 0, tool: 0, total: 0 } }),
      context(),
    )).toBeNull()
    expect(parser.parseLine(geminiRow({ type: 'user' }), context())).toBeNull()
    expect(parser.parseLine('not json', context())).toBeNull()
  })

  it('falls back to gemini-unknown when the row has no model', () => {
    const parser = new GeminiParser()
    const result = parser.parseLine(geminiRow({ model: undefined }), context())
    expect(result?.record).toMatchObject({ model: 'gemini-unknown', provider: 'google' })
  })

  it('prices via the model table when available, otherwise unknown', () => {
    setPriceOverride('gemini-3.5-flash', { input: 0.5, output: 3, cacheRead: 0.05 })
    try {
      const parser = new GeminiParser()
      const result = parser.parseLine(geminiRow(), context())
      expect(result?.record?.cost).toBeGreaterThan(0)
      expect(result?.record?.costSource).toBe('pricing')
    } finally {
      removePriceOverride('gemini-3.5-flash')
    }

    const parser = new GeminiParser()
    const result = parser.parseLine(geminiRow({ model: 'gemini-unpriced-model' }), context())
    expect(result?.record).toMatchObject({ cost: 0, costSource: 'unknown' })
  })

  it('clears duplicate tracking on finalize so files stay independent', () => {
    const parser = new GeminiParser()
    const first = parser.parseLine(geminiRow(), context('/tmp/a.jsonl', 0))
    const dup = parser.parseLine(
      geminiRow({ toolCalls: [{ name: 'read_file', timestamp: '2026-09-23T22:19:31.876Z' }] }),
      context('/tmp/a.jsonl', 100),
    )
    expect(first?.record).not.toBeNull()
    expect(dup?.record).toBeNull()
    expect(dup?.toolCalls).toHaveLength(1)

    parser.finalize()
    const replay = parser.parseLine(geminiRow(), context('/tmp/a.jsonl', 0))
    expect(replay?.record).not.toBeNull()
  })

  it('is routed by the Aggregator for the gemini tool', () => {
    const aggregator = new Aggregator()
    const result = aggregator.parseLine(geminiRow(), context())
    expect(result?.record).toMatchObject({ tool: 'gemini', model: 'gemini-3.5-flash', inputTokens: 22989 })
  })
})
