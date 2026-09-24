import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execSync, execFileSync } from 'node:child_process'
import {
  buildQuotaBridgeSnapshot,
  refreshQuotaBridge,
  resolveQuotaAxiBinary,
  quotaAxiWellKnownPaths,
  AIUSAGE_QUOTA_AXI_PATH_ENV,
  QUOTA_BRIDGE_VERSION,
  QUOTA_BRIDGE_TIMEOUT_MS,
  QUOTA_BRIDGE_PROVIDERS,
} from '../src/commands/quota-bridge.js'
import { QUOTA_BRIDGE_PATH } from '../src/quota.js'

vi.mock('node:child_process')

const { writes, mkdirs, fsControl } = vi.hoisted(() => ({
  writes: [] as any[][],
  mkdirs: [] as any[][],
  fsControl: { exists: null as null | ((p: any) => boolean) },
}))

// Capture bridge-file writes so refreshQuotaBridge never touches the real
// ~/.aiusage; every other fs call passes through to the real fs.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const realExistsSync = actual.existsSync as (...args: any[]) => boolean
  return {
    ...actual,
    writeFileSync: (...args: any[]) => {
      writes.push(args)
    },
    mkdirSync: (...args: any[]) => {
      mkdirs.push(args)
    },
    existsSync: ((p: any, ...rest: any[]) => {
      if (fsControl.exists) return fsControl.exists(p)
      return realExistsSync(p, ...rest)
    }) as typeof actual.existsSync,
  }
})

const mockExecSync = vi.mocked(execSync)
const mockExecFileSync = vi.mocked(execFileSync)

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const axiFixture = readFileSync(join(fixtureDir, 'quota-axi.json'), 'utf-8')
const bridgeFixtureShape = Object.keys(JSON.parse(readFileSync(join(fixtureDir, 'quota-bridge.json'), 'utf-8')))

const FIXED_NOW = 1758670000000

beforeEach(() => {
  vi.resetAllMocks()
  writes.length = 0
  mkdirs.length = 0
  fsControl.exists = null
})

afterEach(() => {
  delete process.env[AIUSAGE_QUOTA_AXI_PATH_ENV]
})

describe('buildQuotaBridgeSnapshot', () => {
  it('maps opencode-go and grok windows to snapshot entries', () => {
    const snapshot = buildQuotaBridgeSnapshot(axiFixture, FIXED_NOW)!
    expect(snapshot.bridgeVersion).toBe(QUOTA_BRIDGE_VERSION)
    expect(snapshot.updatedAt).toBe(FIXED_NOW)

    const opencode = snapshot.providers['opencode-go']
    expect(opencode.plan).toBe('OpenCode Go')
    expect(opencode.windows!.map((w) => w.id)).toEqual(['rolling', 'weekly', 'monthly'])
    expect(opencode.windows![1]).toMatchObject({
      id: 'weekly',
      label: 'weekly',
      kind: 'weekly',
      percentRemaining: 98,
      resetsAt: '2026-09-28T00:00:00.000Z',
    })

    const grok = snapshot.providers['grok']
    expect(grok.windows!.map((w) => w.id)).toEqual(['credits', 'product:grok_build'])
    expect(grok.windows![0]).toMatchObject({
      label: 'week',
      kind: 'weekly',
      percentRemaining: 79,
      resetsAt: '2026-09-30T15:56:03.000Z',
    })
  })

  it('keeps the snapshot secret-free and shape-stable', () => {
    const snapshot = buildQuotaBridgeSnapshot(axiFixture, FIXED_NOW)!
    const serialized = JSON.stringify(snapshot)
    for (const banned of ['accountKeys', 'quotaSemantics', 'credits', 'effectiveAvailability', 'runway', 'selection']) {
      // 'credits' survives only as a grok window id, never as a payload key.
      if (banned === 'credits') {
        expect(serialized).not.toContain('"credits":')
      } else {
        expect(serialized).not.toContain(banned)
      }
    }
    // Same top-level shape as the reader fixture the cards are tested against.
    expect(Object.keys(snapshot).sort()).toEqual([...bridgeFixtureShape].sort())
    for (const provider of Object.values(snapshot.providers)) {
      for (const key of Object.keys(provider)) {
        expect(['plan', 'windows', 'error']).toContain(key)
      }
    }
  })

  it('marks unknown-kind rolling windows suppressed but keeps their numbers', () => {
    const snapshot = buildQuotaBridgeSnapshot(axiFixture, FIXED_NOW)!
    const rolling = snapshot.providers['opencode-go'].windows!.find((w) => w.id === 'rolling')!
    expect(rolling.kind).toBe('unknown')
    expect(rolling.pace).toMatchObject({ suppressed: true })
    expect(rolling.pace!['reservePercentPoints']).toBeCloseTo(59.94, 1)
    expect(rolling.pace!['burnMultiple']).toBeCloseTo(0.0164, 4)
  })

  it('passes known-kind pace through without a suppressed flag', () => {
    const snapshot = buildQuotaBridgeSnapshot(axiFixture, FIXED_NOW)!
    const weekly = snapshot.providers['opencode-go'].windows!.find((w) => w.id === 'weekly')!
    expect(weekly.pace).toMatchObject({ status: 'behind', reservePercentPoints: 50.6355, burnMultiple: 0.038 })
    expect(weekly.pace).not.toHaveProperty('suppressed')
  })

  it('records the vendor error when a provider reports no windows', () => {
    const snapshot = buildQuotaBridgeSnapshot(axiFixture, FIXED_NOW)!
    // The fixture claude entry is auth_required with credentials_invalid.
    expect(snapshot.providers['claude']).toEqual({ error: 'credentials_invalid' })
    // codex stays a normal pace entry.
    expect(snapshot.providers['codex'].windows).toHaveLength(1)
  })

  it('records an error for providers missing from the output', () => {
    const partial = JSON.stringify({
      providers: [
        { provider: 'grok', windows: [{ id: 'credits', label: 'week', kind: 'weekly', percentRemaining: 79 }] },
      ],
    })
    const snapshot = buildQuotaBridgeSnapshot(partial, FIXED_NOW)!
    expect(snapshot.providers['grok'].windows).toHaveLength(1)
    expect(snapshot.providers['opencode-go']).toEqual({ error: 'provider missing from quota-axi output' })
  })

  it('records notSetUp providers as errors', () => {
    const payload = JSON.stringify({
      providers: [
        { provider: 'opencode-go', windows: [], state: { status: 'auth_required' }, notSetUp: true },
        { provider: 'grok', windows: [], state: { status: 'unknown' }, notSetUp: true },
        { provider: 'claude', windows: [], state: { status: 'auth_required' } },
        { provider: 'codex', windows: [], state: { status: 'auth_required' } },
      ],
    })
    const snapshot = buildQuotaBridgeSnapshot(payload, FIXED_NOW)!
    expect(snapshot.providers['opencode-go']).toEqual({ error: 'auth_required' })
    expect(snapshot.providers['grok']).toEqual({ error: 'provider not set up in quota-axi' })
  })

  it('returns null for invalid JSON or a missing providers array', () => {
    expect(buildQuotaBridgeSnapshot('not json{', FIXED_NOW)).toBeNull()
    expect(buildQuotaBridgeSnapshot(JSON.stringify({ providers: {} }), FIXED_NOW)).toBeNull()
  })

  it('drops windows without a finite percentRemaining', () => {
    const payload = JSON.stringify({
      providers: QUOTA_BRIDGE_PROVIDERS.map((provider) => ({
        provider,
        windows: [
          { id: 'good', label: 'good', kind: 'weekly', percentRemaining: 50 },
          { id: 'bad', label: 'bad', kind: 'weekly' },
        ],
      })),
    })
    const snapshot = buildQuotaBridgeSnapshot(payload, FIXED_NOW)!
    for (const key of QUOTA_BRIDGE_PROVIDERS) {
      expect(snapshot.providers[key].windows!.map((w) => w.id)).toEqual(['good'])
    }
  })
})

describe('resolveQuotaAxiBinary', () => {
  it('honours the AIUSAGE_QUOTA_AXI_PATH override', () => {
    fsControl.exists = (p) => p === '/custom/bin/quota-axi'
    process.env[AIUSAGE_QUOTA_AXI_PATH_ENV] = '/custom/bin/quota-axi'
    expect(resolveQuotaAxiBinary()).toEqual({ bin: '/custom/bin/quota-axi', reason: null })
  })

  it('reports the probe reason when nothing resolves', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found')
    })
    fsControl.exists = () => false
    const resolved = resolveQuotaAxiBinary()
    expect(resolved.bin).toBeNull()
    expect(resolved.reason).toContain(AIUSAGE_QUOTA_AXI_PATH_ENV)
    expect(resolved.reason).toContain(quotaAxiWellKnownPaths().join(', '))
  })
})

describe('refreshQuotaBridge', () => {
  it('polls quota-axi for the bridge providers and writes the bridge file', () => {
    mockExecFileSync.mockReturnValue(axiFixture)
    const { path, snapshot } = refreshQuotaBridge({ bin: '/fake/quota-axi', now: FIXED_NOW })
    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/fake/quota-axi',
      ['--provider', 'opencode-go,grok,claude,codex', '--json'],
      expect.objectContaining({ encoding: 'utf8', timeout: QUOTA_BRIDGE_TIMEOUT_MS }),
    )
    expect(path).toBe(QUOTA_BRIDGE_PATH)
    expect(QUOTA_BRIDGE_PATH).toBe(join(homedir(), '.aiusage', 'quota-bridge.json'))
    expect(mkdirs.length).toBe(1)
    expect(writes).toHaveLength(1)
    expect(writes[0][0]).toBe(QUOTA_BRIDGE_PATH)
    expect(JSON.parse(writes[0][1])).toEqual(JSON.parse(JSON.stringify(snapshot)))
    expect(snapshot.providers['grok'].windows).toHaveLength(2)
  })

  it('skips the file write when write:false', () => {
    mockExecFileSync.mockReturnValue(axiFixture)
    const { snapshot } = refreshQuotaBridge({ bin: '/fake/quota-axi', now: FIXED_NOW, write: false })
    expect(writes).toHaveLength(0)
    expect(mkdirs).toHaveLength(0)
    expect(snapshot.providers['opencode-go'].windows).toHaveLength(3)
  })

  it('throws a readable error when quota-axi is missing', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found')
    })
    fsControl.exists = () => false
    expect(() => refreshQuotaBridge()).toThrow(/quota-axi not found on PATH/)
    expect(writes).toHaveLength(0)
  })

  it('throws when quota-axi output is unusable', () => {
    mockExecFileSync.mockReturnValue('not json{')
    expect(() => refreshQuotaBridge({ bin: '/fake/quota-axi' })).toThrow(/invalid JSON/)
    expect(writes).toHaveLength(0)
  })
})
