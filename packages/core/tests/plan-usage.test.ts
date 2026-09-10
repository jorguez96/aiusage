import { describe, expect, it } from 'vitest'
import {
  OPENCODE_GO_CATALOG_SNAPSHOT,
  calculateUsageConsumption,
  parseUsageMultiplier,
  resolveUsagePolicy,
} from '../src/plan-usage.js'

describe('plan usage policy', () => {
  it('parses a provider catalogue usage suffix', () => {
    expect(parseUsageMultiplier('GLM-5.3-Flash (2x usage)')).toBe(2)
    expect(parseUsageMultiplier('Kimi K2.7 Code')).toBeUndefined()
  })

  it('applies the Go multiplier and model-specific windows', () => {
    const usage = calculateUsageConsumption(9.4739, 'opencode-go', 'glm-5.3-flash')

    expect(usage.realCost).toBe(9.4739)
    expect(usage.planDraw).toBeCloseTo(18.9478, 8)
    expect(usage.usageMultiplier).toBe(2)
    expect(usage.usageMultiplierKnown).toBe(true)
    expect(usage.monthlyLimit).toBe(60)
    expect(usage.windowLimits).toEqual({ fiveHour: 12, weekly: 30, monthly: 60 })
    expect(usage.windowPercentages.monthly).toBeCloseTo(31.5796666667, 8)
  })

  it('never multiplies a Go model when another gateway served it', () => {
    const go = calculateUsageConsumption(1, 'opencode-go', 'glm-5.3-flash')
    const openRouter = calculateUsageConsumption(1, 'openrouter', 'glm-5.3-flash')
    const legacy = calculateUsageConsumption(1, undefined, 'glm-5.3-flash')

    expect(go.planDraw).toBe(2)
    expect(openRouter.planDraw).toBe(1)
    expect(legacy.planDraw).toBe(1)
    expect(openRouter.usageMultiplierKnown).toBe(false)
    expect(legacy.usageMultiplierKnown).toBe(false)
    expect(openRouter.monthlyLimit).toBeNull()
    expect(legacy.monthlyLimit).toBeNull()
  })

  it('uses the model own limit for lower-limit Go models', () => {
    const usage = calculateUsageConsumption(1, 'opencode-go', 'glm-5.3')

    expect(usage.usageMultiplier).toBe(1)
    expect(usage.monthlyLimit).toBe(15)
    expect(usage.windowLimits).toEqual({ fiveHour: 3, weekly: 7.5, monthly: 15 })
    expect(usage.windowPercentages.fiveHour).toBeCloseTo(33.3333333333, 8)
    expect(usage.windowPercentages.weekly).toBeCloseTo(13.3333333333, 8)
    expect(usage.windowPercentages.monthly).toBeCloseTo(6.6666666667, 8)
  })

  it('keeps the refreshed DeepSeek peak/off-peak card tiers together', () => {
    const entry = OPENCODE_GO_CATALOG_SNAPSHOT.find(model => model.model === 'deepseek-v4.1-flash')

    expect(entry?.monthlyLimit).toBe(15)
    expect(entry?.rateTiers).toEqual([
      { name: 'off-peak', input: 0.15, output: 0.6, cacheRead: 0.003 },
      { name: 'peak', input: 0.3, output: 1.2, cacheRead: 0.006 },
    ])
  })

  it('can take a multiplier directly from provider metadata without widening gateway scope', () => {
    const fromMetadata = resolveUsagePolicy('opencode-go', 'new-model', 'New Model (1.5x usage)')
    const otherGateway = resolveUsagePolicy('openrouter', 'new-model', 'New Model (1.5x usage)')

    expect(fromMetadata).toMatchObject({
      usageMultiplier: 1.5,
      usageMultiplierKnown: true,
      usageMultiplierSource: 'provider-catalogue',
      monthlyLimit: null,
    })
    expect(otherGateway).toMatchObject({
      usageMultiplier: 1,
      usageMultiplierKnown: false,
      usageMultiplierSource: 'unknown',
    })
  })
})
