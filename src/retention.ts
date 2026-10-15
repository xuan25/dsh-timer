// dsh-timer retention window syntax (the offload plane's config channel):
// a unit's (job) retention window is a non-negative integer number of
// milliseconds (the number form = a JSON number in the job file) or a
// duration string of one or two "digits+unit" segments (units d/h/m/s/ms)
// in strict descending order (24h, 4h30m, 90s, 5000ms). A bare numeric
// string is ambiguous and rejected; anything else (a third segment, an
// unknown unit, a separator, any stray character) is invalid.
// An invalid value never fails the job (the schema checks the type only):
// the offload plane warns and treats the window as 0 (retain, no automatic
// offload).
// Pure module (no framework imports) so the scheduler and the selftest
// share one parser.
//
// Do NOT reuse util.parseSpan here: that parser is systemd-style (multi-
// segment, whitespace-tolerant, w/M/y units, unit-less = seconds) - a
// different, looser grammar. The retention grammar is strict on purpose.

/** Milliseconds per unit (the retention grammar's five units). */
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000, ms: 1 }
/** Segment rank in the descending order (a first segment must rank lower). */
const UNIT_RANK: Record<string, number> = { d: 0, h: 1, m: 2, s: 3, ms: 4 }

/** Parse result: ok carries the window in ms; not-ok carries the reason. */
export type WindowParse = { ok: true; ms: number } | { ok: false; reason: string }

function parseWindowNumber(value: number): WindowParse {
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, reason: 'a number window must be a non-negative integer of milliseconds' }
  }
  return { ok: true, ms: value }
}

function parseWindowString(value: string): WindowParse {
  const m = /^(\d+)(ms|m|d|h|s)(\d+(ms|m|d|h|s))?$/.exec(value)
  if (!m) {
    return {
      ok: false,
      reason: 'a string window must be one or two "digits+unit" segments (units d/h/m/s/ms)',
    }
  }
  const a = Number(m[1]) * UNIT_MS[m[2]]
  if (m[3] === undefined) {
    if (!Number.isSafeInteger(a)) return { ok: false, reason: 'the window exceeds the representable range' }
    return { ok: true, ms: a }
  }
  // The design regex captures the second segment as one group (digits+unit);
  // the digits are the segment minus its unit suffix.
  if (UNIT_RANK[m[2]] >= UNIT_RANK[m[4]]) {
    return { ok: false, reason: 'the segments must be in descending unit order (d > h > m > s > ms)' }
  }
  const ms = a + Number(m[3].slice(0, m[3].length - m[4].length)) * UNIT_MS[m[4]]
  if (!Number.isSafeInteger(ms)) return { ok: false, reason: 'the window exceeds the representable range' }
  return { ok: true, ms }
}

/** Parse a retention window (number = ms, string = duration, rules above). */
export function parseWindowMs(value: number | string): WindowParse {
  return typeof value === 'number' ? parseWindowNumber(value) : parseWindowString(value)
}

/** Per-sweep offload budget default (the TIMER_OFFLOAD_BATCH knob default). */
export const DEFAULT_OFFLOAD_BATCH = 50

/**
 * Parse the TIMER_OFFLOAD_BATCH env value (the per-sweep offload budget):
 * a positive integer; absent: the default; invalid (non-integer, zero,
 * negative, non-numeric): a warning and the default (the component stays on).
 */
export function parseOffloadBatch(raw: string | undefined, warn: (m: string) => void): number {
  if (raw === undefined) return DEFAULT_OFFLOAD_BATCH
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    warn(`TIMER_OFFLOAD_BATCH=${raw} is not a positive integer; falling back to the default ${DEFAULT_OFFLOAD_BATCH}`)
    return DEFAULT_OFFLOAD_BATCH
  }
  return n
}

/**
 * Parse the TIMER_SESSION_RETENTION env value (the unit-default retention window,
 * applied to every job whose run.sessionRetention is unset: absent or null).
 * Absent: 0 (no default window, no warning); present: R6 window syntax on a
 * string (pure-number strings are invalid by design; the value must be a
 * duration like 24h); invalid: a warning and 0 (never disables the plane).
 */
export function parseUnitDefaultWindowMs(raw: string | undefined, warn: (m: string) => void): number {
  if (raw === undefined) return 0
  const parsed = parseWindowMs(raw)
  if (parsed.ok) return parsed.ms
  warn(`TIMER_SESSION_RETENTION=${raw} is not a valid retention window (a duration string like 24h or 4h30m); the unit-default window falls back to 0 (no automatic offload for jobs without an explicit run.sessionRetention)`)
  return 0
}
