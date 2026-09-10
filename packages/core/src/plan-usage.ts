/**
 * OpenCode Go plan consumption metadata.
 *
 * The provider catalogue is the preferred source for a usage multiplier: its
 * display name may carry a suffix such as "(2x usage)". AIUsage records do
 * not retain that display name, so this published-card snapshot is the
 * refreshable fallback for the model id, multiplier, rates, and per-model
 * limits. Snapshot source: opencode-go-card-20260910.txt.
 */

export const OPENCODE_GO_GATEWAY = 'opencode-go'

export const PLAN_WINDOW_FRACTIONS = {
  fiveHour: 0.2,
  weekly: 0.5,
  monthly: 1,
} as const

export type OpenCodeGoRateTierName = 'standard' | 'off-peak' | 'peak' | 'short-context' | 'long-context'

export interface OpenCodeGoRateTier {
  name: OpenCodeGoRateTierName
  input: number
  output: number
  cacheRead: number
  cacheWrite?: number
}

export interface OpenCodeGoCatalogEntry {
  model: string
  displayName: string
  usageMultiplier: number
  monthlyLimit: number
  rateTiers: readonly OpenCodeGoRateTier[]
}

function rate(
  name: OpenCodeGoRateTierName,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite?: number,
): OpenCodeGoRateTier {
  return cacheWrite == null
    ? { name, input, output, cacheRead }
    : { name, input, output, cacheRead, cacheWrite }
}

function standard(
  model: string,
  displayName: string,
  monthlyLimit: number,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite?: number,
  usageMultiplier = 1,
): OpenCodeGoCatalogEntry {
  return {
    model,
    displayName,
    usageMultiplier,
    monthlyLimit,
    rateTiers: [rate('standard', input, output, cacheRead, cacheWrite)],
  }
}

/**
 * Refreshed from the published OpenCode Go card on 2026-09-10.
 *
 * DeepSeek entries deliberately retain both card tiers. Peak is exactly 2x
 * off-peak during 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday; the
 * plan-draw multiplier remains a separate gateway/model property.
 */
export const OPENCODE_GO_CATALOG_SNAPSHOT: readonly OpenCodeGoCatalogEntry[] = [
  standard('glm-5.3-flash', 'GLM-5.3-Flash (2x usage)', 60, 0.15, 0.5, 0.03, undefined, 2),
  standard('glm-5.3', 'GLM-5.3', 15, 1.4, 4.4, 0.26),
  standard('glm-5.2', 'GLM-5.2', 60, 1.4, 4.4, 0.26),
  standard('glm-5.1', 'GLM-5.1', 60, 1.4, 4.4, 0.26),
  standard('kimi-k3', 'Kimi K3', 15, 3, 15, 0.3),
  standard('kimi-k2.7-code', 'Kimi K2.7 Code', 60, 0.95, 4, 0.19),
  standard('kimi-k2.6', 'Kimi K2.6', 60, 0.95, 4, 0.16),
  standard('longcat-2.0', 'LongCat-2.0', 60, 0.3, 1.2, 0.006),
  standard('mimo-v2.5', 'MiMo V2.5', 60, 0.14, 0.28, 0.0028),
  standard('mimo-v2.5-pro', 'MiMo V2.5 Pro', 15, 0.435, 0.87, 0.003625),
  standard('minimax-m3', 'MiniMax M3', 60, 0.3, 1.2, 0.06),
  standard('minimax-m2.7', 'MiniMax M2.7', 60, 0.3, 1.2, 0.06, 0.375),
  standard('minimax-m2.5', 'MiniMax M2.5', 60, 0.3, 1.2, 0.06, 0.375),
  standard('muse-spark-1.3-contributor', 'Muse Spark 1.3 Contributor', 60, 0.1, 0.2, 0.002),
  standard('muse-spark-1.2-contributor', 'Muse Spark 1.2 Contributor', 60, 0.1, 0.2, 0.002),
  standard('qwen3.8-max', 'Qwen3.8 Max', 15, 2, 6, 0.25, 2.5),
  standard('qwen3.8-flash', 'Qwen3.8 Flash', 30, 0.15, 0.47, 0.016, 0.2),
  standard('qwen3.7-max', 'Qwen3.7 Max', 30, 2.5, 7.5, 0.5, 3.125),
  {
    model: 'qwen3.7-plus',
    displayName: 'Qwen3.7 Plus',
    usageMultiplier: 1,
    monthlyLimit: 60,
    rateTiers: [
      rate('short-context', 0.4, 1.6, 0.04, 0.5),
      rate('long-context', 1.2, 4.8, 0.12, 1.5),
    ],
  },
  {
    model: 'qwen3.6-plus',
    displayName: 'Qwen3.6 Plus',
    usageMultiplier: 1,
    monthlyLimit: 60,
    rateTiers: [
      rate('short-context', 0.5, 3, 0.05, 0.625),
      rate('long-context', 2, 6, 0.2, 2.5),
    ],
  },
  {
    model: 'deepseek-v4.1-flash',
    displayName: 'DeepSeek V4.1 Flash',
    usageMultiplier: 1,
    monthlyLimit: 15,
    rateTiers: [
      rate('off-peak', 0.15, 0.6, 0.003),
      rate('peak', 0.3, 1.2, 0.006),
    ],
  },
  {
    model: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    usageMultiplier: 1,
    monthlyLimit: 15,
    rateTiers: [
      rate('off-peak', 0.66, 1.98, 0.022),
      rate('peak', 1.32, 3.96, 0.044),
    ],
  },
  {
    model: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    usageMultiplier: 1,
    monthlyLimit: 30,
    rateTiers: [
      rate('off-peak', 0.15, 0.6, 0.003),
      rate('peak', 0.3, 1.2, 0.006),
    ],
  },
  {
    model: 'deepseek-v4-flash-vision-exp',
    displayName: 'DeepSeek V4 Flash Vision Exp',
    usageMultiplier: 1,
    monthlyLimit: 15,
    rateTiers: [
      rate('off-peak', 0.15, 0.6, 0.003),
      rate('peak', 0.3, 1.2, 0.006),
    ],
  },
  standard('hy4-preview', 'Hy4 preview', 30, 0.834, 2.501, 0.042),
  standard('hy3', 'Hy3', 60, 0.14, 0.58, 0.035),
  {
    model: 'grok-4.6',
    displayName: 'Grok 4.6',
    usageMultiplier: 1,
    monthlyLimit: 15,
    rateTiers: [
      rate('short-context', 2, 6, 0.5),
      rate('long-context', 4, 12, 1),
    ],
  },
  {
    model: 'gpt-5.6-luna',
    displayName: 'GPT 5.6 Luna',
    usageMultiplier: 1,
    monthlyLimit: 15,
    rateTiers: [
      rate('short-context', 0.2, 1.2, 0.02, 0.25),
      rate('long-context', 0.4, 1.8, 0.04, 0.5),
    ],
  },
]

export type UsageMultiplierSource = 'provider-catalogue' | 'published-card-snapshot' | 'unknown'
export type PlanLimitSource = 'published-card-snapshot' | 'unknown'

export interface PlanWindowLimits {
  fiveHour: number | null
  weekly: number | null
  monthly: number | null
}

export interface UsagePolicy {
  usageMultiplier: number
  usageMultiplierKnown: boolean
  usageMultiplierSource: UsageMultiplierSource
  monthlyLimit: number | null
  limitKnown: boolean
  limitSource: PlanLimitSource
  windowFractions: typeof PLAN_WINDOW_FRACTIONS
  windowLimits: PlanWindowLimits
}

export interface UsageConsumption extends UsagePolicy {
  realCost: number
  planDraw: number
  windowPercentages: PlanWindowLimits
}

/** Parse a provider catalogue display-name suffix such as "(2x usage)". */
export function parseUsageMultiplier(displayName: unknown): number | undefined {
  if (typeof displayName !== 'string') return undefined
  const match = displayName.match(/\(\s*(\d+(?:\.\d+)?)\s*[x×]\s+usage\s*\)/i)
  if (!match) return undefined
  const multiplier = Number(match[1])
  return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : undefined
}

function normalizeGateway(gateway: unknown): string | undefined {
  if (typeof gateway !== 'string' || !gateway.trim()) return undefined
  return gateway.trim().toLowerCase().replace(/[ _]+/g, '-')
}

function normalizeModel(model: unknown): string | undefined {
  if (typeof model !== 'string' || !model.trim()) return undefined
  const withoutDisplaySuffix = model.trim().replace(/\s*\([^)]*\)\s*$/, '')
  const withoutProviderPrefix = withoutDisplaySuffix.slice(withoutDisplaySuffix.lastIndexOf('/') + 1)
  return withoutProviderPrefix.trim().toLowerCase().replace(/\s+/g, '-')
}

const CATALOG_BY_MODEL = new Map(OPENCODE_GO_CATALOG_SNAPSHOT.map(entry => [entry.model, entry]))

function unknownPolicy(): UsagePolicy {
  return {
    usageMultiplier: 1,
    usageMultiplierKnown: false,
    usageMultiplierSource: 'unknown',
    monthlyLimit: null,
    limitKnown: false,
    limitSource: 'unknown',
    windowFractions: PLAN_WINDOW_FRACTIONS,
    windowLimits: { fiveHour: null, weekly: null, monthly: null },
  }
}

/**
 * Resolve plan rules only for the OpenCode Go gateway. A known model name is
 * never enough: gateway attribution is the safety boundary for multipliers.
 */
export function resolveUsagePolicy(gateway: unknown, model: unknown, displayName?: unknown): UsagePolicy {
  if (normalizeGateway(gateway) !== OPENCODE_GO_GATEWAY) return unknownPolicy()

  const entry = CATALOG_BY_MODEL.get(normalizeModel(model) ?? '')
  const providerMultiplier = parseUsageMultiplier(displayName)
  const usageMultiplier = providerMultiplier ?? entry?.usageMultiplier
  const monthlyLimit = entry?.monthlyLimit ?? null
  const knownMultiplier = usageMultiplier != null

  return {
    usageMultiplier: usageMultiplier ?? 1,
    usageMultiplierKnown: knownMultiplier,
    usageMultiplierSource: providerMultiplier != null
      ? 'provider-catalogue'
      : knownMultiplier
        ? 'published-card-snapshot'
        : 'unknown',
    monthlyLimit,
    limitKnown: monthlyLimit != null,
    limitSource: monthlyLimit != null ? 'published-card-snapshot' : 'unknown',
    windowFractions: PLAN_WINDOW_FRACTIONS,
    windowLimits: monthlyLimit == null
      ? { fiveHour: null, weekly: null, monthly: null }
      : {
          fiveHour: monthlyLimit * PLAN_WINDOW_FRACTIONS.fiveHour,
          weekly: monthlyLimit * PLAN_WINDOW_FRACTIONS.weekly,
          monthly: monthlyLimit,
        },
  }
}

function percentage(value: number, limit: number | null): number | null {
  return limit == null || limit <= 0 ? null : (value / limit) * 100
}

export function calculateUsageConsumption(
  realCost: number,
  gateway: unknown,
  model: unknown,
  displayName?: unknown,
): UsageConsumption {
  const policy = resolveUsagePolicy(gateway, model, displayName)
  const safeRealCost = Number.isFinite(realCost) ? realCost : 0
  const planDraw = safeRealCost * policy.usageMultiplier

  return {
    ...policy,
    realCost: safeRealCost,
    planDraw,
    windowPercentages: {
      fiveHour: percentage(planDraw, policy.windowLimits.fiveHour),
      weekly: percentage(planDraw, policy.windowLimits.weekly),
      monthly: percentage(planDraw, policy.windowLimits.monthly),
    },
  }
}
