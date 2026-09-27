// dsh-timer recompute engine: pure functions over calendar condition objects, no framework
// dependencies (testable from selftest).
// Condition object shape: { cal: CalendarCondition, consumed, neverMatch, nextFireMs }.
// The recompute anchor (last on-calendar elapse: a fired trigger or a due trigger consumed
// by an overlap=skip) is a job-level moment (JobState.lastTriggerMs — systemd's one shared
// last trigger moment per unit) passed in as opts.anchorMs, never stored per condition.
// Anchors passed to these functions are past moments (anchor / run end / now) — the scheduler
// guarantees the invariant: the tick's in-process rewind branch clamps a future in-memory
// anchor in place, and the buildCalendars funnel clamps a future persisted anchor at load
// (out-of-process rewind) before recomputeLoad. With anchor <= now, nextMatch lands strictly
// in the future; a next match that "falls in the past" is handled by the tick as "expired →
// elapse exactly once (fire, or consume in place under overlap=skip), then re-arm from the
// elapse moment" → structurally no catch-up chain and no per-fire replay.
// Elapse moments consumed in place (overlap=skip) are dropped, not replayed: a run longer
// than the interval swallows grid points — the condition's scheduled trigger instants
// (expected and universal — schedule accordingly).
// Missed-fire information is not persisted: the operator derives it from the last elapse
// moment, the next trigger time, and the current time.
// Monotonic quantities (onActiveSec/onStartupSec) do not participate in recomputation:
// each tick derives them from (lastActivationMs ?? process start) + span.
import { wallToMs } from './time.js'
import type { CalCond } from './types.js'

/**
 * Recomputation on load / re-enable (process start, disable→enable reload; the persistent
 * startup path).
 * cron: nf = nextMatch(anchorMs ?? now), single step (no walk-back);
 *   nf <= now: persistent=true  → nf = now (rebase: exactly one catch-up fire on the first
 *                                tick after load; the elapse then re-arms from the elapse
 *                                moment, which lands in the future, so remaining missed
 *                                fires are dropped and no missed record is kept);
 *             persistent=false → nf = nextMatch(now) (phase reset to now: the missed
 *                                interval is silently dropped, matching the non-persistent
 *                                startup behavior).
 * ISO: one-shot; always points at the instant unless consumed (expired → fires immediately
 *      on the first tick, one-shot, practical semantics).
 *
 * @param cond calendar condition, modified in place (CalCond).
 * @param opts.nowMs base moment of the recompute.
 * @param opts.anchorMs the job's last on-calendar elapse moment (null = no persisted anchor;
 * a future anchor is clamped to nowMs by the caller — tick rewind branch in-process,
 * buildCalendars funnel out-of-process).
 * @param opts.persistent the job's persistent flag.
 * @returns recomputed nextFireMs (= cond.nextFireMs).
 */
export function recomputeLoad(cond: CalCond, { nowMs, anchorMs, persistent }: { nowMs: number; anchorMs: number | null; persistent: boolean }): { nextFireMs: number | null } {
  if (cond.cal.kind === 'iso') {
    cond.nextFireMs = cond.consumed ? null : cond.cal.instantMs
    return { nextFireMs: cond.nextFireMs }
  }
  if (cond.neverMatch) {
    cond.nextFireMs = null
    return { nextFireMs: null }
  }
  let nf = cond.cal.nextMatch(anchorMs ?? nowMs)
  if (nf === null) {
    cond.nextFireMs = null
    cond.neverMatch = true
    return { nextFireMs: null }
  }
  if (nf <= nowMs) {
    nf = persistent ? nowMs : cond.cal.nextMatch(nowMs)
    if (nf === null) {
      cond.nextFireMs = null
      cond.neverMatch = true
      return { nextFireMs: null }
    }
  }
  cond.nextFireMs = nf
  return { nextFireMs: nf }
}

/**
 * Recomputation after a run ends (deactivation).
 * Conditions are maintained in place at their elapse moments (fire or consume sites), so at
 * deactivation every non-suspended condition already holds a next trigger strictly in the
 * future: the recompute is a no-op for them. Only suspended conditions (defer=true fires
 * left nextFireMs = null) are re-armed from the run end moment:
 * cron: nextFireMs = nextMatch(runEndMs) (null → neverMatch).
 * ISO: one-shot; untouched (a consumed instant is terminal; an unconsumed future instant
 *      keeps pointing at its instant).
 *
 * @param cond calendar condition, modified in place (CalCond).
 * @param opts.runEndMs run end moment (re-arm base for suspended conditions).
 * @returns recomputed nextFireMs (= cond.nextFireMs).
 */
export function recomputeRunEnd(cond: CalCond, { runEndMs }: { runEndMs: number }): { nextFireMs: number | null } {
  if (cond.cal.kind === 'iso') {
    return { nextFireMs: cond.consumed ? null : cond.nextFireMs }
  }
  if (cond.neverMatch) {
    cond.nextFireMs = null
    return { nextFireMs: null }
  }
  if (cond.nextFireMs !== null) {
    return { nextFireMs: cond.nextFireMs } // maintained in place at its elapse moment
  }
  cond.nextFireMs = cond.cal.nextMatch(runEndMs)
  if (cond.nextFireMs === null) cond.neverMatch = true
  return { nextFireMs: cond.nextFireMs }
}

/**
 * Clock rewind (wall-minus-monotonic delta < -1s). The caller clamps the stored job anchor
 * to the detected now in place (systemd on_clock_change: the last trigger moment is clamped
 * to the current time) and passes the clamped anchor here; this function only recomputes.
 * Grid points in the erased interval (anchor, now] land in the future again under the
 * rewound clock and elapse once more (systemd-faithful; no dedup).
 * ISO: a fixed instant is never invalidated by a rewind (a future instant stays future; a
 * past instant is simply due on the next tick).
 *
 * @param cond calendar condition, modified in place (CalCond).
 * @param opts.nowMs base moment at which the rewind was detected.
 * @param opts.anchorMs the job's (clamped) anchor moment (null = no anchor → re-arm from now).
 * @returns recomputed nextFireMs (= cond.nextFireMs).
 */
export function recomputeClockRewind(cond: CalCond, { nowMs, anchorMs }: { nowMs: number; anchorMs: number | null }): { nextFireMs: number | null } {
  if (cond.cal.kind === 'iso') {
    return { nextFireMs: cond.nextFireMs }
  }
  if (cond.neverMatch) {
    cond.nextFireMs = null
    return { nextFireMs: null }
  }
  cond.nextFireMs = cond.cal.nextMatch(anchorMs ?? nowMs)
  if (cond.nextFireMs === null) cond.neverMatch = true
  return { nextFireMs: cond.nextFireMs }
}

/**
 * System timezone change (detected via /etc/localtime mtime): recompute under the new tz
 * (the scheduler swaps the condition's tz first) — systemd OnTimezoneChange=false semantics:
 * every condition is recomputed under the new zone, no cron/ISO exception.
 * ISO: a naive ISO is re-resolved from its stored wall components under the new tz; the
 * re-resolved instant is stored back on the condition. Re-resolved moment in the past → one
 * catch-up fire (nf = now, rebased to the current moment; the one-shot then terminates).
 * A zoned ISO carries its own offset and is never recomputed. The wall time falling inside
 * the new zone's DST gap keeps the previously resolved absolute moment (deterministic
 * fallback; that moment then behaves like any past/future instant).
 * Cron: base = anchorMs ?? now (the job's shared anchor, systemd's one shared last trigger
 * moment per unit); a new next match that falls in the past (the zone shift moved the grid)
 * → one catch-up fire (nf = now, rebased to the current moment), then the elapse re-arms
 * from the elapse moment, which lands in the future.
 *
 * @param cond calendar condition, modified in place (CalCond).
 * @param opts.nowMs base moment at which the change was detected.
 * @param opts.anchorMs the job's anchor moment (null = no anchor → re-arm from now).
 * @returns recomputed nextFireMs (= cond.nextFireMs).
 */
export function recomputeTzChange(cond: CalCond, { nowMs, anchorMs }: { nowMs: number; anchorMs: number | null }): { nextFireMs: number | null } {
  if (cond.cal.kind === 'iso') {
    if (cond.consumed) {
      cond.nextFireMs = null
      return { nextFireMs: null }
    }
    if (cond.cal.wallParts !== null) {
      // naive wall time: re-resolve under the new tz and store back
      const reResolved = wallToMs(cond.cal.wallParts, cond.cal.tz)
      if (reResolved === null) {
        return { nextFireMs: cond.nextFireMs } // wall time inside the new zone's DST gap: keep the previous instant
      }
      cond.cal.instantMs = reResolved
      cond.nextFireMs = reResolved <= nowMs ? nowMs : reResolved // past → one catch-up fire rebased to now, then the one-shot terminates
      return { nextFireMs: cond.nextFireMs }
    }
    cond.nextFireMs = cond.cal.instantMs
    return { nextFireMs: cond.nextFireMs }
  }
  const nf = cond.cal.nextMatch(anchorMs ?? nowMs)
  if (nf === null) {
    cond.nextFireMs = null
    cond.neverMatch = true
    return { nextFireMs: null }
  }
  cond.nextFireMs = nf <= nowMs ? nowMs : nf // new next match in the past (zone shift moved the grid) → one catch-up fire rebased to now
  return { nextFireMs: cond.nextFireMs }
}
/**
 * Fire moment (the tick that detected the expiry). The job-level anchor is advanced by the
 * caller (last on-calendar elapse = the current tick moment), not here.
 * cron defer=true → nextFireMs = null (suspended: due moments during the run are skipped
 * without advancing the phase; re-armed from the run end at deactivation). The suspended
 * null is TRANSIENT: it must not set neverMatch (a permanent no-match can only arise from a
 * null nextMatch return);
 * defer=false → nextFireMs = nextMatch(actual elapse moment) (strictly after the elapse
 * moment → lands in the future, structurally no catch-up chain);
 * ISO → consumed = true, terminal.
 *
 * @param cond calendar condition, modified in place (CalCond).
 * @param opts.defer the job's deferReactivation flag.
 * @param opts.firedAtMs actual trigger moment (current tick moment).
 * @returns the actual trigger moment.
 */
export function applyFire(cond: CalCond, { defer, firedAtMs }: { defer: boolean; firedAtMs: number }): { firedAt: number } {
  if (cond.cal.kind === 'iso') {
    cond.consumed = true
    cond.nextFireMs = null
    return { firedAt: firedAtMs }
  }
  if (defer) {
    // Suspended (transient): the run-end recompute re-arms it from the run end. Must not
    // set neverMatch — a suspended condition that reached neverMatch would be skipped by
    // the tick forever (recomputeRunEnd bails on neverMatch) and the poisoned flag
    // persists across restarts: a defer=true cron job would die after its first fire.
    cond.nextFireMs = null
  } else {
    cond.nextFireMs = cond.cal.nextMatch(firedAtMs)
    if (cond.nextFireMs === null) cond.neverMatch = true
  }
  return { firedAt: firedAtMs }
}
