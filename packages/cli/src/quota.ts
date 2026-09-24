/**
 * F6: Official Subscription Quota Query
 *
 * Reads local OAuth credentials for each AI tool and queries their official
 * usage APIs to get real-time quota utilization.
 *
 * Supported tools: claude-code, codex, copilot, gemini (via agy CLI),
 * opencode + grok (via the scheduled quota-bridge snapshot in AIUSAGE_DIR).
 * The bridge snapshot also carries per-window pace targets, merged onto the
 * claude/codex vendor tiers and attached to the bridge providers' own tiers.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import { execSync, execFileSync } from 'node:child_process'
import { AIUSAGE_DIR } from './config.js'

// ── Types ────────────────────────────────────────────────────────────────────

export type CredentialStatus = 'valid' | 'expired' | 'not_found' | 'parse_error'

export interface QuotaTier {
  /** Window identifier: five_hour, seven_day, seven_day_opus, seven_day_sonnet, weekly_limit, etc. */
  name: string
  /** Utilization percentage 0–100 */
  utilization: number
  /** ISO 8601 reset time, null if unknown */
  resetsAt: string | null
  /** Per-window pace target merged from the quota-bridge snapshot; absent until merged. */
  pace?: QuotaPace
}

export interface QuotaPace {
  /** Target-line state: on/over/under vs the time-linear target, unknown when no target is derivable, hidden for suppressed rolling windows. */
  state: 'on' | 'over' | 'under' | 'unknown' | 'hidden'
  /** Render-ready line, e.g. "▲ 16 pts over target · burn 4.52×". Empty when hidden. */
  line: string
  /** Target usage percent marking the bar position; absent when there is no target. */
  targetUsagePercent?: number
  reservePercentPoints?: number | null
  burnMultiple?: number | null
  /** True when the bridge gap-filled this target from a nominal window length. */
  derived?: boolean
}

export interface QuotaResult {
  tool: string
  credentialStatus: CredentialStatus
  credentialMessage: string | null
  success: boolean
  tiers: QuotaTier[]
  error: string | null
  queriedAt: number | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function nowMs(): number {
  return Date.now()
}

function notFound(tool: string, message: string | null = null): QuotaResult {
  return { tool, credentialStatus: 'not_found', credentialMessage: message, success: false, tiers: [], error: null, queriedAt: null }
}

function parseError(tool: string, message: string): QuotaResult {
  return { tool, credentialStatus: 'parse_error', credentialMessage: message, success: false, tiers: [], error: message, queriedAt: nowMs() }
}

function expiredError(tool: string, message: string): QuotaResult {
  return { tool, credentialStatus: 'expired', credentialMessage: message, success: false, tiers: [], error: message, queriedAt: nowMs() }
}

function apiError(tool: string, message: string): QuotaResult {
  return { tool, credentialStatus: 'valid', credentialMessage: null, success: false, tiers: [], error: message, queriedAt: nowMs() }
}

function isExpired(expiresAt: unknown): boolean {
  if (expiresAt == null) return false
  const nowSecs = Date.now() / 1000
  if (typeof expiresAt === 'number') {
    // distinguish seconds vs milliseconds
    const secs = expiresAt > 1e12 ? expiresAt / 1000 : expiresAt
    return secs < nowSecs
  }
  if (typeof expiresAt === 'string') {
    const ts = Date.parse(expiresAt)
    if (!isNaN(ts)) return ts / 1000 < nowSecs
  }
  return false
}

// ── macOS Keychain helper ────────────────────────────────────────────────────

function readFromKeychain(service: string): string | null {
  if (platform() !== 'darwin') return null
  try {
    const result = execSync(`security find-generic-password -s "${service}" -w 2>/dev/null`, {
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return result || null
  } catch {
    return null
  }
}

// ── Claude Code credential reading ──────────────────────────────────────────

interface ClaudeCredResult {
  token: string | null
  status: CredentialStatus
  message: string | null
}

function parseClaudeCredJson(content: string): ClaudeCredResult {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(content)
  } catch (e) {
    return { token: null, status: 'parse_error', message: `Failed to parse credentials JSON: ${e}` }
  }

  const entry = (parsed['claudeAiOauth'] ?? parsed['claude.ai_oauth']) as Record<string, unknown> | undefined
  if (!entry) {
    return { token: null, status: 'parse_error', message: 'No OAuth entry found in credentials' }
  }

  const accessToken = entry['accessToken'] as string | undefined
  if (!accessToken) {
    return { token: null, status: 'parse_error', message: 'accessToken is empty or missing' }
  }

  if (isExpired(entry['expiresAt'])) {
    return { token: accessToken, status: 'expired', message: 'OAuth token has expired' }
  }

  return { token: accessToken, status: 'valid', message: null }
}

function readClaudeCredentials(): ClaudeCredResult {
  // Try macOS Keychain first
  const keychainJson = readFromKeychain('Claude Code-credentials')
  if (keychainJson) {
    const keychainResult = parseClaudeCredJson(keychainJson)
    if (keychainResult.status === 'valid' || keychainResult.status === 'expired') {
      return keychainResult
    }
    // Keychain data unusable (parse_error / not_found) — fall through to file
  }

  // Fall back to ~/.claude/.credentials.json
  const credPath = join(homedir(), '.claude', '.credentials.json')
  if (!existsSync(credPath)) {
    return { token: null, status: 'not_found', message: null }
  }

  let content: string
  try {
    content = readFileSync(credPath, 'utf-8')
  } catch (e) {
    return { token: null, status: 'parse_error', message: `Failed to read credentials file: ${e}` }
  }

  return parseClaudeCredJson(content)
}

// ── Codex credential reading ─────────────────────────────────────────────────

interface CodexCredResult {
  token: string | null
  accountId: string | null
  status: CredentialStatus
  message: string | null
}

function parseCodexCredJson(content: string): CodexCredResult {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(content)
  } catch (e) {
    return { token: null, accountId: null, status: 'parse_error', message: `Failed to parse Codex auth JSON: ${e}` }
  }

  // Only OAuth mode has usage data
  if (parsed['auth_mode'] !== 'chatgpt') {
    return { token: null, accountId: null, status: 'not_found', message: 'Codex not using OAuth mode' }
  }

  const tokens = parsed['tokens'] as Record<string, unknown> | undefined
  if (!tokens) {
    return { token: null, accountId: null, status: 'parse_error', message: 'No tokens in Codex auth' }
  }

  const accessToken = tokens['access_token'] as string | undefined
  if (!accessToken) {
    return { token: null, accountId: null, status: 'parse_error', message: 'access_token is empty or missing' }
  }

  const accountId = (tokens['account_id'] ?? parsed['account_id']) as string | undefined ?? null

  // Check expiry if available
  const expiresAt = tokens['expires_at'] ?? tokens['expiresAt']
  if (isExpired(expiresAt)) {
    return { token: accessToken, accountId, status: 'expired', message: 'Codex OAuth token may be stale' }
  }

  return { token: accessToken, accountId, status: 'valid', message: null }
}

function readCodexCredentials(): CodexCredResult {
  // Try macOS Keychain first
  const keychainJson = readFromKeychain('Codex Auth')
  if (keychainJson) {
    const keychainResult = parseCodexCredJson(keychainJson)
    if (keychainResult.status === 'valid' || keychainResult.status === 'expired') {
      return keychainResult
    }
    // Keychain data unusable (parse_error / not_found) — fall through to file
  }

  // Fall back to ~/.codex/auth.json
  const authPath = join(homedir(), '.codex', 'auth.json')
  if (!existsSync(authPath)) {
    return { token: null, accountId: null, status: 'not_found', message: null }
  }

  let content: string
  try {
    content = readFileSync(authPath, 'utf-8')
  } catch (e) {
    return { token: null, accountId: null, status: 'parse_error', message: `Failed to read Codex auth file: ${e}` }
  }

  return parseCodexCredJson(content)
}

// ── Claude quota API query ────────────────────────────────────────────────────

const CLAUDE_KNOWN_TIERS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']
const CLAUDE_QUOTA_URL = 'https://api.anthropic.com/api/oauth/usage'

async function queryClaudeQuota(accessToken: string): Promise<QuotaResult> {
  let resp: Response
  try {
    resp = await fetch(CLAUDE_QUOTA_URL, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    })
  } catch (e) {
    return apiError('claude-code', `Network error: ${e}`)
  }

  if (resp.status === 401 || resp.status === 403) {
    return expiredError('claude-code', `Authentication failed (HTTP ${resp.status}). Please re-login with Claude CLI.`)
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    return apiError('claude-code', `API error (HTTP ${resp.status}): ${body}`)
  }

  let body: Record<string, unknown>
  try {
    body = await resp.json()
  } catch (e) {
    return apiError('claude-code', `Failed to parse API response: ${e}`)
  }

  const tiers: QuotaTier[] = []

  // Parse known tiers first (in defined order)
  for (const name of CLAUDE_KNOWN_TIERS) {
    const window = body[name] as Record<string, unknown> | undefined
    if (!window) continue
    const utilization = window['utilization'] as number | undefined
    if (utilization == null) continue
    tiers.push({
      name,
      utilization,
      resetsAt: (window['resets_at'] as string | undefined) ?? null,
    })
  }

  // Parse any additional unknown tiers returned by the API
  for (const [key, value] of Object.entries(body)) {
    if (key === 'extra_usage' || CLAUDE_KNOWN_TIERS.includes(key)) continue
    const window = value as Record<string, unknown> | undefined
    if (!window || typeof window !== 'object') continue
    const utilization = window['utilization'] as number | undefined
    if (utilization == null) continue
    tiers.push({
      name: key,
      utilization,
      resetsAt: (window['resets_at'] as string | undefined) ?? null,
    })
  }

  return {
    tool: 'claude-code',
    credentialStatus: 'valid',
    credentialMessage: null,
    success: true,
    tiers,
    error: null,
    queriedAt: nowMs(),
  }
}

// ── Codex quota API query ─────────────────────────────────────────────────────

const CODEX_QUOTA_URL = 'https://chatgpt.com/backend-api/wham/usage'

function windowSecondsToTierName(seconds: number): string {
  if (seconds <= 3600 * 6) return 'five_hour'     // ≤6h → 5h window
  if (seconds <= 86400 * 7) return 'weekly_limit' // ≤7d → weekly
  return `${seconds}s`
}

async function callCodexQuotaApi(accessToken: string, accountId: string | null): Promise<QuotaResult> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': 'codex-cli',
    'Accept': 'application/json',
  }
  if (accountId) headers['ChatGPT-Account-Id'] = accountId

  let resp: Response
  try {
    resp = await fetch(CODEX_QUOTA_URL, {
      headers,
      signal: AbortSignal.timeout(10000),
    })
  } catch (e) {
    return apiError('codex', `Network error: ${e}`)
  }

  if (resp.status === 401 || resp.status === 403) {
    return expiredError('codex', `Authentication failed (HTTP ${resp.status}). Please re-login with Codex CLI.`)
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    return apiError('codex', `API error (HTTP ${resp.status}): ${body}`)
  }

  let body: Record<string, unknown>
  try {
    body = await resp.json()
  } catch (e) {
    return apiError('codex', `Failed to parse API response: ${e}`)
  }

  const tiers: QuotaTier[] = []
  const rateLimit = body['rate_limit'] as Record<string, unknown> | undefined

  if (rateLimit) {
    for (const windowKey of ['primary_window', 'secondary_window']) {
      const window = rateLimit[windowKey] as Record<string, unknown> | undefined
      if (!window) continue
      const usedPercent = window['used_percent'] as number | undefined
      if (usedPercent == null) continue
      const windowSecs = window['limit_window_seconds'] as number | undefined
      const name = windowSecs != null ? windowSecondsToTierName(windowSecs) : 'unknown'
      const resetAt = window['reset_at'] as number | null | undefined
      const resetsAt = resetAt ? new Date(resetAt * 1000).toISOString() : null
      tiers.push({ name, utilization: usedPercent, resetsAt })
    }
  }

  return {
    tool: 'codex',
    credentialStatus: 'valid',
    credentialMessage: null,
    success: true,
    tiers,
    error: null,
    queriedAt: nowMs(),
  }
}

// ── GitHub Copilot credential reading ────────────────────────────────────────

function readCopilotOauthToken(): string | null {
  const home = homedir()
  const candidates = [
    join(home, '.config', 'github-copilot', 'apps.json'),
    join(home, '.config', 'github-copilot', 'hosts.json'),
  ]
  // Keys are "github.com", "github.com:Iv1.xxx" (app ID), or enterprise hosts.
  // Prefer the public-host token; fall back to whatever's available.
  let fallback: string | null = null
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object') continue
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Record<string, unknown>
      const token = typeof entry.oauth_token === 'string' ? entry.oauth_token : ''
      if (!token) continue
      const host = String(key).split(':')[0]
      if (host === 'github.com') return token
      if (!fallback) fallback = token
    }
  }
  return fallback
}

// ── GitHub Copilot quota API query ───────────────────────────────────────────

const COPILOT_API_URL = 'https://api.github.com/copilot_internal/user'

function copilotResetIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const trimmed = value.trim()
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
  const ts = Date.parse(dateOnly ? `${trimmed}T00:00:00Z` : trimmed)
  if (!Number.isFinite(ts)) return null
  return new Date(ts).toISOString()
}

function buildCopilotTier(
  name: string,
  snapshot: Record<string, unknown> | undefined,
  resetIso: string | null,
): QuotaTier | null {
  if (!snapshot || typeof snapshot !== 'object') return null
  const entitlement = Number(snapshot.entitlement)
  const remaining = Number(snapshot.remaining)
  const percentRemaining = Number(snapshot.percent_remaining)

  const allZero =
    (!entitlement || entitlement <= 0) &&
    (!remaining || remaining <= 0) &&
    (!percentRemaining || percentRemaining <= 0)
  if (allZero) return null

  let utilization: number
  if (Number.isFinite(percentRemaining)) {
    utilization = 100 - percentRemaining
  } else if (Number.isFinite(entitlement) && entitlement > 0 && Number.isFinite(remaining)) {
    utilization = ((entitlement - remaining) / entitlement) * 100
  } else {
    return null
  }

  return { name, utilization, resetsAt: resetIso }
}

async function callCopilotQuotaApi(token: string): Promise<QuotaResult> {
  let resp: Response
  try {
    resp = await fetch(COPILOT_API_URL, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/json',
        'Editor-Version': 'vscode/1.96.2',
        'Editor-Plugin-Version': 'copilot-chat/0.26.7',
        'User-Agent': 'GitHubCopilotChat/0.26.7',
        'X-Github-Api-Version': '2025-04-01',
      },
      signal: AbortSignal.timeout(10000),
    })
  } catch (e) {
    return apiError('copilot', `Network error: ${e}`)
  }

  if (resp.status === 401 || resp.status === 403) {
    return expiredError('copilot', `GitHub Copilot token rejected (HTTP ${resp.status}). Re-authenticate via Copilot extension.`)
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    return apiError('copilot', `GitHub Copilot API error (HTTP ${resp.status}): ${body}`)
  }

  let body: Record<string, unknown>
  try {
    body = await resp.json()
  } catch (e) {
    return apiError('copilot', `Failed to parse API response: ${e}`)
  }

  const resetIso = copilotResetIso(body.quota_reset_date)
  const snapshots = (body.quota_snapshots ?? {}) as Record<string, Record<string, unknown>>

  const tiers: QuotaTier[] = []
  const premiumTier = buildCopilotTier('premium_interactions', snapshots.premium_interactions, resetIso)
  if (premiumTier) tiers.push(premiumTier)
  const chatTier = buildCopilotTier('chat', snapshots.chat, resetIso)
  if (chatTier) tiers.push(chatTier)

  return {
    tool: 'copilot',
    credentialStatus: 'valid',
    credentialMessage: null,
    success: true,
    tiers,
    error: null,
    queriedAt: nowMs(),
  }
}

// ── Gemini (Antigravity) credential reading ──────────────────────────────────
// The agy CLI manages its own auth; presence of the CLI is the credential
// signal. The dashboard server often runs with a minimal PATH (launcher,
// daemon, fresh shell), so before reporting not_found fall back to
// well-known install locations plus an AIUSAGE_AGY_PATH override. The
// resolved probe reason is returned as the not_found message so the
// inactive card states the cause instead of a generic "no credentials".

export const AIUSAGE_AGY_PATH_ENV = 'AIUSAGE_AGY_PATH'

/** Well-known agy install locations checked when the binary is not on PATH. Exported for tests. */
export function agyWellKnownPaths(home: string = homedir(), localAppData?: string): string[] {
  const exe = platform() === 'win32' ? 'agy.exe' : 'agy'
  const lad = localAppData ?? process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  return [
    join(home, '.local', 'bin', exe),
    '/opt/homebrew/bin/agy',
    join(lad, 'agy', 'bin', exe),
  ]
}

/** Resolve the agy binary: AIUSAGE_AGY_PATH override → PATH probe → well-known locations. Exported for tests. */
export function resolveAgyBinary(): { bin: string | null; reason: string | null } {
  const override = process.env[AIUSAGE_AGY_PATH_ENV]?.trim()
  if (override && existsSync(override)) {
    return { bin: override, reason: null }
  }
  const probe = platform() === 'win32' ? 'where agy' : 'command -v agy'
  try {
    execSync(probe, { timeout: 3000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    return { bin: 'agy', reason: null }
  } catch {
    // Not on PATH — fall through to well-known locations.
  }
  for (const candidate of agyWellKnownPaths()) {
    try {
      if (existsSync(candidate)) return { bin: candidate, reason: null }
    } catch {
      continue
    }
  }
  const checked = agyWellKnownPaths().join(', ')
  const reason = override
    ? `agy CLI not found on PATH (${AIUSAGE_AGY_PATH_ENV} points to a missing file: ${override}); checked ${checked}.`
    : `agy CLI not found on PATH; checked ${checked}. Set ${AIUSAGE_AGY_PATH_ENV} to the agy binary to override.`
  return { bin: null, reason }
}

function readGeminiCredentials(): { status: CredentialStatus; message: string | null; bin: string | null } {
  const resolved = resolveAgyBinary()
  if (resolved.bin) return { status: 'valid', message: null, bin: resolved.bin }
  return { status: 'not_found', message: resolved.reason, bin: null }
}

// ── Gemini (Antigravity) quota query ─────────────────────────────────────────
// Replicates the agy CLI quota read from quota-axi's agy provider: run
// `agy -p /quota --output-format json` and map the Gemini Models buckets to
// card tiers. Claude/GPT buckets are intentionally left out.

const AGY_QUOTA_TIMEOUT_MS = 15000

function agySlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function agyNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function agyObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function agyRemainingFraction(bucket: Record<string, unknown>): number | undefined {
  const direct = agyNumber(bucket['remainingFraction'] ?? bucket['remaining_fraction'])
  if (direct !== undefined) return direct
  const remaining = bucket['remaining']
  if (typeof remaining === 'number' || typeof remaining === 'string') return agyNumber(remaining)
  const nested = agyObject(remaining)
  if (!nested) return undefined
  return agyNumber(nested['remainingFraction'] ?? nested['remaining_fraction'] ?? nested['value'])
}

function agyResetIso(bucket: Record<string, unknown>): string | null {
  const raw = bucket['resetTime'] ?? bucket['reset_time']
  if (typeof raw !== 'string' || !raw.trim()) return null
  const ts = Date.parse(raw.trim())
  if (!Number.isFinite(ts)) return null
  return new Date(ts).toISOString()
}

/** Map an agy bucket to a card tier name, or null when it is not a Gemini window. */
function agyTierName(groupName: string, bucket: Record<string, unknown>): string | null {
  const bucketId = bucket['bucketId'] ?? bucket['bucket_id'] ?? bucket['id']
  if (typeof bucketId !== 'string' || !bucketId) return null
  if (!`${groupName} ${bucketId}`.toLowerCase().includes('gemini')) return null
  const raw = [bucket['window'], bucket['bucketId'], bucket['bucket_id'], bucket['displayName'], bucket['name']]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase()
  if (raw.includes('5h') || raw.includes('five')) return 'gemini_5h'
  if (raw.includes('week')) return 'gemini_weekly'
  return `gemini_${agySlug(bucketId) || 'quota'}`
}

/**
 * Parse `agy -p /quota --output-format json` output into card tiers.
 * Returns null when the payload is not a usage/quota response.
 */
export function parseAgyQuotaOutput(text: string): QuotaTier[] | null {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return null
  }
  const command = agyObject(agyObject(root)?.['command'])
  const name = command?.['name']
  if (name !== 'usage' && name !== '/usage' && name !== 'quota' && name !== '/quota') return null
  const data = agyObject(command?.['data'])
  const groups = data?.['groups']
  if (!Array.isArray(groups)) return null

  const tiers: QuotaTier[] = []
  for (const group of groups) {
    const g = agyObject(group)
    if (!g) continue
    const groupName = g['displayName'] ?? g['name']
    if (typeof groupName !== 'string') continue
    const buckets = g['buckets']
    if (!Array.isArray(buckets)) continue
    for (const bucket of buckets) {
      const b = agyObject(bucket)
      if (!b) continue
      if (b['disabled'] === true) continue
      const tierName = agyTierName(groupName, b)
      if (!tierName) continue
      const remaining = agyRemainingFraction(b)
      if (remaining === undefined) continue
      const clamped = Math.min(1, Math.max(0, remaining))
      tiers.push({ name: tierName, utilization: (1 - clamped) * 100, resetsAt: agyResetIso(b) })
    }
  }

  const rank = (tierName: string): number => tierName === 'gemini_5h' ? 0 : tierName === 'gemini_weekly' ? 1 : 2
  tiers.sort((a, b) => rank(a.name) - rank(b.name))
  return tiers
}

async function queryAgyQuota(bin: string = 'agy'): Promise<QuotaResult> {
  let text: string
  try {
    text = execFileSync(bin, ['-p', '/quota', '--output-format', 'json'], {
      timeout: AGY_QUOTA_TIMEOUT_MS,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return notFound('gemini', `agy CLI not found at ${bin}; set ${AIUSAGE_AGY_PATH_ENV} to the agy binary to override.`)
    }
    return apiError('gemini', `agy /quota failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  const tiers = parseAgyQuotaOutput(text)
  if (!tiers) return apiError('gemini', 'agy /quota returned invalid JSON or an unexpected payload')
  if (tiers.length === 0) return apiError('gemini', 'No Gemini quota windows in agy /quota output')
  return {
    tool: 'gemini',
    credentialStatus: 'valid',
    credentialMessage: null,
    success: true,
    tiers,
    error: null,
    queriedAt: nowMs(),
  }
}

// ── Quota-bridge snapshot (opencode + grok) ──────────────────────────────────
// The dashboard process cannot read the vendor credentials that live next to
// the vendor CLIs (and Grok's vendor quota endpoint needs token refresh), so
// a scheduled task polls `quota-axi --json` and writes a compact, secret-free
// snapshot to <AIUSAGE_DIR>/quota-bridge.json. These providers only read that
// snapshot — they never call a vendor quota API.
//
// Snapshot shape (written by refreshQuotaBridge in ./commands/quota-bridge.js,
// never by this file):
//   { bridgeVersion, updatedAt: <ms epoch>,
//     providers: { [providerKey]: { windows?: [{ id, label, kind,
//       percentRemaining, resetsAt }], error?: string } } }

/** Bridge snapshot path, shared with the quota-bridge writer command. */
export const QUOTA_BRIDGE_PATH = join(AIUSAGE_DIR, 'quota-bridge.json')

interface BridgeWindow {
  id?: unknown
  label?: unknown
  kind?: unknown
  percentRemaining?: unknown
  resetsAt?: unknown
  pace?: unknown
}

interface BridgeProviderEntry {
  windows?: unknown
  error?: unknown
}

interface BridgeSnapshot {
  updatedAt?: unknown
  providers: Record<string, BridgeProviderEntry>
}

interface RawPace {
  status?: unknown
  reason?: unknown
  reservePercentPoints?: unknown
  burnMultiple?: unknown
  derived?: unknown
  suppressed?: unknown
}

function readQuotaBridgeSnapshot(): BridgeSnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(QUOTA_BRIDGE_PATH, 'utf-8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const providers = (parsed as Record<string, unknown>)['providers']
  if (!providers || typeof providers !== 'object') return null
  return parsed as BridgeSnapshot
}

// quota-axi pace semantics: reservePercentPoints = percentRemaining minus the
// time-linear target remaining, so positive reserve means usage is UNDER the
// target line (burning slower than the clock - good) and negative means OVER
// it (burning faster - bad). quota-axi's own pace.status ("ahead"/"behind")
// describes consumption pace and reads backwards at a glance, so the panel
// never shows those words; the line and bar marker use target-line terms.
export function paceForWindow(rawPace: unknown, utilization: number): QuotaPace {
  if (!rawPace || typeof rawPace !== 'object') return { state: 'unknown', line: 'no pace target' }
  const pace = rawPace as RawPace
  // Rolling-style windows (kind=unknown - unknowable length, and usage ages
  // out continuously instead of resetting as a block) are structurally
  // impossible to give a linear target, so the bridge marks them suppressed
  // and their row renders no pace line at all. This is a deliberate narrowing
  // of the "never silent" rule for this one case, not an omission; every
  // other no-pace window keeps its note.
  if (pace.suppressed === true) {
    return { state: 'hidden', line: '' }
  }
  const reserve = typeof pace.reservePercentPoints === 'number' && Number.isFinite(pace.reservePercentPoints)
    ? pace.reservePercentPoints
    : null
  if (reserve == null) {
    const reasons: Record<string, string> = {
      missing_cycle: 'cycle unknown',
      future_cycle_start: 'cycle not started',
      missing_usage: 'usage unknown',
      stale: 'data stale',
      expired_reset: 'reset expired',
      invalid_cycle: 'cycle invalid',
      unsupported_period: 'period unsupported',
    }
    const why = typeof pace.reason === 'string' && reasons[pace.reason] ? ` (${reasons[pace.reason]})` : ''
    return { state: 'unknown', line: `no pace target${why}` }
  }
  const overPoints = -reserve
  const targetUsagePercent = Math.max(0, Math.min(100, utilization + reserve))
  const burn = typeof pace.burnMultiple === 'number' && Number.isFinite(pace.burnMultiple) ? pace.burnMultiple : null
  const burnNote = burn != null ? ` · burn ${Math.round(burn * 100) / 100}×` : ''
  // derived=true marks the bridge's gap-fill pace (nominal window length);
  // it is always labelled "approx" and its bar marker dimmed, so an inferred
  // target is never mistaken for quota-axi's measured one.
  const approxNote = pace.derived === true ? ' · approx' : ''
  const derivedFlag = pace.derived === true
  if (pace.status === 'on_pace' || Math.abs(overPoints) <= 1) {
    return { state: 'on', targetUsagePercent, line: `✓ on target${burnNote}${approxNote}`, reservePercentPoints: reserve, burnMultiple: burn, derived: derivedFlag }
  }
  const magnitude = Math.abs(overPoints) >= 10 ? `${Math.round(Math.abs(overPoints))}` : (Math.round(Math.abs(overPoints) * 10) / 10).toFixed(1)
  return overPoints > 0
    ? { state: 'over', targetUsagePercent, line: `▲ ${magnitude} pts over target${burnNote}${approxNote}`, reservePercentPoints: reserve, burnMultiple: burn, derived: derivedFlag }
    : { state: 'under', targetUsagePercent, line: `▼ ${magnitude} pts under target${burnNote}${approxNote}`, reservePercentPoints: reserve, burnMultiple: burn, derived: derivedFlag }
}

// Dashboard tier name -> quota-axi window kind, used only to MATCH a bridge
// window to an existing panel row; the rendered window set is whatever the
// provider actually reports, never this map.
const PACE_TIER_KINDS: Record<string, string> = {
  five_hour: 'session',
  seven_day: 'weekly',
  seven_day_opus: 'weekly',
  seven_day_sonnet: 'weekly',
  seven_day_omelette: 'weekly',
  weekly_limit: 'weekly',
}

function bridgeWindowLabel(w: BridgeWindow): string {
  return typeof w.label === 'string' && w.label.trim() ? w.label.trim() : `${w.id ?? 'window'}`
}

/** Merge bridge pace targets onto an existing vendor quota result (claude/codex). */
export function mergeBridgePace(result: QuotaResult, providerKey: string): QuotaResult {
  if (!result || typeof result !== 'object') return result
  if (result.success !== true || !Array.isArray(result.tiers)) return result
  const bridge = readQuotaBridgeSnapshot()
  const entry = bridge ? bridge.providers[providerKey] : null
  const windows = entry && Array.isArray(entry.windows) ? (entry.windows as BridgeWindow[]) : []
  const matched = new Set<BridgeWindow>()
  for (const tier of result.tiers) {
    if (!tier || typeof tier !== 'object' || tier.pace) continue
    const utilization = typeof tier.utilization === 'number' && Number.isFinite(tier.utilization) ? tier.utilization : null
    if (utilization == null) continue
    const byId = windows.filter((w) => w && w.id === tier.name)
    const kind = PACE_TIER_KINDS[tier.name]
    const byKind = kind ? windows.filter((w) => w && w.kind === kind) : []
    const match = byId.length === 1 ? byId[0] : byKind.length === 1 ? byKind[0] : null
    if (match) {
      matched.add(match)
      tier.pace = paceForWindow(match.pace, utilization)
    } else {
      tier.pace = { state: 'unknown', line: 'no pace target' }
    }
  }
  for (const w of windows) {
    if (!w || typeof w !== 'object' || matched.has(w)) continue
    const remaining = typeof w.percentRemaining === 'number' && Number.isFinite(w.percentRemaining) ? w.percentRemaining : null
    if (remaining == null) continue
    const utilization = Math.max(0, Math.min(100, 100 - remaining))
    result.tiers.push({
      name: bridgeWindowLabel(w),
      utilization,
      resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
      pace: paceForWindow(w.pace, utilization),
    })
  }
  return result
}

function bridgeWindowToTier(w: BridgeWindow): QuotaTier | null {
  if (!w || typeof w !== 'object') return null
  const remaining = typeof w.percentRemaining === 'number' && Number.isFinite(w.percentRemaining)
    ? w.percentRemaining
    : null
  if (remaining == null) return null
  const utilization = Math.max(0, Math.min(100, 100 - remaining))
  const tier: QuotaTier = {
    name: bridgeWindowLabel(w),
    utilization,
    resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
  }
  tier.pace = paceForWindow(w.pace, utilization)
  return tier
}

async function queryBridgeQuota(tool: string, providerKey: string): Promise<QuotaResult> {
  const bridge = readQuotaBridgeSnapshot()
  if (!bridge) return notFound(tool)
  const entry = bridge.providers[providerKey]
  if (!entry || typeof entry !== 'object') return notFound(tool)
  const windows = Array.isArray(entry.windows) ? entry.windows : []
  const tiers = (windows as BridgeWindow[]).map(bridgeWindowToTier).filter((t): t is QuotaTier => t !== null)
  if (tiers.length === 0) {
    return apiError(tool, entry.error ? String(entry.error) : 'quota-bridge snapshot returned no quota windows')
  }
  return {
    tool,
    credentialStatus: 'valid',
    credentialMessage: null,
    success: true,
    tiers,
    error: null,
    queriedAt: typeof bridge.updatedAt === 'number' && Number.isFinite(bridge.updatedAt) ? bridge.updatedAt : nowMs(),
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Query Claude Code official subscription quota */
export async function queryClaudeCodeQuota(): Promise<QuotaResult> {
  const cred = readClaudeCredentials()

  if (cred.status === 'not_found') return notFound('claude-code')
  if (cred.status === 'parse_error') return parseError('claude-code', cred.message ?? 'Failed to parse credentials')

  if (cred.status === 'expired') {
    // Try anyway — token might still work
    if (cred.token) {
      const result = await queryClaudeQuota(cred.token)
      if (result.success) return result
    }
    return expiredError('claude-code', cred.message ?? 'OAuth token has expired')
  }

  return queryClaudeQuota(cred.token!)
}

/** Query Codex official subscription quota */
export async function queryCodexQuota(): Promise<QuotaResult> {
  const cred = readCodexCredentials()

  if (cred.status === 'not_found') return notFound('codex')
  if (cred.status === 'parse_error') return parseError('codex', cred.message ?? 'Failed to parse credentials')

  if (cred.status === 'expired') {
    if (cred.token) {
      const result = await callCodexQuotaApi(cred.token, cred.accountId)
      if (result.success) return result
    }
    return expiredError('codex', cred.message ?? 'Codex OAuth token may be stale')
  }

  return callCodexQuotaApi(cred.token!, cred.accountId)
}

/** Query GitHub Copilot official subscription quota */
export async function queryCopilotQuota(): Promise<QuotaResult> {
  const token = readCopilotOauthToken()
  if (!token) return notFound('copilot')
  return callCopilotQuotaApi(token)
}

/** Query Gemini (Antigravity) official subscription quota via the agy CLI */
export async function queryGeminiQuota(): Promise<QuotaResult> {
  const cred = readGeminiCredentials()
  if (cred.status === 'not_found') return notFound('gemini', cred.message)
  return queryAgyQuota(cred.bin ?? 'agy')
}

/** Query OpenCode official subscription quota via the quota-bridge snapshot */
export async function queryOpencodeBridgeQuota(): Promise<QuotaResult> {
  return queryBridgeQuota('opencode', 'opencode-go')
}

/** Query Grok official subscription quota via the quota-bridge snapshot */
export async function queryGrokBridgeQuota(): Promise<QuotaResult> {
  return queryBridgeQuota('grok', 'grok')
}

/** Query all supported tools in parallel */
export async function queryAllQuotas(): Promise<QuotaResult[]> {
  const [claude, codex, copilot, gemini, opencode, grok] = await Promise.all([
    queryClaudeCodeQuota(),
    queryCodexQuota(),
    queryCopilotQuota(),
    queryGeminiQuota(),
    queryOpencodeBridgeQuota(),
    queryGrokBridgeQuota(),
  ])
  mergeBridgePace(claude, 'claude')
  mergeBridgePace(codex, 'codex')
  return [claude, codex, copilot, gemini, opencode, grok]
}
