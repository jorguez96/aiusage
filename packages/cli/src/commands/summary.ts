import type Database from 'better-sqlite3'
import { calculateUsageConsumption } from '@aiusage/core'
import { getToolCallStats } from '../db/tool-calls.js'
import { LOCAL_RECORDS_WHERE } from '../db/records.js'

export interface SummaryOptions {
  device?: string
  tool?: string
  currentDeviceInstanceId?: string
  startTs?: number
  endTs?: number
}

export interface SummaryResult {
  totalTokens: number
  totalCost: number
  realCost: number
  planDraw: number
  recordCount: number
  byTool: Record<string, { tokens: number; cost: number; realCost: number; planDraw: number }>
  topToolCalls: Array<{ name: string; count: number }>
  deviceCount: number
  deviceLabel: string | null
}

// Keep aggregate output stable when the same records arrive in a different
// local/synced row order. JavaScript's binary floating-point addition otherwise
// makes equivalent cost totals differ by a few ulps across devices.
function normalizeCost(value: number): number {
  return Number(value.toFixed(12))
}

export function generateSummary(db: Database.Database, options?: SummaryOptions): SummaryResult {
  const currentId = options?.currentDeviceInstanceId
  const device = options?.device

  // Rows merged from synced_records carry origin = 'synced'; they are counted via synced_records instead.
  const localOnlyFilter = `AND ${LOCAL_RECORDS_WHERE}`
  const toolWhere = options?.tool ? 'AND tool = @tool' : ''
  const toolParam = options?.tool ? { tool: options.tool } : {}
  const timeWhere = [
    typeof options?.startTs === 'number' ? 'AND ts >= @startTs' : '',
    typeof options?.endTs === 'number' ? 'AND ts <= @endTs' : '',
  ].filter(Boolean).join(' ')
  const timeParam = {
    ...(typeof options?.startTs === 'number' ? { startTs: options.startTs } : {}),
    ...(typeof options?.endTs === 'number' ? { endTs: options.endTs } : {}),
  }

  const rowSelect = `
    SELECT tool, model, gateway, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, thinking_tokens, cost, ts
    FROM records WHERE 1=1 ${currentId ? localOnlyFilter : ''} ${toolWhere} ${timeWhere}`
  const syncedRowSelect = `
    SELECT tool, model, gateway, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, thinking_tokens, cost, ts
    FROM synced_records WHERE device_instance_id != @currentId ${toolWhere} ${timeWhere}`

  let rowsSql: string
  let params: Record<string, unknown>
  if (currentId && !device) {
    rowsSql = `${rowSelect} UNION ALL ${syncedRowSelect}`
    params = { currentId, ...toolParam, ...timeParam }
  } else if (currentId && device && device !== currentId) {
    rowsSql = syncedRowSelect.replace('device_instance_id != @currentId', 'device_instance_id = @device')
    params = { device, ...toolParam, ...timeParam }
  } else {
    rowsSql = rowSelect
    params = { ...toolParam, ...timeParam }
  }

  const rows = db.prepare(rowsSql).all(params) as Array<{
    tool: string
    model: string
    gateway: string | null
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_write_tokens: number
    thinking_tokens: number
    cost: number
    ts: number
  }>
  let totalTokens = 0
  let realCost = 0
  let planDraw = 0
  const byTool: SummaryResult['byTool'] = {}
  for (const row of rows) {
    const tokens = (Number(row.input_tokens) || 0)
      + (Number(row.output_tokens) || 0)
      + (Number(row.cache_read_tokens) || 0)
      + (Number(row.cache_write_tokens) || 0)
      + (Number(row.thinking_tokens) || 0)
    const usage = calculateUsageConsumption(Number(row.cost) || 0, row.gateway, row.model, undefined, {
      timestamp: row.ts,
      inputTokens: Number(row.input_tokens) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      cacheReadTokens: Number(row.cache_read_tokens) || 0,
      cacheWriteTokens: Number(row.cache_write_tokens) || 0,
    })
    totalTokens += tokens
    realCost += usage.realCost
    planDraw += usage.planDraw
    const tool = byTool[row.tool] ?? { tokens: 0, cost: 0, realCost: 0, planDraw: 0 }
    tool.tokens += tokens
    tool.cost += usage.realCost
    tool.realCost += usage.realCost
    tool.planDraw += usage.planDraw
    byTool[row.tool] = tool
  }

  const toolCallStats = getToolCallStats(db)

  // Count devices
  let deviceCount = 1
  let deviceLabel: string | null = null
  if (currentId) {
    const localDevices = db.prepare('SELECT DISTINCT device_instance_id FROM records').all() as any[]
    const syncedDevices = db.prepare('SELECT DISTINCT device_instance_id FROM synced_records WHERE device_instance_id != ?').all(currentId) as any[]
    const allDeviceIds = new Set([...localDevices.map(d => d.device_instance_id), ...syncedDevices.map(d => d.device_instance_id)])
    deviceCount = allDeviceIds.size
    if (device) {
      const row = db.prepare('SELECT device FROM synced_records WHERE device_instance_id = ? LIMIT 1').get(device) as any
      deviceLabel = row?.device ?? device
    }
  }

  return {
    totalTokens,
    totalCost: normalizeCost(realCost),
    realCost: normalizeCost(realCost),
    planDraw: normalizeCost(planDraw),
    recordCount: rows.length,
    byTool: Object.fromEntries(Object.entries(byTool).map(([tool, stats]) => [tool, {
      ...stats,
      cost: normalizeCost(stats.cost),
      realCost: normalizeCost(stats.realCost),
      planDraw: normalizeCost(stats.planDraw),
    }])),
    topToolCalls: toolCallStats.slice(0, 3),
    deviceCount,
    deviceLabel,
  }
}
