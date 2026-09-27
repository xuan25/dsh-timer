// dsh-timer scheduling core:
//   directory scan (event + manual reload) → job models → 30s tick (clock rewind / system
//   timezone change / expiry fires / overlap) → recompute after run settlement → verbs
//   (reload/status/run/enable/disable/add/delete/cancel).
// Config = <jobsDir>/<id>.json (one file per id; the in-file `enable` field decides
// enabled/disabled: absent or true = enabled, false = disabled).
// State = <jobsDir>/state/<id>.json (atomic write, best-effort); deleting a job removes the
// state file too.
// Timers go through the cordis timer service (ctx.interval/ctx.timeout fiber effects; the
// plugin declares inject: ['timer']). A static plugin runs in the host realm and is not
// subject to the dynamic-package VM sandbox timer traps, but it still goes through the
// service to keep fiber lifecycles consistent.
import { watch, type FSWatcher } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { JOB_ID_RE, FILE_RE, TICK_MS, CLOCK_JUMP_MS, PLUGIN_NAME, canonicalJson, errMsg, fmtErr, isPlainObject } from './util.js'
import { validateJob } from './validator.js'
import { systemTimeZone, formatWall, makeTzChangeDetector, decodeSystemTimeZoneFromLocaltime } from './time.js'
import { jobFileFor, stateDirFor, freshState, loadState, stateFileFor, pushRun, updateRun, type StateCalendar, type StateRun } from './state.js'
import { recomputeLoad, recomputeRunEnd, recomputeClockRewind, recomputeTzChange, applyFire } from './rearm.js'
import { startRun, newRunRecord } from './runner.js'
import type {
  CalCond,
  JobModel,
  Logger,
  RescanSummary,
  RunOutcome,
  RunRecord,
  SchedulerOptions,
  ValidateSuccess,
} from './types.js'

const STATE_MODE = 0o644
const DIR_MODE = 0o755
const RELOAD_DEBOUNCE_MS = 500

/**
 * dsh-timer in-process scheduler: holds job models / in-progress runs / state persistence,
 * drives the tick and the fs.watch hot reload, and exposes the public methods behind the
 * 8 verbs.
 * Constructed and started by DshTimerPlugin during apply; stopped on plugin dispose.
 */
export class TimerScheduler {
  /** Enabled job models (id → model; the trigger table; hot-updated in place on rescan). */
  private readonly jobs = new Map<string, JobModel>()
  /** Rejected jobs (id → reason). */
  private readonly rejected = new Map<string, string>()
  /** Disabled job models (id → model; valid spec with enable: false). Kept in memory
   * continuously: status, manual run, and hot update all use this model — no temporary
   * file-read models; the state file stays the mirror (manual runs persist into it). */
  private readonly disabledJobs = new Map<string, JobModel>()
  /** In-progress runs (id → Set<run>). */
  private readonly activeRuns = new Map<string, Set<RunRecord>>()
  /** onStartupSec already fired in this process (preserved across disable→enable). */
  private readonly startupMemory = new Map<string, boolean>()
  /** Process start moment (onStartupSec base / backfilling finishedAt). */
  private readonly processStartMs = Date.now()
  /** /etc/localtime mtime change detector (system timezone switch detection). */
  private readonly detectTzChange: () => boolean
  private readonly ctx: SchedulerOptions['ctx']
  private readonly logger: Logger
  /** Job directory (mirrors the jobsDir field of the JS version's createScheduler return; read-only externally). */
  readonly jobsDir: string
  private tickDispose: (() => void) | null = null
  private watcher: FSWatcher | null = null
  private reloadDispose: (() => void) | null = null
  private prevTickWall = Date.now()
  private prevTickMono = process.hrtime.bigint()
  /** Single-flight reentrancy guard: an interval firing while a tick is still in flight is
   *  dropped. The tick is synchronous (create settlement is a detached self-settling
   *  lifecycle), so this guards against re-entrancy only — a stuck create can no longer
   *  hold a tick in flight. */
  private tickInFlight = false
  private stopped = false

  constructor({ ctx, logger, jobsDir }: SchedulerOptions) {
    this.ctx = ctx
    this.logger = logger
    this.jobsDir = jobsDir
    this.detectTzChange = makeTzChangeDetector()
  }

  // ── State persistence ─────────────────────────────────────

  private stateFileOf(id: string): string {
    return stateFileFor(this.jobsDir, id)
  }

  private jobFileOf(id: string): string {
    return jobFileFor(this.jobsDir, id)
  }

  private persistStateFile(model: JobModel): Promise<void> {
    if (model.deleted) return Promise.resolve()
    return this.writeJsonFile(this.stateFileOf(model.id), model.state).then(async () => {
      // Close the delete-vs-persist race: the deleted check above runs before the async
      // write, so a job deleted while the write is in flight would be re-created by its rename
      // after the delete's own unlink. As the sole writer of state files, remove the file
      // again (best effort) when the job is deleted by the time the write lands.
      if (model.deleted) {
        try {
          await fsp.unlink(this.stateFileOf(model.id))
        } catch {
          /* already gone */
        }
      }
    })
  }

  /** Persist a JSON value pretty-printed with a trailing newline (job spec files and state files share one on-disk layout). */
  private writeJsonFile(file: string, value: unknown): Promise<void> {
    return writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', { mode: STATE_MODE, dirMode: DIR_MODE })
  }

  /** Validate an id against the job-id grammar; `detail` optionally extends the error message. */
  private assertJobId(id: string | undefined, detail?: string): string {
    const key = String(id)
    if (!JOB_ID_RE.test(key)) throw new Error(`invalid job id: ${key}${detail ? ` (${detail})` : ''}`)
    return key
  }

  /** Uniform not-found message for job verbs (shared by the thrown verbs and the status report). */
  private jobNotFoundMsg(id: string): string {
    return `job ${id} does not exist`
  }

  /** Best-effort persistence: on failure only record stateNote + warn (does not block scheduling). */
  private voidSafePersist(model: JobModel): void {
    void this.persistStateFile(model).catch((err) => {
      if (model.deleted) return
      model.stateNote = `state write failed: ${errMsg(err)}`
      this.logger.warn(`job=${model.id} state write failed: ${errMsg(err)}`)
    })
  }

  private makeJob(id: string, v: ValidateSuccess): JobModel {
    return {
      id,
      spec: v.spec,
      valid: v,
      tz: v.tz,
      persistent: v.persistent,
      defer: v.defer,
      overlap: v.overlap,
      runtimeMaxMs: v.runtimeMaxMs,
      monotonicSpanMs: v.onUnitActiveSecMs,
      startupSpanMs: v.onStartupSecMs,
      startupConsumed: this.startupMemory.get(id) ?? false,
      calendars: [],
      state: freshState(id),
      stateNote: null,
      deleted: false,
    }
  }

  private syncCalendarsToState(model: JobModel): void {
    model.state.calendars = {}
    for (const cond of model.calendars) {
      const entry: StateCalendar = {
        value: cond.key,
        kind: cond.cal.kind,
        neverMatch: cond.neverMatch,
        consumed: cond.consumed,
        nextFireMs: cond.nextFireMs,
      }
      model.state.calendars[cond.key] = entry
    }
  }

  /** Rebuild calendar conditions after load / re-enable / config hot update (recompute rule = rearm.recomputeLoad).
   * A persisted anchor in the future of now (out-of-process clock rewind: the process was stopped
   * across the rewind, so the tick's in-process detector cannot see it) is clamped to now in place
   * before recomputing — the same correction the tick's rewind branch applies in-process
   * (systemd v262 load-time twins: a future persistent stamp is rejected / a future base is
   * recalculated from the current time, timer.c L713–719 + #6036 L429–441, both unconditional).
   * Grid points in the erased interval re-present under the rewound clock and elapse once more
   * (re-presented labels are new firings at new physical instants, not duplicates). The clamped
   * anchor is persisted by the caller's state write. */
  private buildCalendars(model: JobModel, nowMs: number): void {
    if (model.state.lastTriggerMs !== null && model.state.lastTriggerMs > nowMs) {
      this.logger.warn(
        `job=${model.id} out-of-process clock rewind: persisted lastTriggerMs ${model.state.lastTriggerMs} is in the future of load now ${nowMs}; clamped to now, recomputing from the current time`,
      )
      model.state.lastTriggerMs = nowMs
    }
    const persisted: Record<string, unknown> = model.state?.calendars ?? {}
    model.calendars = []
    for (const cal of model.valid.calendars) {
      const raw = persisted[cal.value]
      const p: StateCalendar | null = (typeof raw === 'object' && raw !== null) ? (raw as StateCalendar) : null
      const cond: CalCond = {
        key: cal.value,
        cal,
        neverMatch: p?.neverMatch === true,
        consumed: p?.consumed === true,
        nextFireMs: null,
      }
      recomputeLoad(cond, { nowMs, anchorMs: model.state.lastTriggerMs, persistent: model.persistent })
      model.calendars.push(cond)
    }
    this.syncCalendarsToState(model)
  }

  /** Consume one fire (create_failed: the fire is treated as happened — ISO stays consumed;
   * a suspended cron re-arms from the fire moment, the job anchor advanced by the fire site
   * → no per-fire retry storm). */
  private consumeFire(cond: CalCond, firedAtMs: number): void {
    if (cond.cal.kind === 'iso') return // applyFire already set consumed=true
    if (cond.nextFireMs === null) {
      const nf = cond.cal.nextMatch(firedAtMs)
      cond.nextFireMs = nf
      cond.neverMatch = nf === null
    }
  }

  // ── Run callbacks ─────────────────────────────────────────

  private onRunStart(model: JobModel, run: RunRecord, record0: StateRun): void {
    void run
    if (model.deleted) return
    model.state.lastActivationMs = record0.startedAt // lastActivation = run start moment
    pushRun(model.state, record0)
    this.voidSafePersist(model)
  }

  /**
   * Create-failed fire bookkeeping — run by the tick's detached startRun continuation at
   * settlement time, never inline in the tick loop (which must not block on create
   * settlement): the fire is treated as happened — ISO stays consumed; deferred cron
   * re-arms from the actual trigger moment (applyFire left it suspended: nextFireMs =
   * null); onActiveSec re-arms from the tick moment → no per-fire / per-tick retry storm.
   */
  private bookkeepCreateFailed(model: JobModel, expired: CalCond[], monoFire: boolean, nowMs: number): void {
    for (const cond of expired) this.consumeFire(cond, nowMs)
    if (monoFire) model.state.lastActivationMs = nowMs // onActiveSec re-arms from now; no per-tick retry
    this.syncCalendarsToState(model)
    this.voidSafePersist(model)
  }

  /**
   * Settle an in-flight run that was never settled (an unforeseen startRun rejection outside
   * its failCreate paths): marks it settled in memory and finalizes the state file record as
   * failed/create_failed via onRunEnd (removes it from activeRuns). Idempotent — an
   * already-settled run is left untouched. A persistence failure inside the settlement must
   * not escape the caller's guard (the in-memory run is already settled — no zombie
   * survives either way).
   */
  private settleUnsettledRun(model: JobModel, run: RunRecord, error: string, nowMs: number): void {
    if (run.settled) return
    run.settled = true
    run.status = 'failed'
    run.cause = 'create_failed'
    run.finishedAt = nowMs
    try {
      this.onRunEnd(model, run, { status: 'failed', cause: 'create_failed', finishedAt: run.finishedAt, summary: '', error })
    } catch (err) {
      this.logger.error(`job=${model.id} run settlement failed: ${fmtErr(err)}`)
    }
  }

  private onRunEnd(model: JobModel, run: RunRecord, outcome: RunOutcome): void {
    const set = this.activeRuns.get(model.id)
    if (set) {
      set.delete(run)
      if (set.size === 0) this.activeRuns.delete(model.id)
    }
    if (run.maxTimer) {
      try {
        run.maxTimer()
      } catch {
        /* timer already disposed */
      }
      run.maxTimer = null
    }
    if (model.deleted) return // run of a deleted job: settle but do not write state or recompute
    // Settlement target: the model in the enabled registry when the job is (or became)
    // enabled — an in-flight run of a job that was disabled and re-enabled settles into the
    // (same-address) model's enabled state; otherwise the model the run was started with
    // (the enabled model itself, or the disabled registry model for a disabled job).
    const live = this.jobs.get(model.id)
    const target = live ?? model
    // cause/error are explicitly null (the state file keeps the null keys).
    // startedAt is included: when onRunStart was skipped (the deleted-job path returns above)
    // updateRun takes the upsert branch; without startedAt, jobDetail's formatWall would throw
    // "Invalid time value" (a latent issue from the JS version, fixed here).
    // Normally onRunStart already pushed the in-flight record, so updateRun merges in place and
    // this field has the same value as record0 — zero behavior change.
    updateRun(target.state, run.runId, {
      startedAt: run.startedAt,
      status: outcome.status,
      cause: outcome.cause,
      finishedAt: outcome.finishedAt,
      durationMs: outcome.finishedAt - run.startedAt,
      summary: outcome.summary ?? '',
      error: outcome.error ?? null,
    })
    // Deactivation recompute: runs only when this settlement is the job's deactivation
    // (the settled run was the last in-flight run, so the in-flight set is empty once it
    // is removed, as above — systemd v262's re-arm-on-deactivation, timer.c
    // timer_trigger_notify case TIMER_RUNNING). Non-suspended
    // conditions are maintained in place at their elapse moments (fire or consume sites),
    // so at deactivation they already hold a next trigger strictly in the future and the
    // recompute is a no-op for them; only suspended conditions (defer=true fires left
    // nextFireMs = null) are re-armed from the run end. While any run of the job is still
    // active, intermediate settlements only record, mirroring systemd's discard of an
    // elapse that arrives while the bound service is still active. create_failed
    // settlements are excluded: the fire bookkeeping is owned by bookkeepCreateFailed,
    // not by this recompute.
    if (live && outcome.cause !== 'create_failed' && this.ownedRuns(live).length === 0) {
      for (const cond of live.calendars) {
        recomputeRunEnd(cond, { runEndMs: outcome.finishedAt })
      }
      this.syncCalendarsToState(live)
    }
    // Persist the settled state: jobs in either registry (enabled or disabled) keep their
    // state file (manual runs of disabled jobs record their state too); removed or rejected
    // models write no state (the audit trail is the session log).
    if (live || this.disabledJobs.has(model.id)) this.voidSafePersist(target)
  }

  // ── Scan ──────────────────────────────────────────────────

  /** Iterate models of both registries (enabled + disabled); disabled jobs are display-only
   * (recompute + persist to keep the mirror fresh), never scheduled. */
  private *allModels(): Generator<JobModel> {
    yield* this.jobs.values()
    yield* this.disabledJobs.values()
  }

  /** Apply a re-validated spec onto a live model in place (hot update; the model object keeps
   * its address, so in-flight runs' anchors stay valid). */
  private applySpecUpdate(model: JobModel, v: ValidateSuccess): void {
    model.deleted = false
    model.spec = v.spec
    model.valid = v
    model.tz = v.tz
    model.persistent = v.persistent
    model.defer = v.defer
    model.overlap = v.overlap
    model.runtimeMaxMs = v.runtimeMaxMs
    model.monotonicSpanMs = v.onUnitActiveSecMs
    if (model.startupSpanMs !== v.onStartupSecMs) model.startupConsumed = false
    model.startupSpanMs = v.onStartupSecMs
  }

  /**
   * State reload for hot update / re-enable (F7): valid file → adopt the file content;
   * corrupt file → enabled jobs reset to fresh state + state note, disabled jobs keep the
   * in-memory state + display-only note; file missing (ENOENT) → keep the in-memory state
   * (the file is rebuilt on the next persist).
   */
  private async reloadJobState(model: JobModel): Promise<void> {
    const { state, corrupt, error } = await loadState(this.stateFileOf(model.id))
    if (corrupt) {
      if (this.jobs.has(model.id)) {
        model.state = freshState(model.id)
        model.stateNote = `state file corrupt, reset (${error})`
      } else {
        model.stateNote = 'state file corrupt (not rebuilt in disabled state)'
      }
      return
    }
    if (state === null) {
      // ENOENT: keep the in-memory state; the file is rebuilt on the next persist.
      model.stateNote = null
      return
    }
    model.state = state
    model.stateNote = null
  }

  /**
   * Cancel one in-progress run: mark it cancelled and send the agent cancel.
   * First-recorded cause wins — a run already carrying a pending cause (e.g. a concurrent
   * runtimeMaxSec timeout mark, or an earlier overlap 'stop' / disable / cancel mark) is left
   * untouched, so its settlement keeps the original cause and error attribution.
   * Shared by all cancel paths (overlap 'stop' tick, disable --now, cancel verb).
   * @param what labels the warn log, e.g. 'disable cancel'; logged as `job=${id} ${what} failed`.
   */
  private markCancelled(id: string, run: RunRecord, what: string): boolean {
    if (run.settled || run.pendingCause !== null) return false
    run.pendingCause = 'cancelled'
    try {
      run.handle?.agent.cancel({ kind: 'user' })
    } catch (err) {
      this.logger.warn(`job=${id} ${what} failed: ${errMsg(err)}`)
    }
    return true
  }

  /**
   * In-flight runs owned by this model instance. The activeRuns map is keyed by job id, so a
   * job deleted and recreated under the same id can transiently share its set with an older
   * generation's in-flight runs (delete does not cancel them; they run out normally). The
   * ownership is run.model, captured by the scheduler when the run is created; overlap /
   * status / cancel / disable filter on it so a stale run is never attributed to the new job.
   */
  private ownedRuns(model: JobModel): RunRecord[] {
    const set = this.activeRuns.get(model.id)
    if (!set) return []
    const out: RunRecord[] = []
    for (const run of set) if (run.model === model) out.push(run)
    return out
  }

  /** Cancel the job's in-progress runs (disable --now adaptation; only the runs owned by this
   * model instance, see ownedRuns). Runs already carrying a pending cause (first-recorded
   * cause wins, see markCancelled) are not cancelled twice and are not counted. */
  private cancelActiveRuns(model: JobModel): number {
    let cancelled = 0
    for (const run of this.ownedRuns(model)) {
      if (this.markCancelled(model.id, run, 'disable cancel')) cancelled += 1
    }
    return cancelled
  }

  /** Remove a model from both registries (rejection path: the spec became invalid); mark it
   * deleted so in-progress runs settle without writing state or recomputing. The state file
   * is kept: fixing the spec brings the job back with its run history. */
  private dropFromRegistries(id: string): void {
    const fromJobs = this.jobs.get(id)
    if (fromJobs) {
      fromJobs.deleted = true
      this.jobs.delete(id)
    }
    const fromDisabled = this.disabledJobs.get(id)
    if (fromDisabled) {
      fromDisabled.deleted = true
      this.disabledJobs.delete(id)
    }
  }

  /** Unlink a job's state file (no error when absent). */
  private async unlinkStateFile(id: string): Promise<void> {
    try {
      await fsp.unlink(this.stateFileOf(id))
    } catch {
      /* state file did not exist */
    }
  }

  /** Read + parse a job spec file; returns null when the file is missing, unparseable, or
   * not a JSON object (the setEnabled conflict check treats that as a concurrent change). */
  private async readJobSpecFile(file: string): Promise<{ canon: string; obj: Record<string, unknown> } | null> {
    let text: string
    try {
      text = await fsp.readFile(file, 'utf8')
    } catch {
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (!isPlainObject(parsed)) return null
    return { canon: canonicalJson(parsed), obj: parsed as Record<string, unknown> }
  }

  /**
   * Full rescan of jobsDir: add / hot-update / enable↔disabled flip / remove / reject.
   * One file per id; the `enable` field decides the bucket (absent or true = enabled,
   * false = disabled). Validation takes precedence over the enable bucket: a broken spec is
   * rejected regardless of `enable` (enable: false + broken spec = rejected, not disabled),
   * and the model is dropped from both registries (no last-good; the state file is kept, so
   * fixing the spec brings the job back with its run history).
   * Jobs whose spec is unchanged keep their in-memory model and calendars (avoids disturbing
   * the persistent rebase window and running anchors);
   * "unchanged" is an order-independent (canonical key-sorted) comparison, so a key-reordered
   * no-op rewrite (formatter / tool re-serialization) is not read as a change;
   * jobs whose spec changed are hot-updated in place (stable model object → running runs'
   * anchors stay valid); state reload keeps the in-memory state when the state file is
   * missing (ENOENT; the file is rebuilt on the next persist) and resets it when the state
   * file is corrupt (enabled jobs) or keeps it with a display-only note (disabled jobs).
   * enabled→disabled flip: cancel the job's in-progress runs first (disable --now
   * adaptation; runs already carrying a pending cause are not cancelled twice), then move
   * the model into the disabled registry;
   * disabled→enabled flip: move the model into the trigger table (onStartupSec in-process
   * mark preserved via startupMemory) and re-arm per the re-enable rules;
   * removal from disk: mark the model deleted and unlink the state file; in-progress runs
   * are not cancelled — they settle without writing state or recomputing.
   */
  private async rescan(): Promise<RescanSummary> {
    let entries: string[]
    try {
      entries = await fsp.readdir(this.jobsDir)
    } catch (err) {
      this.logger.error(`failed to read jobsDir: ${errMsg(err)}`)
      return { added: 0, enabled: this.jobs.size, disabled: this.disabledJobs.size, rejected: this.rejected.size }
    }
    const nowMs = Date.now()
    const present = new Set<string>()
    for (const name of entries) {
      const m = FILE_RE.exec(name)
      if (m) present.add(m[1])
    }

    const newRejected = new Map<string, string>()
    let added = 0
    for (const id of present) {
      let spec: unknown
      try {
        spec = JSON.parse(await fsp.readFile(this.jobFileOf(id), 'utf8'))
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        newRejected.set(id, `read/parse failed: ${e.code === 'ENOENT' ? 'file not found' : e.message}`)
        this.dropFromRegistries(id)
        continue
      }
      // Validation takes precedence over the enable bucket: a broken spec is rejected
      // regardless of `enable` (enable: false + broken spec = rejected, not disabled).
      const v = validateJob(spec, { nowMs, defaultTz: systemTimeZone() })
      if (!v.ok) {
        newRejected.set(id, v.errors.join('; '))
        this.dropFromRegistries(id)
        continue
      }
      const enabled = v.spec.enable !== false
      const inJobs = this.jobs.get(id)
      if (inJobs) {
        if (!enabled) {
          // enabled → disabled: hot-update the spec first (in-place; symmetric with the other
          // two migration paths, so a spec change made in the same edit is visible in the
          // disabled job's status detail immediately, without waiting for the next rescan),
          // then cancel in-progress runs (disable --now adaptation), then move the model
          // into the disabled registry.
          if (canonicalJson(v.spec) !== canonicalJson(inJobs.spec)) this.applySpecUpdate(inJobs, v)
          const cancelled = this.cancelActiveRuns(inJobs)
          this.jobs.delete(id)
          this.disabledJobs.set(id, inJobs)
          await this.reloadJobState(inJobs)
          this.buildCalendars(inJobs, nowMs)
          this.voidSafePersist(inJobs)
          this.logger.info(
            cancelled > 0
              ? `job=${id} disabled (enable: false): cancelled ${cancelled} in-progress run(s)`
              : `job=${id} disabled (enable: false); no in-progress runs`,
          )
          continue
        }
        if (canonicalJson(v.spec) === canonicalJson(inJobs.spec)) {
          // Spec unchanged: keep the in-memory model and calendars; no in-process recompute
          // (avoids disturbing the persistent rebase window and running anchors).
          continue
        }
        // Config hot update (in-place; stable model object → running runs' anchors stay valid)
        this.applySpecUpdate(inJobs, v)
        await this.reloadJobState(inJobs)
        this.buildCalendars(inJobs, nowMs)
        this.voidSafePersist(inJobs)
        continue
      }
      const inDisabled = this.disabledJobs.get(id)
      if (inDisabled) {
        if (!enabled) {
          if (canonicalJson(v.spec) === canonicalJson(inDisabled.spec)) {
            // Disabled and unchanged: keep the in-memory model; nothing to do.
            continue
          }
          // Hot update of a disabled job's spec (in-place; the state file stays the mirror
          // and is reloaded with the disabled rule: corrupt keeps the in-memory state).
          this.applySpecUpdate(inDisabled, v)
          await this.reloadJobState(inDisabled)
          this.buildCalendars(inDisabled, nowMs)
          this.voidSafePersist(inDisabled)
          continue
        }
        // disabled → enabled: move the model into the trigger table (onStartupSec in-process
        // mark preserved via startupMemory); state reload then follows the enabled rule.
        if (canonicalJson(v.spec) !== canonicalJson(inDisabled.spec)) this.applySpecUpdate(inDisabled, v)
        this.disabledJobs.delete(id)
        this.jobs.set(id, inDisabled)
        inDisabled.deleted = false
        await this.reloadJobState(inDisabled)
        this.buildCalendars(inDisabled, nowMs)
        this.voidSafePersist(inDisabled)
        this.logger.info(`job=${id} enabled (enable: false → true)`)
        continue
      }
      // New job (in neither registry)
      const model = this.makeJob(id, v)
      const { state, corrupt, error } = await loadState(this.stateFileOf(id))
      if (corrupt) {
        model.state = freshState(id)
        model.stateNote = `state file corrupt, reset (${error})`
      } else if (state !== null) {
        model.state = state
      }
      if (enabled) this.jobs.set(id, model)
      else this.disabledJobs.set(id, model)
      this.buildCalendars(model, nowMs)
      this.voidSafePersist(model)
      added += 1
    }

    // Removal from disk: the model is marked deleted and removed from both registries; the
    // state file is unlinked; in-progress runs are NOT cancelled — they settle without
    // writing state or recomputing (audit trail = the session log).
    for (const [id, model] of [...this.jobs]) {
      if (present.has(id)) continue
      this.jobs.delete(id)
      model.deleted = true
      await this.unlinkStateFile(id)
      this.logger.info(`job=${id} config removed: state file deleted; in-progress runs continue to settle without writing state or recomputing`)
    }
    for (const [id, model] of [...this.disabledJobs]) {
      if (present.has(id)) continue
      this.disabledJobs.delete(id)
      model.deleted = true
      await this.unlinkStateFile(id)
      this.logger.info(`job=${id} config removed: state file deleted; in-progress runs continue to settle without writing state or recomputing`)
    }

    this.rejected.clear()
    for (const [id, why] of newRejected) this.rejected.set(id, why)

    const summary = { added, enabled: this.jobs.size, disabled: this.disabledJobs.size, rejected: this.rejected.size }
    this.logger.info(this.rescanLine(summary))
    return summary
  }

  // ── Tick ──────────────────────────────────────────────────

  private tick(): void {
    // Exit race: an interval callback queued before stop() may fire inside stop()'s
    // await window; neutralize it so no new run is dispatched after exit has begun.
    if (this.stopped) return
    const nowMs = Date.now()
    const mono = process.hrtime.bigint()

    // 1) Clock rewind: wall delta - monotonic delta < -1s → full recompute
    const wallDelta = nowMs - this.prevTickWall
    const monoDeltaMs = Number(mono - this.prevTickMono) / 1e6
    if (wallDelta - monoDeltaMs < -CLOCK_JUMP_MS) {
      this.logger.warn(
        `clock rewound by ~${Math.round(wallDelta - monoDeltaMs)}ms (wall ${wallDelta}ms / mono ${Math.round(monoDeltaMs)}ms); full recompute`,
      )
      for (const model of this.allModels()) {
        if (model.deleted) continue
        // systemd on_clock_change: the shared last trigger moment is clamped to the new
        // now (stored in place — a future anchor would re-arm a past phase).
        // The out-of-process twin = the buildCalendars clamp at load (the tick cannot
        // see a rewind that happened while the process was stopped).
        if (model.state.lastTriggerMs !== null && model.state.lastTriggerMs > nowMs) {
          model.state.lastTriggerMs = nowMs
        }
        const anchorMs = model.state.lastTriggerMs
        for (const cond of model.calendars) {
          recomputeClockRewind(cond, { nowMs, anchorMs })
        }
        this.syncCalendarsToState(model)
      }
      for (const model of this.allModels()) if (!model.deleted) this.voidSafePersist(model)
    }
    this.prevTickWall = nowMs
    this.prevTickMono = mono

    // 2) System timezone change (/etc/localtime mtime): calendar conditions without a job-level
    //    timeZone are recomputed under the new timezone (cron + naive ISO re-resolved; zoned
    //    ISO carries its own offset and is unaffected)
    if (this.detectTzChange()) {
      const dec = decodeSystemTimeZoneFromLocaltime()
      if (dec.tz === null) {
        this.logger.warn('system timezone change detected but the new timezone could not be decoded; the process Intl timezone stays the old value until restart, and calendar recomputation still uses the old timezone')
      } else {
        this.logger.info(`system timezone changed → ${dec.tz} (source ${dec.source}); calendar conditions without a job-level timeZone recomputed under the new timezone (naive-ISO wall times re-resolved, zoned ISO unaffected)`)
        for (const model of this.allModels()) {
          if (model.deleted || model.spec.timeZone !== undefined) continue
          model.tz = dec.tz
          for (const cond of model.calendars) {
            cond.cal.tz = dec.tz
            recomputeTzChange(cond, { nowMs, anchorMs: model.state.lastTriggerMs })
          }
          this.syncCalendarsToState(model)
          this.voidSafePersist(model)
        }
      }
    }

    // 3) Per-job fire detection
    for (const model of this.jobs.values()) {
      if (model.deleted) continue
      const expired: CalCond[] = []
      for (const cond of model.calendars) {
        if (cond.neverMatch || cond.consumed) continue
        if (cond.nextFireMs !== null && cond.nextFireMs <= nowMs) expired.push(cond)
      }
      let monoFire = false
      if (model.monotonicSpanMs !== null) {
        const base = model.state.lastActivationMs ?? this.processStartMs
        if (base + model.monotonicSpanMs <= nowMs) monoFire = true
      }
      let startupFire = false
      if (model.startupSpanMs !== null && !model.startupConsumed && this.processStartMs + model.startupSpanMs <= nowMs) {
        startupFire = true
      }
      if (expired.length === 0 && !monoFire && !startupFire) continue

      // 4) Overlap handling (runs owned by this model only: a recreated same-id job does not
      // inherit a stale generation's in-flight runs — see ownedRuns)
      const active = this.ownedRuns(model)
      if (active.length > 0) {
        if (model.overlap === 'skip') {
          // Consume (systemd-faithful, overlap=skip): due elapses are consumed in place
          // at the skip site — the phase advances at the elapse moment, no catch-up fire
          // after the run ends (a run longer than the interval swallows grid points — the
          // condition's scheduled trigger instants).
          // Monotonic due moments (onActiveSec/onStartupSec) are not phase-bearing: they
          // simply stay due and retry on later ticks until the run ends.
          for (const cond of expired) {
            if (cond.cal.kind === 'iso') {
              cond.consumed = true
              cond.nextFireMs = null
            } else {
              cond.nextFireMs = cond.cal.nextMatch(nowMs)
              if (cond.nextFireMs === null) cond.neverMatch = true
            }
          }
          if (expired.length > 0) model.state.lastTriggerMs = nowMs
          this.syncCalendarsToState(model)
          this.voidSafePersist(model)
          continue
        }
        if (model.overlap === 'stop') {
          for (const r of active) this.markCancelled(model.id, r, 'stop cancel')
        }
      }

      // 5) Fire: account first (fire), then start the run
      if (startupFire) {
        model.startupConsumed = true
        this.startupMemory.set(model.id, true)
      }
      for (const cond of expired) applyFire(cond, { defer: model.defer, firedAtMs: nowMs })
      if (expired.length > 0) model.state.lastTriggerMs = nowMs // elapse site: the shared anchor advances on every on-calendar elapse
      this.syncCalendarsToState(model)
      this.voidSafePersist(model)

      const trigger = startupFire ? 'startup' : (expired.length > 0 ? 'scheduled' : 'monotonic')
      const run = newRunRecord({ jobId: model.id, trigger, startedAt: nowMs })
      run.model = model
      const set = this.activeRuns.get(model.id) ?? new Set<RunRecord>()
      set.add(run)
      this.activeRuns.set(model.id, set)

      // Arrow wrappers bind this (passing a raw method reference would lose this; the
      // runner calls the callbacks bare). The kickoff is DETACHED: the tick never awaits
      // create settlement — a hung create must not delay this tick's remaining jobs or
      // later ticks. Every settlement is owned by the run itself: the CREATE_TIMEOUT_MS
      // deadline timer is the only escape for a hung create, failCreate / onRunEnd settle
      // the run and its state file, and a process restart backfills a record the previous
      // process could not settle. The .then continuation runs at create settlement time
      // (milliseconds for a fast failure, up to the deadline for a hung create) — it only
      // handles what onRunEnd cannot: the create_failed fire bookkeeping.
      void startRun({ ctx: this.ctx, logger: this.logger, model, run, onRunStart: (m, rr, rec) => this.onRunStart(m, rr, rec), onRunEnd: (m, rr, o) => this.onRunEnd(m, rr, o) }).then(
        (r) => {
          if (!r.ok) this.bookkeepCreateFailed(model, expired, monoFire, nowMs)
        },
        (err) => {
          // Defense in depth: startRun's contract is to settle every create failure
          // through failCreate and never reject; if an unforeseen path still rejects,
          // contain it to this job — settle the in-flight run so no zombie record
          // survives, then bookkeep exactly like create_failed.
          const createError = `unexpected startRun rejection: ${fmtErr(err)}`
          this.logger.error(`job=${model.id} ${createError}`)
          this.settleUnsettledRun(model, run, createError, nowMs)
          this.bookkeepCreateFailed(model, expired, monoFire, nowMs)
        },
      )
    }
  }

  // ── Start / Stop ──────────────────────────────────────────

  /** Start scheduling: create the state directory (best-effort mirror; failure degrades persistence, never blocks scheduling) → first scan → backfill unfinished runs from the previous process → start the tick timer and directory watch. */
  async start(): Promise<void> {
    try {
      await fsp.mkdir(stateDirFor(this.jobsDir), { recursive: true })
    } catch (err) {
      // The state directory is a best-effort mirror: when it cannot be created, scheduling
      // continues and every per-job state write fails individually (surfaced via stateNote + warn).
      this.logger.warn(`failed to create state directory ${stateDirFor(this.jobsDir)}: ${errMsg(err)} — state persistence degraded`)
    }
    await this.rescan()
    // Backfill: runs with status=running in state files must belong to the previous process
    // (this process's in-memory activeRuns is empty) → backfill as failed/interrupted; applies
    // to both registries (a disabled job's state file may carry a stale in-flight record from
    // a manual run interrupted mid-flight)
    let backfilled = 0
    for (const model of this.allModels()) {
      const openRuns = model.state.runs.filter((r) => r.status === 'running')
      if (openRuns.length === 0) continue
      for (const r of openRuns) {
        updateRun(model.state, r.runId, {
          status: 'failed',
          cause: 'interrupted',
          finishedAt: this.processStartMs,
          durationMs: Math.max(0, this.processStartMs - r.startedAt),
          summary: r.summary ?? '',
          error: 'interrupted by process restart',
        })
        backfilled += 1
      }
      this.voidSafePersist(model)
    }
    if (backfilled > 0) this.logger.info(`backfilled ${backfilled} unfinished run(s) from the previous process as failed/interrupted`)
    // Timers go through the cordis timer service (fiber effects; reclaimed automatically on package dispose)
    this.tickDispose = this.ctx.interval(() => {
      // Single-flight reentrancy guard: tick() is synchronous (no suspension points —
      // create settlement is a detached self-settling lifecycle), so an overlapping
      // interval firing is structurally unreachable today; the guard stays as protection
      // against a future async re-introduction.
      if (this.tickInFlight) return
      this.tickInFlight = true
      try {
        this.tick()
      } catch (err) {
        this.logger.error(`tick error: ${fmtErr(err)}`)
      } finally {
        this.tickInFlight = false
      }
    }, TICK_MS)
    try {
      // inotify watches the top level only: writes to the state/ subdirectory do not self-trigger
      this.watcher = watch(this.jobsDir, { persistent: false }, () => {
        if (this.stopped || this.reloadDispose) return
        this.reloadDispose = this.ctx.timeout(() => {
          this.reloadDispose = null
          this.rescan().catch((err) => this.logger.error(`rescan error: ${fmtErr(err)}`))
        }, RELOAD_DEBOUNCE_MS)
      })
    } catch (err) {
      this.watcher = null
      this.logger.warn(`fs.watch unavailable (${errMsg(err)}); directory changes require a manual reload`)
    }
    this.logger.info(
      `${PLUGIN_NAME} started: jobsDir=${this.jobsDir}, enabled ${this.jobs.size}, disabled ${this.disabledJobs.size}, rejected ${this.rejected.size}`,
    )
  }

  /**
   * Stop scheduling and deterministically settle every in-flight run (the graceful-exit
   * mechanism; startup backfill remains the crash/kill net). Order matters: the tick loop,
   * reload debounce, and directory watch are disposed first — disposing the interval
   * cancels the pending period in O(1) (no tick-period wait), and the tick's stopped
   * guard makes a late callback a no-op — so no new run can be dispatched afterwards.
   * Every unsettled run is then settled as failed: first-recorded-cause-wins (a
   * pre-existing cancelled/timeout cause beats the exit mark), the error mapping is
   * identical to the runner's whenIdle settlement so both mechanisms write the same
   * record shape, and the settled flag is raised before settlement so a still-pending
   * whenIdle IIFE bails out without a second write. One awaited state-file write per
   * affected model runs before this promise resolves; the framework awaits the plugin
   * disposer, so by the time disposal proceeds the exit-side settlement is on disk.
   * Agent sessions of settled runs are still cancelled (best effort) so the host
   * reclaims them.
   */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.tickDispose) {
      try {
        this.tickDispose()
      } catch {
        /* */
      }
      this.tickDispose = null
    }
    if (this.reloadDispose) {
      try {
        this.reloadDispose()
      } catch {
        /* */
      }
      this.reloadDispose = null
    }
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        /* */
      }
      this.watcher = null
    }
    const nowMs = Date.now()
    const settleTargets = new Set<JobModel>()
    for (const set of this.activeRuns.values()) {
      for (const run of [...set]) {
        if (run.settled) continue
        if (!run.pendingCause) run.pendingCause = 'interrupted'
        // Raised before settlement: a whenIdle IIFE still in flight bails out at its
        // settled check instead of writing a second settlement.
        run.settled = true
        const cause = run.pendingCause
        const model = run.model
        if (model && !model.deleted) {
          // Deleted models write no state (their state file was unlinked at removal);
          // onRunEnd would skip the write anyway, so they are not persist targets.
          settleTargets.add(model)
          run.status = 'failed'
          run.cause = cause
          run.finishedAt = nowMs
          const error =
            cause === 'timeout'
              ? `runtimeMaxSec=${model.runtimeMaxMs}ms timed out`
              : cause === 'interrupted'
                ? 'interrupted by process restart'
                : (run.followupError ?? null)
          try {
            this.onRunEnd(model, run, { status: 'failed', cause, finishedAt: nowMs, summary: '', error })
          } catch (err) {
            this.logger.error(`job=${model.id} run settlement failed: ${fmtErr(err)}`)
          }
        }
        try {
          run.handle?.agent.cancel({ kind: 'user' })
        } catch {
          /* */
        }
        // Also dispose the run session (best effort, mirroring the runner's orphan-protection
        // pattern): the run's whenIdle IIFE bails out at its settled check and never reaches
        // its own dispose, so without this the agent handles of interrupted runs would linger
        // in memory on the in-process-unload path until the process exits.
        void run.handle?.dispose().catch(() => {
          /* already disposed */
        })
      }
    }
    // Deterministic exit-side write: unlike the fire-and-forget settlement persists,
    // these are awaited before stop() resolves, so the settled records are on disk by
    // the time the process exits (a pre-existing in-flight fire-and-forget write that
    // lands afterwards still converges via startup backfill on the next start).
    for (const model of settleTargets) {
      try {
        await this.persistStateFile(model)
      } catch (err) {
        this.logger.error(`job=${model.id} exit state write failed: ${fmtErr(err)}`)
      }
    }
  }

  // ── Verbs ─────────────────────────────────────────────────

  /** Shared line builder for the pinned `rescan complete: enabled N, disabled N, rejected N`
   * report line; the rescan log and the reload verb report both use it so the two can never
   * drift apart. */
  private rescanLine(r: { enabled: number; disabled: number; rejected: number }): string {
    return `rescan complete: enabled ${r.enabled}, disabled ${r.disabled}, rejected ${r.rejected}`
  }

  /** reload: manually trigger a full rescan of jobsDir; returns a summary text (includes rejection details). */
  async reload(): Promise<string> {
    const r = await this.rescan()
    const lines = [this.rescanLine(r)]
    for (const [id, why] of this.rejected) lines.push(`rejected ${id}: ${why}`)
    return lines.join('\n')
  }

  /** Earliest next trigger across all conditions (human-readable text). */
  private fmtNext(model: JobModel, nowMs: number): string {
    const cands: { at: number | null; label: string }[] = []
    for (const cond of model.calendars) {
      if (cond.neverMatch) {
        cands.push({ at: null, label: `onCalendar ${cond.key} (no future match)` })
        continue
      }
      if (cond.consumed) continue
      if (cond.nextFireMs !== null) cands.push({ at: cond.nextFireMs, label: `onCalendar ${cond.key}` })
    }
    if (model.monotonicSpanMs !== null) {
      const base = model.state.lastActivationMs ?? this.processStartMs
      // Unit is ms in both list and detail modes (fmtNext is shared by both modes; the
      // detail condition lines print ms).
      cands.push({ at: base + model.monotonicSpanMs, label: `onActiveSec ${model.monotonicSpanMs}ms` })
    }
    if (model.startupSpanMs !== null) {
      cands.push({
        at: model.startupConsumed ? null : this.processStartMs + model.startupSpanMs,
        label: model.startupConsumed
          ? 'onStartupSec (already fired in this process)'
          : `onStartupSec ${model.startupSpanMs}ms`,
      })
    }
    // Type-predicate narrowing to at: number (filter already excludes null), avoiding a non-null assertion
    const future = cands
      .filter((c): c is { at: number; label: string } => c.at !== null && c.at > nowMs)
      .sort((a, b) => a.at - b.at)
    if (future.length > 0) return `${formatWall(future[0].at, model.tz)} ← ${future[0].label}`
    // Sort due candidates by time so the reported label is the EARLIEST due condition, not
    // merely the first one in calendar order.
    const due = cands
      .filter((c): c is { at: number; label: string } => c.at !== null && c.at <= nowMs)
      .sort((a, b) => a.at - b.at)
    if (due.length > 0) return `(${due[0].label} is due, will fire on the next tick)`
    if (cands.length > 0) return cands.map((c) => c.label).join('; ')
    return 'none'
  }

  /** Single-job detail (status verb; enabled and disabled jobs both use their in-memory models). */
  private jobDetail(model: JobModel, opts: { disabled?: boolean; nowMs?: number } = {}): string {
    const disabled = opts.disabled ?? false
    const nowMs = opts.nowMs ?? Date.now()
    const lines: string[] = []
    lines.push(`# ${model.id}${disabled ? ' (disabled)' : ''}`)
    lines.push(
      `timezone ${model.tz}${model.spec.timeZone ? ' (job-level timeZone)' : ' (system)'} | persistent=${model.persistent} | deferReactivation=${model.defer} | overlap=${model.overlap}`,
    )
    if (model.state.lastTriggerMs !== null) {
      lines.push(`last on-calendar elapse ${formatWall(model.state.lastTriggerMs, model.tz)}`)
    }
    if (model.runtimeMaxMs !== null) lines.push(`runtimeMaxSec ${model.runtimeMaxMs}ms`)
    const conds: string[] = []
    for (const cond of model.calendars) {
      let s = `onCalendar ${cond.key}`
      if (cond.neverMatch) s += ' [no future match]'
      else if (cond.consumed) s += ' [fired (one-shot ISO instant)]'
      else if (cond.nextFireMs !== null) {
        s += ` next ${formatWall(cond.nextFireMs, model.tz)}`
      }
      conds.push(s)
    }
    if (model.monotonicSpanMs !== null) {
      const base = model.state.lastActivationMs ?? this.processStartMs
      const baseLabel = model.state.lastActivationMs
        ? `last activation ${formatWall(model.state.lastActivationMs, model.tz)}`
        : `process start ${formatWall(this.processStartMs, model.tz)}`
      conds.push(`onActiveSec ${model.monotonicSpanMs}ms (from ${baseLabel}, next ${formatWall(base + model.monotonicSpanMs, model.tz)})`)
    }
    if (model.startupSpanMs !== null) {
      conds.push(
        model.startupConsumed
          ? 'onStartupSec (already fired in this process)'
          : `onStartupSec ${model.startupSpanMs}ms (from process start ${formatWall(this.processStartMs, model.tz)}, next ${formatWall(this.processStartMs + model.startupSpanMs, model.tz)})`,
      )
    }
    for (const c of conds) lines.push(`- ${c}`)
    const recent = model.state.runs.slice(-5).reverse()
    if (recent.length > 0) {
      for (const r of recent) {
        const cause = r.cause ? ` (${r.cause})` : ''
        lines.push(
          `recent run: ${r.status}${cause}, started ${formatWall(r.startedAt, model.tz)}${r.finishedAt ? `, finished ${formatWall(r.finishedAt, model.tz)}` : ' (in progress)'}${r.durationMs !== null ? `, duration ${r.durationMs}ms` : ''}, runId=${r.runId}, sessionId=${r.sessionId ?? '—'}`,
        )
        if (r.summary) lines.push(`summary: ${r.summary}`)
        if (r.error) lines.push(`error: ${r.error}`)
      }
    } else {
      lines.push('recent run: none (no runs yet)')
    }
    const active = this.ownedRuns(model)
    if (active.length > 0) lines.push(`in-progress runs: ${active.length}`)
    if (model.stateNote) lines.push(`state note: ${model.stateNote}`)
    lines.push(`next (earliest of all conditions): ${this.fmtNext(model, nowMs)}`)
    return lines.join('\n')
  }

  /**
   * status: id omitted = overview (three buckets: enabled / disabled / rejected + in-progress
   * runs); id present = single-job detail (enabled and disabled jobs both use their in-memory
   * models — no temporary file reads; rejected and missing ids report the reason / absence).
   */
  async statusText(id?: string): Promise<string> {
    if (id !== undefined) {
      const model = this.jobs.get(id)
      if (model) return this.jobDetail(model)
      const dis = this.disabledJobs.get(id)
      if (dis) return this.jobDetail(dis, { disabled: true })
      const rej = this.rejected.get(id)
      if (rej) return `job ${id} was rejected: ${rej}`
      return this.jobNotFoundMsg(id)
    }
    const nowMs = Date.now()
    const lines = [`${PLUGIN_NAME} status | jobsDir=${this.jobsDir} | process start ${formatWall(this.processStartMs, systemTimeZone())}`, '']
    lines.push(`[enabled] ${this.jobs.size}`)
    for (const model of this.jobs.values()) {
      const last = model.state.runs.at(-1)
      const lastPart = last ? ` | last run: ${last.status}${last.cause ? `(${last.cause})` : ''}` : ' | recent run: none (no runs yet)'
      lines.push(`- ${model.id}  next: ${this.fmtNext(model, nowMs)}${lastPart}`)
    }
    lines.push('')
    lines.push(`[disabled] ${this.disabledJobs.size}`)
    for (const [id, model] of [...this.disabledJobs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const last = model.state.runs.at(-1)
      const lastPart = last ? ` | last run: ${last.status}${last.cause ? `(${last.cause})` : ''}` : ' | recent run: none (no runs yet)'
      lines.push(`- ${id}  enabled=false${lastPart}`)
    }
    lines.push('')
    lines.push(`[rejected] ${this.rejected.size}`)
    for (const [id, why] of this.rejected) lines.push(`- ${id}: ${why}`)
    const activeTotal = [...this.activeRuns.values()].reduce((n, s) => n + s.size, 0)
    if (activeTotal > 0) lines.push('', `in-progress runs: ${activeTotal}`)
    return lines.join('\n')
  }

  /**
   * run: manually trigger one run (disabled jobs allowed too: their in-memory disabled
   * registry model is used directly — spec and enabled state live in the same file, so no
   * temporary model is built; settlement records state into the job's state file as usual).
   * Manual runs have no fire accounting: create_failed is only recorded, no retry is triggered.
   */
  async manualRun(id: string | undefined): Promise<string> {
    const idKey = this.assertJobId(id)
    const nowMs = Date.now()
    const model = this.jobs.get(idKey) ?? this.disabledJobs.get(idKey)
    if (!model) {
      const rej = this.rejected.get(idKey)
      if (rej) throw new Error(`job ${idKey} was rejected and cannot run: ${rej}`)
      throw new Error(this.jobNotFoundMsg(idKey))
    }
    const isDisabled = !this.jobs.has(idKey)
    const run = newRunRecord({ jobId: idKey, trigger: 'manual', startedAt: nowMs })
    run.model = model
    const set = this.activeRuns.get(idKey) ?? new Set<RunRecord>()
    set.add(run)
    this.activeRuns.set(idKey, set)
    // Arrow wrappers bind this (same as the tick path; a raw method reference would lose this)
    let createError: string | null = null
    try {
      const r = await startRun({ ctx: this.ctx, logger: this.logger, model, run, onRunStart: (m, rr, rec) => this.onRunStart(m, rr, rec), onRunEnd: (m, rr, o) => this.onRunEnd(m, rr, o) })
      if (!r.ok) createError = r.error
    } catch (err) {
      // Same defense-in-depth guard as the tick path: an unforeseen startRun rejection is
      // contained to this run — settled so no zombie record survives — and reported to the
      // caller as a create_failed.
      createError = `unexpected startRun rejection: ${fmtErr(err)}`
      this.logger.error(`job=${idKey} ${createError}`)
      this.settleUnsettledRun(model, run, createError, nowMs)
    }
    if (createError !== null) {
      // Manual runs have no fire accounting: create_failed is only recorded, no retry
      return `run start failed (create_failed): ${createError} (recorded)`
    }
    return `started run ${run.runId.slice(0, 8)} (${idKey}, ${isDisabled ? 'manual while disabled' : 'manual'})${isDisabled ? '; state will be recorded on settlement' : ''}`
  }

  /**
   * enable / disable (= disable --now): optimistic read-modify-write of the job file's
   * `enable` field (read → parse → change only `enable` → re-read → the canonical JSON must
   * still match the read baseline, otherwise retry once; still conflicting → not written).
   * disable = disable --now adaptation: cancel the job's in-progress runs first (recorded as
   * failed/cancelled at settlement), then enable: false; enable = enable: true. After the
   * write the verb triggers one immediate rescan (manual file edits go through the fs.watch
   * debounce instead); the rescan's enabled→disabled flip cancels any runs the verb did not
   * cancel (runs already carrying a pending cause are not cancelled twice).
   */
  async setEnabled(id: string | undefined, enabled: boolean): Promise<string> {
    const idKey = this.assertJobId(id)
    if (enabled && this.jobs.has(idKey)) return `job ${idKey} is already enabled`
    if (!enabled && this.disabledJobs.has(idKey)) return `job ${idKey} is already disabled`
    if (this.rejected.has(idKey)) throw new Error(`job ${idKey} is rejected; fix the spec first (${this.rejected.get(idKey)})`)
    if (!this.jobs.has(idKey) && !this.disabledJobs.has(idKey)) throw new Error(this.jobNotFoundMsg(idKey))
    let cancelled = 0
    const model = this.jobs.get(idKey)
    if (model && !enabled) cancelled = this.cancelActiveRuns(model) // disable --now adaptation
    const jsonFile = this.jobFileOf(idKey)
    let written = false
    for (let attempt = 0; attempt < 2 && !written; attempt++) {
      const base = await this.readJobSpecFile(jsonFile)
      if (base === null) continue // file missing / unparseable → treat as a concurrent change, retry
      const { canon: baseCanon, obj } = base
      obj.enable = enabled
      const current = await this.readJobSpecFile(jsonFile)
      if (current === null || current.canon !== baseCanon) {
        // The file changed between the read and the re-read: retry once, then give up without writing.
        continue
      }
      await this.writeJsonFile(jsonFile, obj)
      written = true
    }
    if (!written) throw new Error(`job ${idKey} changed concurrently (conflict); not written`)
    const r = await this.rescan()
    if (!enabled) {
      return `disabled job ${idKey}: cancelled ${cancelled} in-progress run(s) (currently ${r.enabled} enabled, ${r.disabled} disabled)`
    }
    return `enabled job ${idKey} (currently ${r.enabled} enabled, ${r.disabled} disabled)`
  }

  /**
   * add = upsert: a new id is created; an existing id has its spec file overwritten. The
   * resulting enabled state is the new spec's `enable` field (absent → enabled; explicit
   * false → disabled; overwriting an existing job applies the same rule).
   * Invalid spec → throw, file not written (no last-good; consistent with the whole-rejection semantics).
   */
  async addJob(id: string | undefined, spec: unknown): Promise<string> {
    const idKey = this.assertJobId(id, 'starts with a lowercase letter or digit, may contain hyphens, max 64 characters')
    const v = validateJob(spec, { nowMs: Date.now(), defaultTz: systemTimeZone() })
    if (!v.ok) throw new Error(`spec invalid: ${v.errors.join('; ')}`)
    const jsonFile = this.jobFileOf(idKey)
    let existed = false
    try {
      await fsp.access(jsonFile)
      existed = true
    } catch {
      /* new file */
    }
    await this.writeJsonFile(jsonFile, spec)
    const r = await this.rescan()
    const verb = existed ? 'overwrote' : 'added'
    return `${verb} job ${idKey} (currently ${r.enabled} enabled, ${r.disabled} disabled)`
  }

  /**
   * delete: remove the job file and the state file (equivalent to a manual rm of both files;
   * prevents a same-name rebuild from inheriting stale one-shot marks / next-fire times /
   * lastActivation); the in-memory model (enabled or disabled) is marked deleted and removed
   * from both registries (in-progress runs continue to settle but do not write state or
   * recompute — the audit trail is the session log).
   */
  async deleteJob(id: string | undefined): Promise<string> {
    const idKey = this.assertJobId(id)
    let removedFile = false
    try {
      await fsp.unlink(this.jobFileOf(idKey))
      removedFile = true
    } catch {
      /* not present */
    }
    if (!removedFile) throw new Error(this.jobNotFoundMsg(idKey))
    const model = this.jobs.get(idKey) ?? this.disabledJobs.get(idKey)
    if (model) {
      model.deleted = true // in-progress runs settle but do not write state or recompute
    }
    this.jobs.delete(idKey)
    this.disabledJobs.delete(idKey)
    this.startupMemory.delete(idKey)
    this.rejected.delete(idKey)
    await this.unlinkStateFile(idKey)
    return `deleted job ${idKey} (config + state removed)`
  }

  /**
   * cancel: cancel all in-progress runs of the job (mark cancelled + agent cancel; first-recorded
   * cause wins, see markCancelled). N counts the in-progress runs the verb handles — runs newly
   * marked here plus runs already carrying a pending cause that are left untouched, so a
   * concurrent timeout keeps its failed/timeout attribution.
   */
  cancelJob(id: string | undefined): Promise<string> {
    const idKey = this.assertJobId(id)
    const model = this.jobs.get(idKey) ?? this.disabledJobs.get(idKey)
    if (!model) throw new Error(this.jobNotFoundMsg(idKey))
    // Owned runs only: a recreated same-id job does not cancel a stale generation's runs.
    const active = this.ownedRuns(model)
    if (active.length === 0) return Promise.resolve(`job ${idKey} has no in-progress runs`)
    let n = 0
    for (const run of active) {
      if (run.settled) continue
      n += 1
      this.markCancelled(idKey, run, 'cancel send')
    }
    return Promise.resolve(
      n > 0 ? `cancelled ${n} in-progress run(s) (${idKey}); will be recorded as failed/cancelled` : `job ${idKey} has no in-progress runs`,
    )
  }
}
