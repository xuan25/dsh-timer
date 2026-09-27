/**
 * dsh-timer shared utilities: job id rules, time-span parsing, install-root resolution,
 * jobsDir resolution and availability checks, and shared low-level helpers (error
 * formatting, plain-object check, package-root resolution).
 *
 * Pure Node dependencies, no framework packages; safe to import from selftest.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Job id charset: lowercase alphanumeric start, hyphens allowed, total length 1-64. */
const JOB_ID_BODY = '[a-z0-9][a-z0-9-]{0,63}'

/** Job id charset (the filename minus its suffix). */
export const JOB_ID_RE = new RegExp(`^${JOB_ID_BODY}$`)

/** Job file name = job id plus the .json suffix (derived from the same charset as {@link JOB_ID_RE}). */
export const FILE_RE = new RegExp(`^(${JOB_ID_BODY})\\.json$`)

/** Scheduling tick period (ms). */
export const TICK_MS = 30_000

/** Backward clock-jump detection threshold (ms). */
export const CLOCK_JUMP_MS = 1_000

/** Plugin identifier (registered name, logger tag, skill provider name, run-prompt marker). */
export const PLUGIN_NAME = 'dsh-timer'

/** Options for {@link parseSpan}. */
export interface ParseSpanOptions {
  /** When true, the total duration must be > 0 ("0"/"infinity" do not qualify). */
  positive?: boolean
}

/**
 * Parse a systemd-style time span: components of `number+unit`, multiple components may
 * be concatenated ("1h30min"), optional whitespace between components ("1h 30min"), and a
 * missing unit means seconds ("30").
 * Units are case-sensitive: m=minutes, M=months.
 * Accepted units: us/usec ms/msec s/sec[ond]s m/min[ute]s h/hour[s] d/day[s] w/week[s] M/month[s] y/year[s].
 * @param value the value to parse (non-string → null).
 * @param opts positive=true requires a total duration > 0.
 * @returns duration in ms; null when unparseable, negative, or (positive && 0).
 */
export function parseSpan(value: unknown, opts: ParseSpanOptions = {}): number | null {
  const { positive = false } = opts
  if (typeof value !== 'string') return null
  const s = value.trim()
  if (s === '') return null
  // Component = digits + optional unit (missing unit = seconds); min/mins are explicit
  // alternatives so they cannot be truncated to the single-character 'm' branch, and word
  // forms precede their shorter prefixes (seconds? before sec) so a longer form is never
  // truncated by a shorter alternative ("30seconds" is not "30sec" + residual "onds").
  const SPAN_RE = /(\d+)(usec|us|msec|ms|seconds?|sec|minutes?|mins?|months?|hours?|days?|weeks?|years?|[Msmhdwy])?/y
  const UNIT_MS: Record<string, number> = {
    '': 1_000,
    us: 0.001, usec: 0.001,
    ms: 1, msec: 1,
    s: 1_000, sec: 1_000, second: 1_000, seconds: 1_000,
    m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
    h: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000,
    w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
    M: 2_592_000_000, month: 2_592_000_000, months: 2_592_000_000,
    y: 31_536_000_000, year: 31_536_000_000, years: 31_536_000_000,
  }
  let total = 0
  let pos = 0
  while (pos < s.length) {
    if (/\s/.test(s[pos])) { pos += 1; continue } // whitespace between components
    SPAN_RE.lastIndex = pos
    const m = SPAN_RE.exec(s)
    if (m === null) return null // trailing garbage that is neither digits nor whitespace
    const unit = m[2] ?? ''
    const weight = UNIT_MS[unit]
    if (weight === undefined) return null
    total += Number(m[1]) * weight
    pos = SPAN_RE.lastIndex
  }
  // The positivity check runs on the UNROUNDED total: a positive sub-millisecond span
  // (1-499us; the span grammar takes integer components, so us/usec is the only sub-ms
  // path) collapses to 0 at the integer-ms output resolution but is still a positive
  // span under the rejection criterion (only non-positive values are rejected); rounding
  // belongs to the output domain, the check to the input.
  if (positive && total <= 0) return null
  return Math.round(total)
}

/**
 * Interpret a runtimeMaxSec value: absent / null / '0' / 'infinity' = unlimited (returns null);
 * otherwise it must be a positive time span string.
 * A non-string value other than null (e.g. a JSON number) is invalid: the span grammar is a
 * string grammar, and a bare number inside a span string means seconds (systemd's default unit).
 * @param value the raw runtimeMaxSec value from the job spec.
 * @returns ms; null for absent/null/'0'/'infinity'; undefined for an invalid value (non-string, or not 0/infinity and not a positive span).
 */
export function parseRuntimeMax(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (v === '0' || v === 'infinity') return null
  const ms = parseSpan(v, { positive: true })
  return ms === null ? undefined : ms
}

/**
 * Interpret an onActiveSec / onStartupSec value: unset (undefined or null = explicitly not
 * using that trigger) → null; non-string or not a positive span (including "0") → null.
 * Sibling of {@link parseRuntimeMax}: both normalize raw *Sec field values onto
 * {@link parseSpan}; the value space differs (trigger fields reject "0"/"infinity",
 * runtimeMaxSec maps them to "no limit").
 * @param value the raw onActiveSec / onStartupSec value from the job spec.
 * @returns duration in ms; null when unset, non-string, or not a positive span.
 */
export function positiveSpanMs(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return null
  return parseSpan(value, { positive: true })
}

/** Error message extraction (catch variables are unknown under strict). */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Error shape for logs: Error takes stack (or message when absent), others String. */
export function fmtErr(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message
  return String(err)
}

/** Plain-object check: an object that is neither null nor an array. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Resolve the package root: both src/ (development) and lib/ (compiled) sit one level
 * below the package root, so '..' from this file's directory is the package root in
 * both states.
 * @returns absolute package root path.
 */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/**
 * Resolve the install root: walk up from the package directory until a directory named
 * 'node_modules' is found; its parent is the install root.
 * Bounded at 32 levels as a cycle guard.
 * @param pkgDir absolute package root path.
 * @returns absolute install root path; null when no node_modules ancestor exists (e.g. a bare dev checkout).
 */
export function getProfileDir(pkgDir: string): string | null {
  let dir = pkgDir
  for (let i = 0; i < 32; i++) {
    if (path.basename(dir) === 'node_modules') return path.dirname(dir)
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * Discover a profile directory through the framework's own conventions (the official
 * fallback when the {@link getProfileDir} walk-up finds nothing): profiles live under
 * `<dshHome>/profiles/<name>`, and the framework mints each profile's package.json name
 * as `dsh-profile-<name>` when it creates the profile (dsh-app-boot). A directory counts
 * as a candidate only when its package.json parses, names a `dsh-profile-*` profile, and
 * the name's suffix equals the directory name (a directory renamed without updating its
 * package.json no longer matches — the name contract is broken, so the caller must
 * configure jobsDir explicitly).
 * The framework does not publish which profile a running process serves (no env, no
 * service); this convention is the only on-disk encoding of the profile name, which is
 * why ambiguity (zero or multiple candidates) is reported instead of guessed.
 * @param dshHomePath the harness-home path resolver the framework provides at boot
 *   (`ctx.dshHomePath` from dsh-app-boot): `(...segments) => absolute path under the harness home`.
 * @returns the unique candidate profile directory; null when the harness home has no
 *   `profiles` root, or zero or multiple candidates (ambiguity requires an explicit jobsDir).
 */
export function discoverProfileDir(dshHomePath: (...segments: string[]) => string): string | null {
  const profilesRoot = dshHomePath('profiles')
  let entries: string[]
  try {
    entries = readdirSync(profilesRoot)
  } catch {
    return null // harness home without a profiles/ root (e.g. a bare $DSH_HOME)
  }
  const candidates: string[] = []
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue // shared module fallback tree, hidden entries
    const dir = path.join(profilesRoot, entry)
    let name: unknown
    try {
      name = (JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown }).name
    } catch {
      continue // missing or unparseable package.json → not a framework-minted profile
    }
    if (typeof name !== 'string' || !name.startsWith('dsh-profile-')) continue
    if (name.slice('dsh-profile-'.length) !== entry) continue
    candidates.push(dir)
  }
  return candidates.length === 1 ? candidates[0] : null
}

/**
 * Canonical JSON serialization for order-independent comparison: objects are serialized
 * with their keys sorted recursively (arrays keep their order, so element order is
 * significant); all other JSON.stringify semantics are preserved (same escaping, undefined
 * object values are omitted). Used by the scheduler rescan to detect a spec change: a
 * key-reordered no-op rewrite (e.g. a formatter or tool re-serialization) is NOT a change,
 * which a plain JSON.stringify comparison would misread.
 * @param value the value to serialize (plain JSON data: objects, arrays, strings, numbers, booleans, null).
 * @returns canonical string form of the value.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(obj).sort()) {
    if (typeof obj[k] === 'undefined') continue // JSON.stringify parity: undefined values are omitted
    parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * Ensure the jobs directory exists and is writable: mkdir -p plus a write probe.
 * Any failure (including not writable) throws; the caller decides between hard failure
 * (explicit candidate) and degraded mode (default candidate).
 * @param jobsDir target directory.
 */
export function ensureJobsDir(jobsDir: string): void {
  mkdirSync(jobsDir, { recursive: true })
  const probe = path.join(jobsDir, '.write-probe')
  writeFileSync(probe, 'ok')
  try { unlinkSync(probe) } catch { /* probe cleanup is best-effort */ }
}

/**
 * Resolve the job directory.
 *
 * Candidate chain, in order:
 * 1. explicit: plugin config jobsDir, then env DSH_TIMER_JOBS_DIR. An explicit candidate
 *    that is unavailable → hard failure (a directory the operator explicitly designated
 *    must fail loudly, never silently switch directories);
 * 2. default: <profileDir>/timers, where profileDir comes from the install-root walk-up
 *    ({@link getProfileDir}) or, when the walk-up finds nothing (e.g. a symlinked install
 *    outside the install tree), from the framework-convention discovery
 *    ({@link discoverProfileDir} via the dshHomePath service the framework provides at
 *    boot). A default candidate that is unavailable → warn and start degraded (the path
 *    is kept; until it becomes available again and a reload happens, job files cannot be
 *    read and state files cannot be written);
 * 3. no candidates at all (no explicit value, no install root, and the discovery absent
 *    or ambiguous: zero or multiple framework-minted profiles under the harness home) →
 *    throw (an explicit jobsDir is required — a multi-profile harness home cannot be
 *    auto-detected).
 *
 * @param pluginConfig plugin configuration ({ jobsDir? }).
 * @param logger plugin logging facade.
 * @param dshHomePath the framework-provided harness-home resolver (ctx.dshHomePath), or
 *   undefined on a host that does not provide it (discovery is then skipped).
 * @returns the job directory (possibly unavailable in degraded mode).
 */
export function resolveJobsDir(pluginConfig: { jobsDir?: string }, logger: { info(line: string): void; warn(line: string): void }, dshHomePath?: (...segments: string[]) => string): string {
  const explicit: { source: string; value: string }[] = []
  if (pluginConfig?.jobsDir) explicit.push({ source: 'plugin config jobsDir', value: pluginConfig.jobsDir })
  if (process.env.DSH_TIMER_JOBS_DIR) explicit.push({ source: 'env DSH_TIMER_JOBS_DIR', value: process.env.DSH_TIMER_JOBS_DIR })
  for (const c of explicit) {
    try {
      ensureJobsDir(c.value)
      logger.info(`jobsDir = ${c.value} (${c.source})`)
      return c.value
    } catch (err) {
      const msg = errMsg(err)
      throw new Error(`${PLUGIN_NAME} cannot initialize jobsDir (${c.source} = ${c.value}): ${msg} — an explicitly configured jobsDir is unavailable; check the directory and permissions`)
    }
  }
  let profileDir = getProfileDir(packageRoot())
  let source = 'install-root walk-up'
  if (!profileDir && dshHomePath) {
    profileDir = discoverProfileDir(dshHomePath)
    source = 'harness-home dsh-profile-* discovery'
  }
  if (profileDir) {
    const value = path.join(profileDir, 'timers')
    try {
      ensureJobsDir(value)
      logger.info(`jobsDir = ${value} (default <profileDir>/timers via ${source})`)
      return value
    } catch (err) {
      // The default candidate is unavailable → degrade instead of failing startup: keep the
      // path; until it becomes available again (and a reload happens), job files cannot be
      // read and state files cannot be written.
      const msg = errMsg(err)
      logger.warn(`default jobsDir unavailable (<profileDir>/timers via ${source}): ${msg} — starting degraded: no job loading or state persistence until the directory is fixed and reloaded`)
      return value
    }
  }
  // All candidates exhausted: no explicit value, no install root, and the harness-home
  // discovery absent or ambiguous (zero or multiple dsh-profile-* profiles under the
  // harness home; a multi-profile home cannot be auto-detected).
  const detail = dshHomePath
    ? 'no install root was found and harness-home profile discovery is ambiguous (zero or multiple dsh-profile-* profiles under the harness home)'
    : 'no install root was found and the host does not provide the dshHomePath service (profile discovery unavailable)'
  throw new Error(`${PLUGIN_NAME} cannot determine jobsDir: set the plugin config jobsDir or env DSH_TIMER_JOBS_DIR (${detail})`)
}
