// dsh-timer job spec validation: directory load and timer add share this single matrix
// (one source of truth). Any failing row → the whole spec is rejected (no last-good).
// neverMatch cron values are not rejected, only flagged.
// The success branch returns the original validated object; the scheduler's rescan hot-update
// comparison is order-independent (util.canonicalJson), so the file key order is not
// load-bearing for change detection.
import { CalendarCondition, assertCronPattern, parseCalendarValue } from './cron.js'
import { isValidTimeZone, systemTimeZone } from './time.js'
import type { JobSpec, ValidateResult } from './types.js'
import { isPlainObject, parseRuntimeMax, positiveSpanMs } from './util.js'

export const TOP_FIELDS = new Set([
  'enable',
  'onCalendar',
  'onActiveSec',
  'onStartupSec',
  'timeZone',
  'persistent',
  'deferReactivation',
  'runtimeMaxSec',
  'overlap',
  'run',
])
export const RUN_FIELDS = new Set(['prompt', 'cwd', 'preset', 'model', 'policy'])
export const OVERLAPS = new Set(['skip', 'stop', 'allow'])
export const POLICIES = new Set(['read-only', 'workspace-write', 'danger-full-access'])

/**
 * Validate a job spec (`unknown` input; the file-parse path and the timer add spec argument
 * share this entry point).
 *
 * @param spec job spec object (arbitrary input; structural checks are done internally).
 * @param opts.nowMs base moment (default Date.now(); used for the neverMatch check).
 * @param opts.defaultTz default timezone (default systemTimeZone(); unused when the timeZone field is set).
 * @returns ok:true → normalized scheduling parameters + calendar condition objects; ok:false → error list (whole spec rejected).
 */
export function validateJob(
  spec: unknown,
  opts: { nowMs?: number; defaultTz?: string } = {},
): ValidateResult {
  const nowMs = opts.nowMs ?? Date.now()
  const defaultTz = opts.defaultTz ?? systemTimeZone()
  const errors: string[] = []
  if (!isPlainObject(spec)) {
    return { ok: false, errors: ['spec is not an object'] }
  }
  const s = spec as Record<string, unknown>
  for (const k of Object.keys(s)) {
    if (!TOP_FIELDS.has(k)) errors.push(`unknown top-level field: ${k}`)
  }

  // ── Timezone first (naive ISO / DST gap checks / cron parsing all use the job's effective timezone) ──
  let tz = defaultTz
  if (s.timeZone !== undefined) {
    if (typeof s.timeZone !== 'string' || !isValidTimeZone(s.timeZone)) {
      errors.push(`timeZone is not a valid IANA timezone name: ${JSON.stringify(s.timeZone)}`)
    } else {
      tz = s.timeZone
    }
  }

  // ── Triggers (at least one) ──
  const calendars: InstanceType<typeof CalendarCondition>[] = []
  const seenCalValues = new Set<string>()
  // null = explicitly not using the calendar trigger (treated as absent; the missing-trigger check still applies).
  if (s.onCalendar !== undefined && s.onCalendar !== null) {
    if (!Array.isArray(s.onCalendar)) {
      errors.push('onCalendar must be an array of strings')
    } else {
      s.onCalendar.forEach((v, i) => {
        if (typeof v !== 'string' || v.trim() === '') {
          errors.push(`onCalendar[${i}]: empty string`)
          return
        }
        if (seenCalValues.has(v)) return // duplicate value = the same condition; deduplicated (behaves like a single value)
        seenCalValues.add(v)
        const parsed = parseCalendarValue(v, tz)
        if (!parsed.ok) {
          errors.push(`onCalendar[${i}]: ${parsed.error}`)
          return
        }
        if (parsed.kind === 'cron') {
          try {
            assertCronPattern(v, tz)
          } catch (e) {
            errors.push(`onCalendar[${i}]: ${(e as Error).message}`)
            return
          }
        }
        // The condition carries the job's effective timezone so cron matching fires in the job tz
        // (a job-level timeZone overrides the default timezone for every condition of the job).
        calendars.push(CalendarCondition.fromParsed(v, parsed, tz))
      })
    }
  }
  const onUnitActiveSecMs = positiveSpanMs(s.onActiveSec)
  const onStartupSecMs = positiveSpanMs(s.onStartupSec)
  if (s.onActiveSec != null && onUnitActiveSecMs === null) {
    errors.push('onActiveSec must be a positive time span (e.g. 30s / 5min / 1h30min; "0" is invalid)')
  }
  if (s.onStartupSec != null && onStartupSecMs === null) {
    errors.push('onStartupSec must be a positive time span (e.g. 30s / 5min / 1h30min; "0" is invalid)')
  }
  if (calendars.length === 0 && onUnitActiveSecMs === null && onStartupSecMs === null) {
    errors.push('missing trigger: at least one of onCalendar / onActiveSec / onStartupSec is required')
  }

  // ── Booleans / run parameters (timezone already resolved before triggers) ──
  if (s.enable !== undefined && typeof s.enable !== 'boolean') {
    errors.push('enable must be a boolean')
  }
  if (s.persistent !== undefined && typeof s.persistent !== 'boolean') {
    errors.push('persistent must be a boolean')
  }
  // deferReactivation: accepted as a boolean; on jobs without any onCalendar condition the
  // value is ignored (monotonic re-arm never references defer — aligned with systemd:
  // "effect only if a realtime timer has been specified").
  if (s.deferReactivation !== undefined && typeof s.deferReactivation !== 'boolean') {
    errors.push('deferReactivation must be a boolean')
  }
  if (s.runtimeMaxSec !== undefined) {
    const ms = parseRuntimeMax(s.runtimeMaxSec)
    if (ms === undefined) {
      errors.push(`runtimeMaxSec invalid: ${JSON.stringify(s.runtimeMaxSec)} (must be "0" / "infinity" / a positive time span)`)
    }
  }
  if (s.overlap !== undefined && !OVERLAPS.has(String(s.overlap))) {
    errors.push(`overlap invalid: ${JSON.stringify(s.overlap)} (allowed: skip/stop/allow)`)
  }

  // ── run block (must exist; prompt required and non-empty) ──
  let run: Record<string, unknown> | null = null
  if (s.run === undefined) {
    errors.push('missing run block (prompt is required)')
  } else if (!isPlainObject(s.run)) {
    errors.push('run must be an object')
  } else {
    run = s.run as Record<string, unknown>
    for (const k of Object.keys(run)) {
      if (!RUN_FIELDS.has(k)) errors.push(`unknown field in run: ${k}`)
    }
    if (typeof run.prompt !== 'string' || run.prompt.trim() === '') {
      errors.push('run.prompt is required and must be non-empty (a whitespace-only prompt is rejected)')
    }
    // run.cwd / run.preset / run.model: undefined or null = unset (explicit null is accepted
    // and means the same as omitting the field); any string — including the empty string —
    // is accepted (structural validation only; the effect is resolved at run time).
    for (const k of ['cwd', 'preset', 'model']) {
      const v = run[k]
      if (v !== undefined && v !== null && typeof v !== 'string') {
        errors.push(`run.${k} must be a string or null`)
      }
    }
    if (run.policy !== undefined && run.policy !== null && !POLICIES.has(String(run.policy))) {
      errors.push(`run.policy invalid: ${JSON.stringify(run.policy)} (allowed: read-only/workspace-write/danger-full-access)`)
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  // ── neverMatch flagging (accepted and flagged, not rejected) ──
  const neverMatch: string[] = []
  for (const cal of calendars) {
    if (cal.isNeverMatch(nowMs)) neverMatch.push(cal.value)
  }

  return {
    ok: true,
    errors: [],
    // Original validated object (structural checks passed, typed as JobSpec; key order kept as in the file).
    spec: s as unknown as JobSpec,
    tz,
    persistent: s.persistent === true,
    defer: s.deferReactivation === true,
    overlap: (s.overlap as 'skip' | 'stop' | 'allow' | undefined) ?? 'skip',
    runtimeMaxMs: parseRuntimeMax(s.runtimeMaxSec) ?? null,
    onUnitActiveSecMs,
    onStartupSecMs,
    calendars,
    neverMatch,
  }
}
