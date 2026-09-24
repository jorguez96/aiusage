import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, execFileSync } from 'node:child_process'
import { parseAgyQuotaOutput, queryGeminiQuota, queryGrokBridgeQuota, queryOpencodeBridgeQuota, queryAllQuotas, paceForWindow, mergeBridgePace, resolveAgyBinary, agyWellKnownPaths, AIUSAGE_AGY_PATH_ENV } from '../src/quota.js'

vi.mock('node:child_process')

const { bridgeFile, agyFallback } = vi.hoisted(() => ({
  bridgeFile: { content: null as string | null },
  agyFallback: { paths: null as Set<string> | null },
}))

// The bridge providers read exactly <AIUSAGE_DIR>/quota-bridge.json via
// readFileSync; serve that single path from hoisted state so each test controls
// the snapshot while every other file read passes through to the real fs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const os = await import('node:os')
  const path = await import('node:path')
  const bridgePath = path.join(os.homedir(), '.aiusage', 'quota-bridge.json')
  const realReadFileSync = actual.readFileSync as (...args: any[]) => any
  const realExistsSync = actual.existsSync as (...args: any[]) => boolean
  return {
    ...actual,
    readFileSync: (...args: any[]) => {
      if (args[0] === bridgePath) {
        if (bridgeFile.content == null) {
          throw Object.assign(new Error(`ENOENT: no such file or directory, open '${args[0]}'`), { code: 'ENOENT' })
        }
        return bridgeFile.content
      }
      return realReadFileSync(...args)
    },
    // Deterministic agy fallback: well-known agy binaries are absent unless a
    // test opts in via agyFallback.paths. All other paths pass through.
    existsSync: ((p: any, ...rest: any[]) => {
      const s = String(p)
      const base = path.basename(s)
      if (base === 'agy' || base === 'agy.exe') {
        if (agyFallback.paths) return agyFallback.paths.has(s)
        return false
      }
      return (realExistsSync as any)(p, ...rest)
    }) as typeof actual.existsSync,
  }
})

const mockExecSync = vi.mocked(execSync)
const mockExecFileSync = vi.mocked(execFileSync)

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const agyOutput = readFileSync(join(fixtureDir, 'agy-quota.json'), 'utf-8')
const bridgeFixture = readFileSync(join(fixtureDir, 'quota-bridge.json'), 'utf-8')

/** Serve the bridge fixture as the quota-bridge snapshot. */
function useFixtureBridge(): void {
  bridgeFile.content = bridgeFixture
}

/** Serve a custom value as the quota-bridge snapshot. */
function useCustomBridge(value: unknown): void {
  bridgeFile.content = typeof value === 'string' ? value : JSON.stringify(value)
}

/** Serve no quota-bridge snapshot (file absent). */
function useNoBridge(): void {
  bridgeFile.content = null
}

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
    agyFallback.paths = null
    delete process.env[AIUSAGE_AGY_PATH_ENV]
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    agyFallback.paths = null
    delete process.env[AIUSAGE_AGY_PATH_ENV]
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

describe('resolveAgyBinary', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    agyFallback.paths = null
    delete process.env[AIUSAGE_AGY_PATH_ENV]
  })

  afterEach(() => {
    agyFallback.paths = null
    delete process.env[AIUSAGE_AGY_PATH_ENV]
  })

  it('lists the well-known fallback locations', () => {
    const paths = agyWellKnownPaths('/home/test')
    expect(paths).toContain('/home/test/.local/bin/agy')
    expect(paths).toContain('/opt/homebrew/bin/agy')
    expect(paths.some((p) => p.includes('agy') && p.includes('bin'))).toBe(true)
  })

  it('prefers the AIUSAGE_AGY_PATH override when it exists', () => {
    const override = '/tmp/aiusage-agy-test/agy'
    agyFallback.paths = new Set([override])
    process.env[AIUSAGE_AGY_PATH_ENV] = override
    mockExecSync.mockImplementation(() => { throw new Error('command not found') })
    expect(resolveAgyBinary()).toEqual({ bin: override, reason: null })
  })

  it('falls back to a well-known location when agy is off PATH', () => {
    mockExecSync.mockImplementation(() => { throw new Error('command not found') })
    const [candidate] = agyWellKnownPaths()
    agyFallback.paths = new Set([candidate])
    expect(resolveAgyBinary()).toEqual({ bin: candidate, reason: null })
  })

  it('explains the probe when nothing is found, naming a missing override', () => {
    mockExecSync.mockImplementation(() => { throw new Error('command not found') })
    process.env[AIUSAGE_AGY_PATH_ENV] = '/tmp/aiusage-agy-missing/agy'
    const resolved = resolveAgyBinary()
    expect(resolved.bin).toBeNull()
    expect(resolved.reason).toContain('agy CLI not found')
    expect(resolved.reason).toContain(AIUSAGE_AGY_PATH_ENV)
    expect(resolved.reason).toContain('/tmp/aiusage-agy-missing/agy')
  })

  it('points at the override env var when no override is set', () => {
    mockExecSync.mockImplementation(() => { throw new Error('command not found') })
    const resolved = resolveAgyBinary()
    expect(resolved.bin).toBeNull()
    expect(resolved.reason).toContain(AIUSAGE_AGY_PATH_ENV)
  })
})

describe('queryGeminiQuota PATH-robustness', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    agyFallback.paths = null
    delete process.env[AIUSAGE_AGY_PATH_ENV]
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    agyFallback.paths = null
    delete process.env[AIUSAGE_AGY_PATH_ENV]
  })

  it('queries via the AIUSAGE_AGY_PATH binary when agy is off PATH', async () => {
    const override = '/tmp/aiusage-agy-test/agy'
    agyFallback.paths = new Set([override])
    process.env[AIUSAGE_AGY_PATH_ENV] = override
    mockExecSync.mockImplementation(() => { throw new Error('command not found') })
    mockExecFileSync.mockReturnValue(agyOutput as any)
    const result = await queryGeminiQuota()
    expect(result).toMatchObject({ tool: 'gemini', credentialStatus: 'valid', success: true })
    expect(mockExecFileSync).toHaveBeenCalledWith(
      override,
      ['-p', '/quota', '--output-format', 'json'],
      expect.objectContaining({ timeout: 15000 }),
    )
  })

  it('queries via a well-known location when agy is off PATH', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('command not found') })
    const [candidate] = agyWellKnownPaths()
    agyFallback.paths = new Set([candidate])
    mockExecFileSync.mockReturnValue(agyOutput as any)
    const result = await queryGeminiQuota()
    expect(result).toMatchObject({ tool: 'gemini', credentialStatus: 'valid', success: true })
    expect(result.tiers.map(t => t.name)).toEqual(['gemini_5h', 'gemini_weekly'])
    expect(mockExecFileSync).toHaveBeenCalledWith(
      candidate,
      ['-p', '/quota', '--output-format', 'json'],
      expect.objectContaining({ timeout: 15000 }),
    )
  })

  it('states the probe cause in the not_found message', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('command not found') })
    const result = await queryGeminiQuota()
    expect(result).toMatchObject({ tool: 'gemini', credentialStatus: 'not_found', success: false, tiers: [] })
    expect(result.credentialMessage).toContain('agy CLI not found')
    expect(result.credentialMessage).toContain(AIUSAGE_AGY_PATH_ENV)
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })
})

describe('queryAllQuotas', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    useNoBridge()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    useNoBridge()
  })

  it('includes gemini, opencode and grok entries alongside the other tools', async () => {
    useFixtureBridge()
    mockExecSync.mockReturnValue('/home/test/.local/bin/agy' as any)
    mockExecFileSync.mockReturnValue(agyOutput as any)
    const results = await queryAllQuotas()
    expect(results.map(r => r.tool)).toEqual(['claude-code', 'codex', 'copilot', 'gemini', 'opencode', 'grok'])
    const gemini = results.find(r => r.tool === 'gemini')!
    expect(gemini.success).toBe(true)
    expect(gemini.tiers).toHaveLength(2)
    // Pace merging only touches claude/codex vendor tiers; gemini tiers stay bare.
    expect(gemini.tiers.every(t => t.pace === undefined)).toBe(true)
    const opencode = results.find(r => r.tool === 'opencode')!
    expect(opencode.success).toBe(true)
    expect(opencode.tiers).toHaveLength(3)
    expect(opencode.tiers.every(t => t.pace !== undefined)).toBe(true)
    const grok = results.find(r => r.tool === 'grok')!
    expect(grok.success).toBe(true)
    expect(grok.tiers).toHaveLength(2)
    expect(grok.tiers[0].pace).toMatchObject({ state: 'over' })
  })

  it('reports bridge providers as not_found when the snapshot is absent', async () => {
    useNoBridge()
    mockExecSync.mockReturnValue('/home/test/.local/bin/agy' as any)
    mockExecFileSync.mockReturnValue(agyOutput as any)
    const results = await queryAllQuotas()
    expect(results.map(r => r.tool)).toEqual(['claude-code', 'codex', 'copilot', 'gemini', 'opencode', 'grok'])
    for (const tool of ['opencode', 'grok']) {
      const entry = results.find(r => r.tool === tool)!
      expect(entry).toMatchObject({ credentialStatus: 'not_found', success: false, tiers: [] })
    }
  })
})

describe('paceForWindow', () => {
  it('reports unknown when pace is absent or not an object', () => {
    expect(paceForWindow(undefined, 10)).toEqual({ state: 'unknown', line: 'no pace target' })
    expect(paceForWindow(null, 10)).toEqual({ state: 'unknown', line: 'no pace target' })
    expect(paceForWindow('ahead', 10)).toEqual({ state: 'unknown', line: 'no pace target' })
  })

  it('explains known unknown-reasons on the line', () => {
    expect(paceForWindow({ status: 'unknown', reason: 'missing_cycle' }, 10)).toEqual({
      state: 'unknown',
      line: 'no pace target (cycle unknown)',
    })
    expect(paceForWindow({ status: 'unknown', reason: 'stale' }, 10)).toEqual({
      state: 'unknown',
      line: 'no pace target (data stale)',
    })
    expect(paceForWindow({ status: 'unknown', reason: 'something-new' }, 10)).toEqual({
      state: 'unknown',
      line: 'no pace target',
    })
  })

  it('hides suppressed rolling windows with an empty line', () => {
    expect(paceForWindow({ suppressed: true }, 10)).toEqual({ state: 'hidden', line: '' })
    // Suppression wins even over vendor-backed pace values.
    expect(paceForWindow({ suppressed: true, status: 'behind', reservePercentPoints: -5, burnMultiple: 2 }, 10)).toEqual({
      state: 'hidden',
      line: '',
    })
  })

  it('reports on target for on_pace status or a reserve within a point', () => {
    expect(paceForWindow({ status: 'on_pace', reservePercentPoints: 5, burnMultiple: 1 }, 10)).toEqual({
      state: 'on',
      targetUsagePercent: 15,
      line: '✓ on target · burn 1×',
      reservePercentPoints: 5,
      burnMultiple: 1,
      derived: false,
    })
    expect(paceForWindow({ status: 'behind', reservePercentPoints: -0.5 }, 10).state).toBe('on')
  })

  it('reports over/under lines with whole-point magnitudes at ten or more', () => {
    const over = paceForWindow({ status: 'behind', reservePercentPoints: -16.3579, burnMultiple: 4.5238 }, 21)
    expect(over).toMatchObject({
      state: 'over',
      line: '▲ 16 pts over target · burn 4.52×',
      reservePercentPoints: -16.3579,
      burnMultiple: 4.5238,
      derived: false,
    })
    expect(over.targetUsagePercent).toBeCloseTo(4.6421, 6)
    const under = paceForWindow({ status: 'behind', reservePercentPoints: 31.2411, burnMultiple: 0.5422 }, 37)
    expect(under.state).toBe('under')
    expect(under.line).toBe('▼ 31 pts under target · burn 0.54×')
    expect(under.targetUsagePercent).toBeCloseTo(68.2411, 6)
  })

  it('reports one-decimal magnitudes below ten and omits a missing burn note', () => {
    const over = paceForWindow({ status: 'ahead', reservePercentPoints: -3.25 }, 50)
    expect(over).toEqual({
      state: 'over',
      targetUsagePercent: 46.75,
      line: '▲ 3.3 pts over target',
      reservePercentPoints: -3.25,
      burnMultiple: null,
      derived: false,
    })
  })

  it('labels derived gap-fill targets approx and clamps the marker', () => {
    const under = paceForWindow({ status: 'behind', reservePercentPoints: 95, burnMultiple: 0.5, derived: true }, 50)
    expect(under.targetUsagePercent).toBe(100)
    expect(under.line).toBe('▼ 95 pts under target · burn 0.5× · approx')
    expect(under.derived).toBe(true)
    const over = paceForWindow({ status: 'ahead', reservePercentPoints: -95 }, 5)
    expect(over.targetUsagePercent).toBe(0)
  })
})

describe('mergeBridgePace', () => {
  beforeEach(() => {
    useNoBridge()
  })

  afterEach(() => {
    useNoBridge()
  })

  function vendorResult(tiers: any[]) {
    return {
      tool: 'claude-code',
      credentialStatus: 'valid',
      credentialMessage: null,
      success: true,
      tiers,
      error: null,
      queriedAt: 1,
    } as any
  }

  it('matches vendor tiers to bridge windows by id and attaches pace', () => {
    useCustomBridge({
      updatedAt: 1,
      providers: {
        claude: {
          windows: [
            { id: 'five_hour', kind: 'session', label: 'session', percentRemaining: 70, resetsAt: '2026-09-24T03:00:00Z', pace: { status: 'behind', reservePercentPoints: -5, burnMultiple: 2 } },
          ],
        },
      },
    })
    const result = vendorResult([{ name: 'five_hour', utilization: 30, resetsAt: null }])
    mergeBridgePace(result, 'claude')
    expect(result.tiers).toHaveLength(1)
    expect(result.tiers[0].pace).toEqual({
      state: 'over',
      targetUsagePercent: 25,
      line: '▲ 5.0 pts over target · burn 2×',
      reservePercentPoints: -5,
      burnMultiple: 2,
      derived: false,
    })
  })

  it('falls back to matching by window kind and marks unmatched tiers unknown', () => {
    useCustomBridge({
      updatedAt: 1,
      providers: {
        claude: {
          windows: [
            { id: 'primary', kind: 'weekly', label: 'weekly', percentRemaining: 80, resetsAt: null, pace: { status: 'on_pace', reservePercentPoints: 0.2 } },
          ],
        },
      },
    })
    const result = vendorResult([
      { name: 'seven_day', utilization: 20, resetsAt: null },
      { name: 'five_hour', utilization: 10, resetsAt: null },
    ])
    mergeBridgePace(result, 'claude')
    expect(result.tiers).toHaveLength(2)
    expect(result.tiers[0].pace.state).toBe('on')
    expect(result.tiers[1].pace).toEqual({ state: 'unknown', line: 'no pace target' })
  })

  it('appends bridge windows the vendor call has no row for', () => {
    useCustomBridge({
      updatedAt: 1,
      providers: {
        codex: {
          windows: [
            { id: 'model:gpt-5', kind: 'weekly', label: 'GPT-5', percentRemaining: 50, resetsAt: '2026-09-30T00:00:00Z', pace: { suppressed: true } },
          ],
        },
      },
    })
    const result = vendorResult([])
    mergeBridgePace(result, 'codex')
    expect(result.tiers).toHaveLength(1)
    expect(result.tiers[0]).toEqual({
      name: 'GPT-5',
      utilization: 50,
      resetsAt: '2026-09-30T00:00:00Z',
      pace: { state: 'hidden', line: '' },
    })
  })

  it('leaves unsuccessful results alone and skips tiers that already carry pace', () => {
    useFixtureBridge()
    const failed = vendorResult([]) as any
    failed.success = false
    mergeBridgePace(failed, 'claude')
    expect(failed.tiers).toEqual([])

    const paced = vendorResult([{ name: 'five_hour', utilization: 30, resetsAt: null, pace: { state: 'on', line: 'kept' } }])
    mergeBridgePace(paced, 'claude')
    expect(paced.tiers[0].pace).toEqual({ state: 'on', line: 'kept' })
  })
})

describe('queryGrokBridgeQuota', () => {
  afterEach(() => {
    useNoBridge()
  })

  it('maps bridge windows to card tiers with utilization, resetsAt and pace', async () => {
    useFixtureBridge()
    const result = await queryGrokBridgeQuota()
    expect(result.tool).toBe('grok')
    expect(result.credentialStatus).toBe('valid')
    expect(result.success).toBe(true)
    expect(result.error).toBeNull()
    expect(result.queriedAt).toBe(JSON.parse(bridgeFixture).updatedAt)
    expect(result.tiers.map(t => t.name)).toEqual(['week', 'Grok Build'])

    const entry = JSON.parse(bridgeFixture).providers.grok
    const windowByLabel = Object.fromEntries(entry.windows.map((w: any) => [w.label, w]))
    for (const tier of result.tiers) {
      const window = windowByLabel[tier.name]
      expect(tier.utilization).toBeCloseTo(100 - window.percentRemaining, 6)
      expect(tier.resetsAt).toBe(window.resetsAt)
      expect(tier.pace!.state).toBe('over')
      expect(tier.pace!.targetUsagePercent).toBeCloseTo(tier.utilization + window.pace.reservePercentPoints, 6)
    }
  })

  it('returns not_found when the bridge file is absent', async () => {
    useNoBridge()
    const result = await queryGrokBridgeQuota()
    expect(result).toMatchObject({ tool: 'grok', credentialStatus: 'not_found', success: false, tiers: [] })
  })

  it('returns not_found when the bridge file is not valid JSON', async () => {
    useCustomBridge('not json{')
    const result = await queryGrokBridgeQuota()
    expect(result).toMatchObject({ tool: 'grok', credentialStatus: 'not_found', success: false, tiers: [] })
  })

  it('returns not_found when the provider is missing from the snapshot', async () => {
    const snapshot = JSON.parse(bridgeFixture)
    delete snapshot.providers.grok
    useCustomBridge(snapshot)
    const result = await queryGrokBridgeQuota()
    expect(result).toMatchObject({ tool: 'grok', credentialStatus: 'not_found', success: false, tiers: [] })
  })

  it('returns an error result when the provider has no usable windows', async () => {
    useCustomBridge({ updatedAt: 1, providers: { grok: { windows: [{ id: 'credits' }], error: 'stale auth' } } })
    const result = await queryGrokBridgeQuota()
    expect(result).toMatchObject({ tool: 'grok', credentialStatus: 'valid', success: false })
    expect(result.error).toContain('stale auth')
    expect(result.tiers).toEqual([])
  })

  it('skips windows without a remaining fraction', async () => {
    useCustomBridge({
      updatedAt: 1,
      providers: {
        grok: {
          windows: [
            { id: 'credits', label: 'week', resetsAt: '2026-09-30T15:56:03.000Z' },
            { id: 'product:grok_build', label: 'Grok Build', percentRemaining: 79, resetsAt: 'not-a-date' },
          ],
        },
      },
    })
    const result = await queryGrokBridgeQuota()
    expect(result.success).toBe(true)
    expect(result.tiers).toHaveLength(1)
    expect(result.tiers[0]).toEqual({
      name: 'Grok Build',
      utilization: 21,
      resetsAt: 'not-a-date',
      pace: { state: 'unknown', line: 'no pace target' },
    })
  })
})

describe('queryOpencodeBridgeQuota', () => {
  afterEach(() => {
    useNoBridge()
  })

  it('maps opencode-go windows to card tiers with utilization, resetsAt and pace', async () => {
    useFixtureBridge()
    const result = await queryOpencodeBridgeQuota()
    expect(result.tool).toBe('opencode')
    expect(result.credentialStatus).toBe('valid')
    expect(result.success).toBe(true)
    expect(result.error).toBeNull()
    expect(result.tiers.map(t => t.name)).toEqual(['session', 'weekly', 'monthly'])

    const entry = JSON.parse(bridgeFixture).providers['opencode-go']
    const windowByLabel = Object.fromEntries(entry.windows.map((w: any) => [w.label, w]))
    for (const tier of result.tiers) {
      const window = windowByLabel[tier.name]
      expect(tier.utilization).toBeCloseTo(100 - window.percentRemaining, 6)
      expect(tier.resetsAt).toBe(window.resetsAt)
      expect(tier.pace!.targetUsagePercent).toBeCloseTo(
        Math.max(0, Math.min(100, tier.utilization + window.pace.reservePercentPoints)),
        6,
      )
    }
    expect(result.tiers[2].pace!.state).toBe('under')
  })

  it('returns not_found when the bridge file is absent', async () => {
    useNoBridge()
    const result = await queryOpencodeBridgeQuota()
    expect(result).toMatchObject({ tool: 'opencode', credentialStatus: 'not_found', success: false, tiers: [] })
  })

  it('returns not_found when the provider is missing from the snapshot', async () => {
    const snapshot = JSON.parse(bridgeFixture)
    delete snapshot.providers['opencode-go']
    useCustomBridge(snapshot)
    const result = await queryOpencodeBridgeQuota()
    expect(result).toMatchObject({ tool: 'opencode', credentialStatus: 'not_found', success: false, tiers: [] })
  })

  it('falls back to the window id when the label is missing', async () => {
    useCustomBridge({
      updatedAt: 1,
      providers: { 'opencode-go': { windows: [{ id: 'weekly', percentRemaining: 40, resetsAt: null }] } },
    })
    const result = await queryOpencodeBridgeQuota()
    expect(result.success).toBe(true)
    expect(result.tiers).toEqual([
      { name: 'weekly', utilization: 60, resetsAt: null, pace: { state: 'unknown', line: 'no pace target' } },
    ])
  })
})
