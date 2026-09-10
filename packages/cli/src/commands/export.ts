import type Database from 'better-sqlite3'
import { calculateUsageConsumption } from '@aiusage/core'

function usageFields(record: any) {
  const usage = calculateUsageConsumption(Number(record.cost) || 0, record.gateway, record.model)
  return {
    realCost: usage.realCost,
    planDraw: usage.planDraw,
    usageMultiplier: usage.usageMultiplier,
    usageMultiplierKnown: usage.usageMultiplierKnown,
    usageMultiplierSource: usage.usageMultiplierSource,
    monthlyLimit: usage.monthlyLimit,
    limitKnown: usage.limitKnown,
    limitSource: usage.limitSource,
    windowFractions: usage.windowFractions,
    windowLimits: usage.windowLimits,
    fiveHourLimit: usage.windowLimits.fiveHour,
    weeklyLimit: usage.windowLimits.weekly,
    monthlyPlanPercentage: usage.windowPercentages.monthly,
    fiveHourPlanPercentage: usage.windowPercentages.fiveHour,
    weeklyPlanPercentage: usage.windowPercentages.weekly,
  }
}

export function exportData(db: Database.Database, format: 'csv' | 'json' | 'ndjson'): string {
  const records = db.prepare('SELECT * FROM records').all() as any[]

  if (format === 'csv') {
    const headers = 'timestamp,tool,model,provider,gateway,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,thinking_tokens,cost,real_cost,plan_draw,usage_multiplier,usage_multiplier_known,usage_multiplier_source,monthly_limit,limit_known,limit_source,five_hour_fraction,weekly_fraction,monthly_fraction,five_hour_limit,weekly_limit,monthly_plan_percentage,five_hour_plan_percentage,weekly_plan_percentage,cost_source,session_id,device,device_instance_id'
    const rows = records.map(r => {
      const ts = new Date(r.ts).toISOString()
      const usage = usageFields(r)
      return `${ts},${r.tool},${r.model},${r.provider},${r.gateway ?? ''},${r.input_tokens},${r.output_tokens},${r.cache_read_tokens},${r.cache_write_tokens},${r.thinking_tokens},${r.cost},${usage.realCost},${usage.planDraw},${usage.usageMultiplier},${usage.usageMultiplierKnown},${usage.usageMultiplierSource},${usage.monthlyLimit ?? ''},${usage.limitKnown},${usage.limitSource},${usage.windowFractions.fiveHour},${usage.windowFractions.weekly},${usage.windowFractions.monthly},${usage.fiveHourLimit ?? ''},${usage.weeklyLimit ?? ''},${usage.monthlyPlanPercentage ?? ''},${usage.fiveHourPlanPercentage ?? ''},${usage.weeklyPlanPercentage ?? ''},${r.cost_source},${r.session_id},${r.device},${r.device_instance_id}`
    })
    return [headers, ...rows].join('\n')
  }

  if (format === 'json') {
    const data = records.map(r => ({
      ...usageFields(r),
      timestamp: new Date(r.ts).toISOString(),
      tool: r.tool,
      model: r.model,
      provider: r.provider,
      gateway: r.gateway ?? null,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      thinkingTokens: r.thinking_tokens,
      cost: r.cost,
      costSource: r.cost_source,
      sessionId: r.session_id,
      device: r.device,
      deviceInstanceId: r.device_instance_id,
    }))
    return JSON.stringify(data, null, 2)
  }

  // ndjson
  const lines = records.map(r => JSON.stringify({
    ...usageFields(r),
    id: r.id,
    ts: r.ts,
    tool: r.tool,
    model: r.model,
    provider: r.provider,
    gateway: r.gateway ?? null,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    thinkingTokens: r.thinking_tokens,
    cost: r.cost,
    costSource: r.cost_source,
    sessionKey: r.session_id,
    device: r.device,
    deviceInstanceId: r.device_instance_id,
    updatedAt: r.updated_at,
  }))
  return lines.join('\n')
}
