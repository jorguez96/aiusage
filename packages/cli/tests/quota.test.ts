import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, execFileSync } from 'node:child_process'
import { parseAgyQuotaOutput, queryGeminiQuota, queryAllQuotas } from '../src/quota.js'

vi.mock('node:child_process')

const mockExecSync = vi.mocked(execSync)
const mockExecFileSync = vi.mocked(execFileSync)

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const agyOutput = readFileSync(join(fixtureDir, 'agy-quota.json'), 'utf-8')

describe('parseAgyQuotaOutput', () => {
  it('maps Gemini buckets to card tiers with utilization and resetsAt', () => {
    const tiers = parseAgyQuotaOutput(agyOutput)
    expect(tiers).not.toBeNull()
    expect(tiers!.map(t => t.name)).toEqual(['gemini_5h', 'gemini_weekly'])

    const payload = JSON.parse(agyOutput).command.data
    const gemini = payload.groups.find((g: any) => g.name === 'Gemini Models')
    const bucketById = Object.fromEntries(gemini.buckets.map((b: any) => [b.id, b]))
    for (const tier of tiers!) {
      const bucket = bucketById[tier.name === 'gemini_5h' ? 'gemini-5h' : 'gemini-weekly']
      expect(tier.utilization).toBeCloseTo((1 - bucket.remaining_fraction) * 100, 6)
      expect(tier.resetsAt).toBe(new Date(bucket.reset_time).toISOString())
    }
  })

  it('leaves claude_gpt windows out', () => {
    const tiers = parseAgyQuotaOutput(agyOutput)
    expect(tiers!.some(t => t.name.includes('claude'))).toBe(false)
    expect(tiers!.some(t => t.name.includes('gpt') || t.name.includes('3p'))).toBe(false)
  })

  it('returns null for invalid JSON', () => {
    expect(parseAgyQuotaOutput('not json{')).toBeNull()
  })

  it('returns null for a non-usage command payload', () => {
    expect(parseAgyQuotaOutput(JSON.stringify({ command: { name: 'chat', data: {} } }))).toBeNull()
  })

  it('skips buckets without a remaining fraction', () => {
    const text = JSON.stringify({
      command: {
        name: '/quota',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                { id: 'gemini-5h', window: '5h', reset_time: '2026-09-24T03:33:28Z' },
                { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.5, reset_time: 'not-a-date' },
              ],
            },
          ],
        },
      },
    })
    const tiers = parseAgyQuotaOutput(text)
    expect(tiers).toHaveLength(1)
    expect(tiers![0]).toEqual({ name: 'gemini_weekly', utilization: 50, resetsAt: null })
  })
})

describe('queryGeminiQuota', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns not_found when the agy CLI is absent', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('command not found') })
    const result = await queryGeminiQuota()
    expect(result).toMatchObject({ tool: 'gemini', credentialStatus: 'not_found', success: false, tiers: [] })
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns Gemini tiers when the agy CLI succeeds', async () => {
    mockExecSync.mockReturnValue('/home/test/.local/bin/agy' as any)
    mockExecFileSync.mockReturnValue(agyOutput as any)
    const result = await queryGeminiQuota()
    expect(result.tool).toBe('gemini')
    expect(result.credentialStatus).toBe('valid')
    expect(result.success).toBe(true)
    expect(result.error).toBeNull()
    expect(result.tiers.map(t => t.name)).toEqual(['gemini_5h', 'gemini_weekly'])
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'agy',
      ['-p', '/quota', '--output-format', 'json'],
      expect.objectContaining({ timeout: 15000 }),
    )
  })

  it('returns an error result when the agy CLI fails', async () => {
    mockExecSync.mockReturnValue('/home/test/.local/bin/agy' as any)
    mockExecFileSync.mockImplementation(() => { throw new Error('Command failed: agy -p /quota') })
    const result = await queryGeminiQuota()
    expect(result).toMatchObject({ tool: 'gemini', credentialStatus: 'valid', success: false })
    expect(result.error).toContain('agy /quota failed')
    expect(result.tiers).toEqual([])
  })

  it('returns not_found when the agy binary vanishes between probe and query', async () => {
    mockExecSync.mockReturnValue('/home/test/.local/bin/agy' as any)
    mockExecFileSync.mockImplementation(() => { throw Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }) })
    const result = await queryGeminiQuota()
    expect(result).toMatchObject({ tool: 'gemini', credentialStatus: 'not_found', success: false })
  })
})

describe('queryAllQuotas', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('includes a gemini entry alongside the other tools', async () => {
    mockExecSync.mockReturnValue('/home/test/.local/bin/agy' as any)
    mockExecFileSync.mockReturnValue(agyOutput as any)
    const results = await queryAllQuotas()
    expect(results.map(r => r.tool)).toEqual(['claude-code', 'codex', 'copilot', 'gemini'])
    const gemini = results.find(r => r.tool === 'gemini')!
    expect(gemini.success).toBe(true)
    expect(gemini.tiers).toHaveLength(2)
  })
})
