import type { Parser, ParseContext, ParseResult, StatsRecord, ToolCallRecord } from '../types.js'
import { generateRecordId, generateToolCallId } from '../record-id.js'
import { inferProvider } from '../provider.js'
import { calculateCost, resolvePrice } from '../pricing.js'

const FALLBACK_MODEL = 'gemini-unknown'

/**
 * Gemini CLI 0.60 chat rows accepted by this parser. Usage arrives in a
 * top-level `tokens` object; no `usage` field is present.
 */
const ACCEPTED_TYPES = new Set(['gemini', 'assistant'])

function nonNegative(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function ts(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n
    const parsed = new Date(value).getTime()
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function sanitizeModel(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return FALLBACK_MODEL
  const trimmed = value.trim()
  return trimmed.includes('/') ? (trimmed.split('/').pop() || trimmed) : trimmed
}

function toolCallTs(value: unknown, fallback: number): number {
  const parsed = ts(value, NaN)
  return Number.isFinite(parsed) ? parsed : fallback
}

function extractToolCalls(parsed: any, recordId: string, recordTs: number): ToolCallRecord[] {
  const calls = Array.isArray(parsed?.toolCalls) ? parsed.toolCalls : []
  const out: ToolCallRecord[] = []
  let callIndex = 0
  for (const call of calls) {
    const name = typeof call?.name === 'string' && call.name.trim() ? call.name.trim() : 'unknown'
    const callTs = toolCallTs(call?.timestamp, recordTs)
    out.push({
      id: generateToolCallId(recordId, name, callTs, callIndex),
      recordId,
      name,
      ts: callTs,
      callIndex,
    })
    callIndex++
  }
  return out
}

/**
 * Parses Gemini CLI 0.60 chat JSONL (`~/.gemini/tmp/<project>/chats/*.jsonl`).
 *
 * Assistant rows carry a top-level `tokens` object:
 * `{ input, output, cached, thoughts, tool, total }` plus `model` on the row.
 * Mapping: input → inputTokens, output → outputTokens, cached →
 * cacheReadTokens, thoughts → thinkingTokens. `tool`/`total` have no aiusage
 * bucket and are ignored.
 *
 * The CLI persists each assistant message twice — once plain and once enriched
 * with `toolCalls` — under the same message `id`. The second delivery emits
 * only its tool calls bound to the first record so usage is counted once.
 */
export class GeminiParser implements Parser {
  readonly tool = 'gemini' as const
  private seenByFile = new Map<string, Map<string, string>>()

  parseLine(line: string, context: ParseContext): ParseResult | null {
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    const tokens = parsed.tokens
    if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null

    const type = typeof parsed.type === 'string' ? parsed.type : null
    if (type !== null && !ACCEPTED_TYPES.has(type)) return null

    const inputTokens = nonNegative(tokens.input)
    const outputTokens = nonNegative(tokens.output)
    const cacheReadTokens = nonNegative(tokens.cached)
    const thinkingTokens = nonNegative(tokens.thoughts)
    const total = inputTokens + outputTokens + cacheReadTokens + thinkingTokens
    if (total === 0) return null

    const model = sanitizeModel(parsed.model)
    const provider = inferProvider(model)
    const recordTs = ts(parsed.timestamp ?? parsed.ts ?? parsed.time, context.now)
    const recordId = generateRecordId(context.deviceInstanceId, context.sourceFile, context.lineOffset)
    const usage = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, thinkingTokens }
    const hasPrice = resolvePrice(model) != null
    const cost = hasPrice ? calculateCost(model, usage, context.exchangeRate) : 0

    const record: StatsRecord = {
      id: recordId,
      ts: recordTs,
      ingestedAt: context.now,
      updatedAt: context.now,
      lineOffset: context.lineOffset,
      tool: this.tool,
      model,
      provider,
      ...usage,
      cost,
      costSource: hasPrice ? 'pricing' : 'unknown',
      sessionId: context.sessionId,
      sourceFile: context.sourceFile,
      device: context.device,
      deviceInstanceId: context.deviceInstanceId,
      platform: context.platform,
    }

    const messageId = typeof parsed.id === 'string' && parsed.id ? parsed.id : null
    if (messageId != null) {
      let seen = this.seenByFile.get(context.sourceFile)
      if (!seen) {
        seen = new Map()
        this.seenByFile.set(context.sourceFile, seen)
      }
      const priorRecordId = seen.get(messageId)
      if (priorRecordId !== undefined) {
        return { record: null, toolCalls: extractToolCalls(parsed, priorRecordId, recordTs) }
      }
      seen.set(messageId, recordId)
    }

    return { record, toolCalls: extractToolCalls(parsed, recordId, recordTs) }
  }

  finalize(): ParseResult[] {
    this.seenByFile.clear()
    return []
  }
}
