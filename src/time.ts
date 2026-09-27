/**
 * dsh-timer time utilities: IANA timezone validation, wall-clock <-> epoch-ms conversion
 * (DST-gap-safe offset solving), and /etc/localtime mtime change detection.
 *
 * Pure Node dependencies, no framework packages.
 */
import { readlinkSync, readFileSync, statSync } from 'node:fs'

/** Cache of validated IANA timezone names. */
const VALID_TZ_CACHE = new Map<string, boolean>()

/**
 * Validate an IANA timezone name (charset check + Intl probe, cached).
 * @param tz candidate timezone name.
 * @returns true when the name is a valid IANA zone.
 */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false
  if (!/^[A-Za-z0-9._+\-/]+$/.test(tz)) return false
  const cached = VALID_TZ_CACHE.get(tz)
  if (cached !== undefined) return cached
  let ok = false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    ok = true
  } catch { /* invalid timezone name */ }
  VALID_TZ_CACHE.set(tz, ok)
  return ok
}

/**
 * The process system timezone (determined from the TZ env var or /etc/localtime,
 * fixed when the Node process starts).
 * @returns timezone name; 'UTC' when it cannot be resolved.
 */
export function systemTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return typeof zone === 'string' && zone.length > 0 ? zone : 'UTC'
}

/** Wall-clock components. */
export interface WallParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function wallPartsOf(ms: number, tz: string): WallParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const out: WallParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 }
  for (const p of dtf.formatToParts(new Date(ms))) {
    switch (p.type) {
      case 'year': out.year = Number(p.value); break
      case 'month': out.month = Number(p.value); break
      case 'day': out.day = Number(p.value); break
      case 'hour': out.hour = p.value === '24' ? 0 : Number(p.value); break
      case 'minute': out.minute = Number(p.value); break
      case 'second': out.second = Number(p.value); break
    }
  }
  return out
}

/**
 * UTC offset (ms, second resolution) of a moment in the given timezone.
 * @param dateMs absolute moment (ms).
 * @param tz IANA timezone name.
 */
export function tzOffsetMs(dateMs: number, tz: string): number {
  const parts = wallPartsOf(dateMs, tz)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - Math.floor(dateMs / 1000) * 1000
}

/**
 * Wall-clock components of a moment in the given timezone.
 * @param ms absolute moment (ms).
 * @param tz IANA timezone name.
 */
export function wallParts(ms: number, tz: string): WallParts {
  return wallPartsOf(ms, tz)
}

/**
 * Convert wall-clock components to an absolute moment (ms) via iterative offset solving
 * (converges in <=3 iterations). A wall time inside a DST gap (no such local time exists)
 * returns null: no skip/deferral rule is applied.
 * @param parts wall-clock components.
 * @param tz IANA timezone name.
 * @returns absolute moment (ms); null for gap times or non-convergence.
 */
export function wallToMs(parts: WallParts, tz: string): number | null {
  const base = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  let offset = tzOffsetMs(base, tz)
  for (let i = 0; i < 3; i++) {
    const candidate = base - offset
    const off = tzOffsetMs(candidate, tz)
    if (off === offset) {
      const back = wallPartsOf(candidate, tz)
      if (back.year !== parts.year || back.month !== parts.month || back.day !== parts.day ||
          back.hour !== parts.hour || back.minute !== parts.minute || back.second !== parts.second) {
        return null // gap time: the decoded wall time does not round-trip
      }
      return candidate
    }
    offset = off
  }
  return null
}

/**
 * Format a moment as wall clock for status display: "YYYY-MM-DD HH:MM:SS (Asia/Shanghai)".
 * @param ms absolute moment (ms).
 * @param tz IANA timezone name.
 * @param withSeconds include seconds (default true).
 */
export function formatWall(ms: number, tz: string, withSeconds = true): string {
  const p = wallPartsOf(ms, tz)
  const f = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${f(p.month)}-${f(p.day)} ${f(p.hour)}:${f(p.minute)}${withSeconds ? ':' + f(p.second) : ''} (${tz})`
}

function isTzNameByte(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) ||
    b === 0x2d || b === 0x2e || b === 0x5f || b === 0x2b || b === 0x2f
}

/** Result of decoding the system timezone. */
export interface SystemTimeZoneDecoded {
  tz: string | null
  source: 'symlink' | 'scanned' | null
}

/**
 * Decode the current system timezone from /etc/localtime:
 * symlink → the path segments after zoneinfo/ (e.g. /usr/share/zoneinfo/Asia/Shanghai → Asia/Shanghai);
 * regular file → scan the tzdata binary for candidate identifiers (heuristic; the longest
 * valid IANA name wins).
 * @returns decoded result; { tz: null, source: null } when unreadable or no candidate found.
 */
export function decodeSystemTimeZoneFromLocaltime(): SystemTimeZoneDecoded {
  try {
    const link = readlinkSync('/etc/localtime')
    const m = link.match(/zoneinfo\/?([A-Za-z0-9._+\-/]+(?:\/[A-Za-z0-9._+\-/]+)*)\/?$/i)
    if (m && m[1] && isValidTimeZone(m[1])) return { tz: m[1], source: 'symlink' }
  } catch { /* not a symlink */ }
  try {
    const buf = readFileSync('/etc/localtime').subarray(0, 256 * 1024)
    const candidates = new Set<string>()
    let i = 0
    while (i < buf.length) {
      let j = i
      while (j < buf.length && isTzNameByte(buf[j])) j++
      if (j - i >= 4) {
        const s = buf.toString('latin1', i, j)
        if (isValidTimeZone(s)) candidates.add(s)
      }
      i = Math.max(j, i + 1)
    }
    const nonUtc = [...candidates].filter((c) => c !== 'UTC')
    if (nonUtc.length > 0) return { tz: nonUtc.sort((a, b) => b.length - a.length)[0], source: 'scanned' }
    if (candidates.has('UTC')) return { tz: 'UTC', source: 'scanned' }
  } catch { /* unreadable */ }
  return { tz: null, source: null }
}

/**
 * System timezone change detector based on the mtime of /etc/localtime:
 * the first call only records a baseline and is never reported as a change; a missing
 * file is silently ignored (a TZ env var change is picked up on process restart instead).
 * @returns detector: true when /etc/localtime mtime changed since the previous call;
 * false on the first call or when the file is missing.
 */
export function makeTzChangeDetector(): () => boolean {
  let lastMtimeMs = 0
  return function detectTzChange(): boolean {
    try {
      const m = statSync('/etc/localtime').mtimeMs
      if (lastMtimeMs !== 0 && m !== lastMtimeMs) {
        lastMtimeMs = m
        return true
      }
      if (lastMtimeMs === 0) lastMtimeMs = m
    } catch { /* file unreadable: ignore */ }
    return false
  }
}
