/**
 * dsh-timer calendar conditions (onCalendar values): cron expressions (strict 5/6 fields)
 * or full ISO datetimes (one-shot).
 *
 * Cron parsing is delegated to croner in mode '5-or-6-parts' (4/7-field patterns and
 * out-of-range values are rejected). neverMatch detection = croner exhaustive search
 * (nextRun() === null after its exhaustive Gregorian sweep — this mode has no year field,
 * so the sweep is capped at AD 3000 by croner 10.0.1).
 */
import { Cron, CronPattern } from 'croner'
import { wallToMs } from './time.js'
import type { WallParts } from './time.js'

const ISO_ZONED_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const ISO_NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/

/** Parse result of a calendar value (return type of {@link parseCalendarValue}, discriminated). */
export type CalendarParsed =
  | { ok: true; kind: 'iso'; instantMs: number; wallParts: WallParts | null }
  | { ok: false; kind: 'iso'; error: string }
  | { ok: true; kind: 'cron' }

/**
 * Static parse: classify the value as cron or ISO; ISO additionally precomputes instantMs
 * (a naive ISO is resolved against tz and carries its wall components for timezone-change
 * re-resolution; a DST gap is an error).
 * @param value element of the onCalendar array.
 * @param tz job timezone (IANA name).
 * @returns parse result; a naive ISO inside a DST gap → { ok:false, error }.
 */
export function parseCalendarValue(value: string, tz: string): CalendarParsed {
  const z = ISO_ZONED_RE.exec(value)
  if (z) {
    const parsedUtc = Date.UTC(+z[1], +z[2] - 1, +z[3], +z[4], +z[5], +z[6])
    // Offset shaped as ±HH:MM → hours = first 2 digits, minutes = last 2 digits (sign applies to the whole offset)
    const off = z[7] === 'Z' ? 0 : ((+(z[7].slice(1, 3)) * 3_600_000) + (+(z[7].slice(4, 6)) * 60_000)) * (z[7][0] === '-' ? -1 : 1)
    // A zoned ISO carries its own offset: the absolute instant is intrinsic and never
    // depends on any timezone → no wall components are stored.
    return { ok: true, kind: 'iso', instantMs: parsedUtc - off, wallParts: null }
  }
  const n = ISO_NAIVE_RE.exec(value)
  if (n) {
    const parts: WallParts = {
      year: +n[1], month: +n[2], day: +n[3], hour: +n[4], minute: +n[5], second: +n[6],
    }
    const instantMs = wallToMs(parts, tz)
    if (instantMs === null) return { ok: false, kind: 'iso', error: `does not exist in timezone ${tz} (DST gap)` }
    // Wall components are stored so a later system timezone change can re-resolve the
    // same wall time under the new zone (systemd OnTimezoneChange=false semantics).
    return { ok: true, kind: 'iso', instantMs, wallParts: parts }
  }
  // Treat as cron; field count / value legality is validated by the caller via CronPattern (mode 5-or-6-parts)
  return { ok: true, kind: 'cron' }
}

/**
 * Strict cron validation (constructs a pattern, throws on invalid input).
 * @param pattern cron expression.
 * @param tz IANA timezone name.
 */
export function assertCronPattern(pattern: string, tz: string): void {
  new CronPattern(pattern, tz, { mode: '5-or-6-parts' })
}

/** Calendar condition: a cron expression or a one-shot ISO instant (one onCalendar element). */
export class CalendarCondition {
  /** Raw value (cron expression or ISO string). */
  value: string
  /** Condition kind (filled in by fromParsed). */
  kind: 'cron' | 'iso' | null = null
  /** Job timezone (IANA name). */
  tz: string
  /** Cron expression (equals value when kind='cron'). */
  pattern: string | null = null
  /** ISO absolute moment (ms; non-null when kind='iso'). Kept in sync when a system timezone
   * change re-resolves a naive-ISO condition under the new zone. */
  instantMs: number | null = null
  /** Wall-clock components of a naive-ISO value (non-null only for naive ISO); null for cron
   * and zoned-ISO conditions (a zoned offset is intrinsic → unaffected by system timezone
   * changes). Stored so recomputeTzChange can re-resolve the wall time under the new zone. */
  wallParts: WallParts | null = null
  /** Cached Cron instance. */
  private _cron: Cron | null = null
  /** Timezone the cached _cron was built for. */
  private _cronTz: string | null = null

  constructor(value: string, tz: string) {
    this.value = value
    this.tz = tz
  }

  /**
   * Build from a parseCalendarValue result (the caller guarantees ok).
   * @param value raw value.
   * @param parsed parse result (kind='cron', or kind='iso' with ok).
   * @param tz job timezone.
   */
  static fromParsed(value: string, parsed: CalendarParsed, tz: string): CalendarCondition {
    const c = new CalendarCondition(value, tz)
    if (parsed.ok && parsed.kind === 'iso') {
      c.kind = 'iso'
      c.instantMs = parsed.instantMs
      c.wallParts = parsed.wallParts
    } else if (parsed.ok) {
      c.kind = 'cron'
      c.pattern = value
    }
    return c
  }

  /**
   * Get (rebuilding if necessary) the Cron instance for tz.
   * @param tz timezone; rebuilt when it differs from the cached one.
   */
  ensureCron(tz: string): Cron {
    if (this._cron === null || this._cronTz !== tz) {
      // Only called for kind='cron' conditions (guarded by the caller); fromParsed guarantees pattern is non-null.
      if (this.pattern === null) throw new Error(`ensureCron: called for a non-cron condition (value=${this.value})`)
      this._cron = new Cron(this.pattern, { timezone: tz, mode: '5-or-6-parts' })
      this._cronTz = tz
    }
    return this._cron
  }

  /**
   * Next match strictly after fromMs.
   * cron: croner finds no solution after exhaustive search → null (= neverMatch);
   * ISO: the instant when it is >= fromMs, otherwise null.
   * @param fromMs base moment (ms).
   * @returns next match moment (ms); null when there is no future match.
   */
  nextMatch(fromMs: number): number | null {
    if (this.kind === 'iso') {
      return this.instantMs !== null && this.instantMs >= fromMs ? this.instantMs : null
    }
    const d = this.ensureCron(this.tz).nextRun(new Date(fromMs))
    return d ? d.getTime() : null
  }

  /**
   * Whether the condition never fires on its own (only meaningful for cron:
   * croner's exhaustive sweep (yearless patterns capped at AD 3000) yields nextRun() = null).
   * @param fromMs base moment (ms).
   */
  isNeverMatch(fromMs: number): boolean {
    if (this.kind !== 'cron') return false
    return this.nextMatch(fromMs) === null
  }
}
