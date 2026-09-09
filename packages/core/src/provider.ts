export const MODEL_PROVIDER_MAP: [string, string][] = [
  ['claude-',    'anthropic'],
  ['gpt-',      'openai'],
  ['o1-',       'openai'],
  ['o3-',       'openai'],
  ['o4-',       'openai'],
  ['o-',        'openai'],
  ['deepseek-', 'deepseek'],
  ['gemini-',   'google'],
  ['glm-',      'zhipu'],
  ['mimo-',     'xiaomi'],
  ['minimax-',  'minimax'],
  ['kimi-',     'moonshot'],
  ['grok-',     'xai'],
  ['qianfan-',  'baidu'],
  ['qwen',      'alibaba'],
  ['qoder-',    'qoder'],
  ['cursor-',   'cursor'],
  ['zed-',      'zed'],
  ['goose-',    'goose'],
  ['kiro-',     'kiro'],
  ['z-ai/',     'zhipu'],
  ['accounts/fireworks/', 'fireworks'],
  ['frank/',    'zhipu'],
  ['nvidia/',   'nvidia'],
  ['moonshotai/', 'moonshot'],
  ['zai-org/',  'zhipu'],
]

export function inferProvider(model: string): string {
  for (const [prefix, provider] of MODEL_PROVIDER_MAP) {
    if (model.startsWith(prefix)) return provider
  }
  return 'unknown'
}

/**
 * Prefer endpoint/credential metadata from the source log. The model-derived
 * provider remains the compatibility fallback for sources that do not expose
 * a serving gateway.
 */
export function resolveGateway(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return undefined
}
