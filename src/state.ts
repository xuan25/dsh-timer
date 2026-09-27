/**
 * dsh-timer state file model. Pure Node dependencies; safe to import from selftest.
 *
 * Layout: `<jobsDir>/state/<jobId>.json`
 *   { schemaVersion: 1, jobId, lastActivationMs, lastTriggerMs,
 *     calendars: { [value]: { value, kind, neverMatch, consumed, nextFireMs } },
 *     runs: [...] (FIFO, <= 50) }
 * No missed-fire persistence: the job-level lastTriggerMs = the last on-calendar elapse
 * moment (a fired trigger or a due trigger consumed by an overlap=skip — the recompute
 * anchor, systemd's one shared last trigger moment per unit); the operator derives any
 * missed interval from that moment, the next trigger time, and the current time.
 * State files may carry unknown extra keys (e.g. keys added by an older plugin version): they are
 * tolerated on load (not corrupt), normalized away, and never written back.
 * Monotonic quantities (onActiveSec/onStartupSec) are not persisted: they are derived
 * from lastActivationMs and the process start time.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { errMsg, isPlainObject } from './util.js'

/** State file schema version. */
export const STATE_SCHEMA_VERSION = 1
/** Run audit cap (FIFO). */
export const RUNS_LIMIT = 50
/** Summary truncation cap (characters). */
export const SUMMARY_LIMIT = 2000
/** Keys the plugin writes at each level of the state file (the state schema contract). */
export const STATE_TOP_KEYS = new Set<string>(['schemaVersion', 'jobId', 'lastActivationMs', 'lastTriggerMs', 'calendars', 'runs'])
export const CALENDAR_KEYS = new Set<string>(['value', 'kind', 'neverMatch', 'consumed', 'nextFireMs'])
export const RUN_KEYS = new Set<string>(['runId', 'sessionId', 'trigger', 'startedAt', 'finishedAt', 'durationMs', 'status', 'cause', 'summary', 'error'])

/**
 * Single run audit record (element of state.runs).
 * In-flight records carry explicit nulls for the fields other than startedAt
 * (JSON serialization keeps null keys); after settlement, updateRun patches them to final values.
 */
export interface StateRun {
  runId: string
  jobId?: string
  sessionId?: string
  trigger?: string
  startedAt: number
  finishedAt: number | null
  durationMs: number | null
  status: string
  cause?: string | null
  pendingCause?: string | null
  followupError?: string | null
  summary?: string | null
  error?: string | null
  settled?: boolean
  [key: string]: unknown
}

/** Calendar condition state (value of state.calendars). */
export interface StateCalendar {
  value: string
  /** Condition kind ('cron' | 'iso'; effectively never null, kept nullable to match the on-disk write shape). */
  kind: string | null
  neverMatch: boolean
  consumed: boolean
  nextFireMs: number | null
  [key: string]: unknown
}

/** Job state file object. */
export interface JobState {
  schemaVersion: number
  jobId: string
  lastActivationMs: number | null
  lastTriggerMs: number | null
  calendars: Record<string, StateCalendar>
  runs: StateRun[]
}

/**
 * The state directory under the jobs directory (per-job state files live here, one
 * `<jobId>.json` each; a best-effort mirror — creating it is a scheduler concern).
 * @param jobsDir jobs directory.
 */
export function stateDirFor(jobsDir: string): string {
  return path.join(jobsDir, 'state')
}

/**
 * State file path.
 * @param jobsDir jobs directory.
 * @param jobId job id.
 */
export function stateFileFor(jobsDir: string, jobId: string): string {
  return path.join(stateDirFor(jobsDir), `${jobId}.json`)
}

/**
 * Job spec file path.
 * @param jobsDir jobs directory.
 * @param jobId job id.
 */
export function jobFileFor(jobsDir: string, jobId: string): string {
  return path.join(jobsDir, `${jobId}.json`)
}

/**
 * Create an empty state.
 * @param jobId job id.
 */
export function freshState(jobId: string): JobState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    jobId,
    lastActivationMs: null,
    lastTriggerMs: null,
    calendars: {},
    runs: [],
  }
}

/**
 * Full-shape check: true when the object is a valid state; false otherwise
 * (the caller treats false as "corrupt → reset in enabled jobs / keep in-memory state in
 * disabled jobs").
 *
 * Validated per field:
 * - top level: schemaVersion (=== STATE_SCHEMA_VERSION), jobId (string),
 *   lastActivationMs (number | null), lastTriggerMs (number | null; absent = no persisted
 *   anchor, tolerated for files written by older versions), calendars (plain object),
 *   runs (array);
 * - each calendars entry: value (string), kind (string | null), neverMatch (boolean),
 *   consumed (boolean), nextFireMs (number | null);
 * - each runs entry: runId (string), startedAt (number), status (string) are required;
 *   when present, sessionId (string | null), trigger (string), cause / error (string | null),
 *   finishedAt / durationMs (number | null), summary (string | null).
 *
 * In-flight records carry explicit nulls for cause / finishedAt / durationMs / summary;
 * settled records fill them on settlement. Records evicted by the FIFO before settlement
 * are re-appended with only { runId, ...patch }, so the optional fields may be absent.
 * Unknown extra keys (e.g. keys added by an older plugin version) are TOLERATED — not corrupt;
 * loadState normalizes them away.
 * @param s arbitrary value (a JSON.parse product).
 */
export function checkStateShape(s: unknown): s is JobState {
  if (!isPlainObject(s)) return false
  const o = s
  if (o.schemaVersion !== STATE_SCHEMA_VERSION) return false
  if (typeof o.jobId !== 'string') return false
  if (o.lastActivationMs !== null && typeof o.lastActivationMs !== 'number') return false
  if (o.lastTriggerMs !== undefined && o.lastTriggerMs !== null && typeof o.lastTriggerMs !== 'number') return false
  if (!isPlainObject(o.calendars)) return false
  for (const v of Object.values(o.calendars)) {
    if (!isPlainObject(v)) return false
    if (typeof v.value !== 'string') return false
    if (v.kind !== null && typeof v.kind !== 'string') return false
    if (typeof v.neverMatch !== 'boolean') return false
    if (typeof v.consumed !== 'boolean') return false
    if (v.nextFireMs !== null && typeof v.nextFireMs !== 'number') return false
  }
  if (!Array.isArray(o.runs)) return false
  for (const r of o.runs) {
    if (!isPlainObject(r)) return false
    if (typeof r.runId !== 'string') return false
    if (typeof r.startedAt !== 'number') return false
    if (typeof r.status !== 'string') return false
    if (r.sessionId !== undefined && r.sessionId !== null && typeof r.sessionId !== 'string') return false
    if (r.trigger !== undefined && typeof r.trigger !== 'string') return false
    if (r.cause !== undefined && r.cause !== null && typeof r.cause !== 'string') return false
    if (r.finishedAt !== undefined && r.finishedAt !== null && typeof r.finishedAt !== 'number') return false
    if (r.durationMs !== undefined && r.durationMs !== null && typeof r.durationMs !== 'number') return false
    if (r.summary !== undefined && r.summary !== null && typeof r.summary !== 'string') return false
    if (r.error !== undefined && r.error !== null && typeof r.error !== 'string') return false
  }
  return true
}

/**
 * Strip unknown extra keys at every level (top level, calendar entries, run records), keeping
 * exactly the keys the plugin writes. Callers treat unknown keys as tolerated (not corrupt),
 * so this runs on a state that already passed checkStateShape; after it, no unknown key
 * survives into the in-memory state and therefore is never written back to the file.
 * @param state the loaded job state (mutated in place).
 */
function stripUnknown(target: object, keys: Set<string>): void {
  for (const key of Object.keys(target)) if (!keys.has(key)) delete (target as Record<string, unknown>)[key]
}

export function normalizeState(state: JobState): void {
  stripUnknown(state, STATE_TOP_KEYS)
  if (!Object.hasOwn(state, 'lastTriggerMs')) state.lastTriggerMs = null // legacy files without the job-level anchor: no anchor
  for (const cal of Object.values(state.calendars)) stripUnknown(cal, CALENDAR_KEYS)
  for (const run of state.runs) stripUnknown(run, RUN_KEYS)
}

/** loadState return value. */
export interface StateLoadResult {
  state: JobState | null
  corrupt: boolean
  error?: string
}

/**
 * Read a state file.
 * @param file state file path.
 * @returns file missing → { state: null, corrupt: false } (first load; the caller builds a fresh state);
 *   unreadable / not JSON / wrong shape → { state: null, corrupt: true }.
 */
export async function loadState(file: string): Promise<StateLoadResult> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { state: null, corrupt: false }
    return { state: null, corrupt: true, error: errMsg(err) }
  }
  try {
    const s = JSON.parse(text) as JobState
    if (!checkStateShape(s)) return { state: null, corrupt: true, error: 'shape mismatch (full shape validation)' }
    normalizeState(s) // unknown extra keys (e.g. keys added by an older plugin version): tolerate on load, strip, never write back
    return { state: s, corrupt: false }
  } catch (err) {
    return { state: null, corrupt: true, error: errMsg(err) }
  }
}

/**
 * Append a run and keep the FIFO at <= 50 entries.
 * @param state job state.
 * @param record run record.
 */
export function pushRun(state: JobState, record: StateRun): void {
  state.runs.push(record)
  while (state.runs.length > RUNS_LIMIT) state.runs.shift()
}

/**
 * Update a run record in place by runId; if the record was already evicted by the FIFO,
 * a completed-state record is appended instead (so the latest result is never lost).
 * @param state job state.
 * @param runId target run id.
 * @param patch fields to update (status/cause/finishedAt/durationMs/summary/error, etc.).
 */
export function updateRun(state: JobState, runId: string, patch: Partial<StateRun>): void {
  const rec = state.runs.find((r) => r && r.runId === runId)
  if (rec) {
    Object.assign(rec, patch)
  } else {
    pushRun(state, { runId, ...patch } as StateRun)
  }
}

/**
 * Truncate a summary to SUMMARY_LIMIT characters.
 * @param text arbitrary value (non-string → '').
 */
export function truncateSummary(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text.length > SUMMARY_LIMIT ? text.slice(0, SUMMARY_LIMIT) : text
}
