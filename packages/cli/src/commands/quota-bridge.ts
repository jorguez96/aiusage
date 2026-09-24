// Scheduled quota-bridge writer (opencode + grok cards, claude/codex pace).
//
// The dashboard process cannot read the vendor credentials that live next to
// the vendor CLIs (and Grok's vendor quota endpoint needs token refresh), so
// this command polls `quota-axi --provider opencode-go,grok,claude,codex
// --json` and writes the compact, secret-free snapshot that queryBridgeQuota
// and mergeBridgePace in ../quota.js read from <AIUSAGE_DIR>/quota-bridge.json.
//
// Run it on a schedule (cron/systemd/Task Scheduler, every few minutes); the
// dashboard only reads the file and never calls a vendor quota API itself.
// Binary resolution mirrors resolveAgyBinary in ../quota.js: the
// AIUSAGE_QUOTA_AXI_PATH override wins, then PATH, then well-known locations.

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { AIUSAGE_DIR } from '../config.js'
import { QUOTA_BRIDGE_PATH } from '../quota.js'

export const AIUSAGE_QUOTA_AXI_PATH_ENV = 'AIUSAGE_QUOTA_AXI_PATH'

/** Snapshot schema version written by this module. The reader accepts any version. */
export const QUOTA_BRIDGE_VERSION = 1

export const QUOTA_BRIDGE_TIMEOUT_MS = 60000

/**
 * quota-axi provider keys in the snapshot: opencode-go/grok feed their cards,
 * claude/codex feed pace targets merged onto the vendor card tiers.
 */
export const QUOTA_BRIDGE_PROVIDERS = ['opencode-go', 'grok', 'claude', 'codex'] as const

/** Well-known quota-axi install locations checked when the binary is not on PATH. Exported for tests. */
export function quotaAxiWellKnownPaths(home: string = homedir()): string[] {
  const exe = platform() === 'win32' ? 'quota-axi.exe' : 'quota-axi'
  return [
    join(home, '.local', 'bin', exe),
    '/opt/homebrew/bin/quota-axi',
    '/usr/local/bin/quota-axi',
    join(home, '.npm-global', 'bin', exe),
  ]
}

/** Resolve the quota-axi binary: AIUSAGE_QUOTA_AXI_PATH override → PATH probe → well-known locations. Exported for tests. */
export function resolveQuotaAxiBinary(): { bin: string | null; reason: string | null } {
  const override = process.env[AIUSAGE_QUOTA_AXI_PATH_ENV]?.trim()
  if (override && existsSync(override)) {
    return { bin: override, reason: null }
  }
  const probe = platform() === 'win32' ? 'where quota-axi' : 'command -v quota-axi'
  try {
    execSync(probe, { timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { bin: 'quota-axi', reason: null }
  } catch {
    // Not on PATH — fall through to well-known locations.
  }
  for (const candidate of quotaAxiWellKnownPaths()) {
    try {
      if (existsSync(candidate)) return { bin: candidate, reason: null }
    } catch {
      continue
    }
  }
  const checked = quotaAxiWellKnownPaths().join(', ')
  const reason = override
    ? `quota-axi not found on PATH (${AIUSAGE_QUOTA_AXI_PATH_ENV} points to a missing file: ${override}); checked ${checked}.`
    : `quota-axi not found on PATH; checked ${checked}. Set ${AIUSAGE_QUOTA_AXI_PATH_ENV} to the quota-axi binary to override.`
  return { bin: null, reason }
}

export interface BridgeSnapshotWindow {
  id: string
  label: string
  kind: string
  percentRemaining: number
  resetsAt: string | null
  pace?: Record<string, unknown>
}

export interface BridgeSnapshotProvider {
  plan?: string
  windows?: BridgeSnapshotWindow[]
  error?: string
}

export interface BridgeSnapshotDoc {
  bridgeVersion: number
  updatedAt: number
  providers: Record<string, BridgeSnapshotProvider>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Pace fields the reader understands; everything else is dropped to keep the
// snapshot compact and secret-free.
const PACE_FIELDS = ['status', 'reason', 'reservePercentPoints', 'burnMultiple', 'derived', 'suppressed'] as const

function cleanPace(raw: unknown): Record<string, unknown> | undefined {
  const src = asRecord(raw)
  if (!src) return undefined
  const out: Record<string, unknown> = {}
  for (const field of PACE_FIELDS) {
    const value = src[field]
    if (value === undefined) continue
    if (field === 'reservePercentPoints' || field === 'burnMultiple') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
    } else if (field === 'derived' || field === 'suppressed') {
      if (typeof value !== 'boolean') continue
    } else if (typeof value !== 'string') {
      continue
    }
    out[field] = value
  }
  return out
}

function cleanWindow(raw: unknown): BridgeSnapshotWindow | null {
  const w = asRecord(raw)
  if (!w) return null
  const percentRemaining = asFiniteNumber(w['percentRemaining'])
  if (percentRemaining == null) return null
  const kind = typeof w['kind'] === 'string' && w['kind'] ? w['kind'] : 'unknown'
  const id = typeof w['id'] === 'string' && w['id'] ? w['id'] : 'window'
  const label = typeof w['label'] === 'string' && w['label'].trim() ? w['label'].trim() : id
  const window: BridgeSnapshotWindow = {
    id,
    label,
    kind,
    percentRemaining,
    resetsAt: typeof w['resetsAt'] === 'string' ? w['resetsAt'] : null,
  }
  const pace = cleanPace(w['pace'])
  if (kind === 'unknown') {
    // Rolling-style windows have no knowable length, so no linear pace target
    // is derivable; mark them suppressed so the card hides the pace line.
    window.pace = { ...(pace ?? {}), suppressed: true }
  } else if (pace) {
    window.pace = pace
  }
  return window
}

function providerError(entry: Record<string, unknown>): string {
  const state = asRecord(entry['state'])
  const rawError = state?.['error']
  if (typeof rawError === 'string' && rawError.trim()) return rawError.trim()
  const status = state && typeof state['status'] === 'string' ? state['status'] : null
  if (entry['notSetUp'] === true) {
    return status && status !== 'unknown' ? status : 'provider not set up in quota-axi'
  }
  return status ?? 'quota-axi returned no quota windows'
}

/**
 * Map `quota-axi --json` output to the bridge snapshot shape the dashboard
 * reader expects. Returns null when the payload is not usable JSON.
 * Pure function — exported for tests.
 */
export function buildQuotaBridgeSnapshot(axiText: string, now: number = Date.now()): BridgeSnapshotDoc | null {
  let root: unknown
  try {
    root = JSON.parse(axiText)
  } catch {
    return null
  }
  const providers = asRecord(root)?.['providers']
  if (!Array.isArray(providers)) return null
  const byKey = new Map<string, Record<string, unknown>>()
  for (const item of providers) {
    const rec = asRecord(item)
    if (!rec || typeof rec['provider'] !== 'string') continue
    if (!byKey.has(rec['provider'])) byKey.set(rec['provider'], rec)
  }
  const snapshotProviders: Record<string, BridgeSnapshotProvider> = {}
  for (const key of QUOTA_BRIDGE_PROVIDERS) {
    const entry = byKey.get(key)
    if (!entry) {
      snapshotProviders[key] = { error: 'provider missing from quota-axi output' }
      continue
    }
    const rawWindows = Array.isArray(entry['windows']) ? entry['windows'] : []
    const windows = rawWindows
      .map(cleanWindow)
      .filter((w): w is BridgeSnapshotWindow => w !== null)
    if (windows.length === 0) {
      snapshotProviders[key] = { error: providerError(entry) }
      continue
    }
    const provider: BridgeSnapshotProvider = { windows }
    if (typeof entry['plan'] === 'string' && entry['plan'].trim()) {
      provider.plan = entry['plan'].trim()
    }
    snapshotProviders[key] = provider
  }
  return { bridgeVersion: QUOTA_BRIDGE_VERSION, updatedAt: now, providers: snapshotProviders }
}

export interface RefreshQuotaBridgeOptions {
  /** Skip binary resolution (tests, explicit installs). */
  bin?: string
  /** quota-axi provider keys to request. Defaults to QUOTA_BRIDGE_PROVIDERS. */
  providers?: string[]
  timeoutMs?: number
  now?: number
  /** Write the bridge file. Defaults to true; false returns the snapshot without touching disk. */
  write?: boolean
}

export interface RefreshQuotaBridgeResult {
  path: string
  snapshot: BridgeSnapshotDoc
}

/**
 * Poll quota-axi and rewrite the bridge snapshot atomically from this process.
 * Throws with a human-readable message when quota-axi is missing or unusable;
 * the CLI layer turns that into stderr + exit 1.
 */
export function refreshQuotaBridge(options: RefreshQuotaBridgeOptions = {}): RefreshQuotaBridgeResult {
  const resolved = options.bin ? { bin: options.bin, reason: null } : resolveQuotaAxiBinary()
  if (!resolved.bin) {
    throw new Error(resolved.reason ?? 'quota-axi binary not found')
  }
  const providers = options.providers?.length ? options.providers : [...QUOTA_BRIDGE_PROVIDERS]
  let text: string
  try {
    text = execFileSync(resolved.bin, ['--provider', providers.join(','), '--json'], {
      timeout: options.timeoutMs ?? QUOTA_BRIDGE_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: platform() === 'win32',
    })
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error(`quota-axi not found at ${resolved.bin}; set ${AIUSAGE_QUOTA_AXI_PATH_ENV} to the quota-axi binary to override.`)
    }
    throw new Error(`quota-axi --json failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  const snapshot = buildQuotaBridgeSnapshot(text, options.now ?? Date.now())
  if (!snapshot) {
    throw new Error('quota-axi --json returned invalid JSON or an unexpected payload')
  }
  if (options.write === false) {
    return { path: QUOTA_BRIDGE_PATH, snapshot }
  }
  mkdirSync(AIUSAGE_DIR, { recursive: true })
  writeFileSync(QUOTA_BRIDGE_PATH, JSON.stringify(snapshot), 'utf-8')
  return { path: QUOTA_BRIDGE_PATH, snapshot }
}
