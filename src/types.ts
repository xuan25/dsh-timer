// dsh-timer shared types: cross-module contracts for job specs, job models, and run
// records.
// This file imports types only (zero runtime dependencies) and centralizes the framework
// type wiring: cordis Context, the cordis-plugin-timer Context augmentation
// (ctx.timeout / ctx.interval, always present because the host loads that plugin),
// and the dsh-agent AgentHandle.
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { Context, Logger } from '@deepseek-ai/cordis'
// The cordis-plugin-timer Context augmentation is activated by ./timer-augment.d.ts
// (side-effect import in a .d.ts file, erased at runtime).
import type { CalendarCondition } from './cron.js'
import type { JobState } from './state.js'

export type { Context }

/**
 * Job run block (`run`).
 * `policy` = per-session file-policy override (dsh-sandbox-policy `setSandboxMode`);
 * the literals exactly match dsh-sandbox's `SandboxMode`, declared here as literal
 * aliases to avoid a direct dsh-sandbox dependency. Absent = deployment default policy.
 */
export type Policy = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface RunSpec {
  /** Required: body of the first user message of the run session (wrapped by the plugin into a scheduled-run instruction); a whitespace-only prompt is rejected. */
  prompt: string
  /** Working directory of the run session; default `/workspace/timer/runs/<jobId>/`; `null` = explicitly unset (same as omitting the field). */
  cwd?: string | null
  /** Session preset (CreateAgentOptions.meta.agentPreset); `null` = explicitly unset. */
  preset?: string | null
  /** Model route of the run session: a model id, or `provider/model` (first slash splits provider from model). Absent = the deployment's default model selection when a source provides it (the host's agent-default-model service, or the settings section/document that service is built on); without a resolvable selection the first turn fails with the framework's no-provider/model error (surfaced in the run record). `null` = explicitly unset. */
  model?: string | null
  /** Per-session file-policy override; absent or `null` = deployment default. */
  policy?: Policy | null
}

/** Job spec (validated shape of the job file JSON; the raw unvalidated input type is `unknown`). */
export interface JobSpec {
  /** Enabled flag: absent or true = enabled (in the trigger table); false = disabled (kept in the
   * in-process disabled registry, not scheduled, still manually runnable). */
  enable?: boolean
  /** Trigger 1: array of cron or full-ISO strings (mixing cron and ISO is valid). */
  onCalendar?: string[]
  /** Trigger 2: positive time span (e.g. "30s" / "5min"). */
  onActiveSec?: string
  /** Trigger 3: positive time span; fires at most once per process lifetime (in-memory flag). */
  onStartupSec?: string
  /** IANA timezone name; absent = system timezone. */
  timeZone?: string
  /** persistent = single catch-up after a missed start (rebased to now; no per-fire catch-up). */
  persistent?: boolean
  /** onCalendar only: when true, a condition that starts a run is suspended for the duration of
   * that run (its due moments are skipped without advancing the phase) and re-armed from the run
   * end moment; false (default) = the phase advances at every due moment even while a run is in
   * progress (a due moment under overlap=skip is consumed in place, no catch-up fire). */
  deferReactivation?: boolean
  /** null / "0" / "infinity" / positive time span (all = no limit; non-string values are rejected). */
  runtimeMaxSec?: string | null
  /** Overlap policy: skip (default) = a due trigger while a run is in progress is consumed
   * (skipped and consumed in place: the phase advances at the due moment, no catch-up fire —
   * a run longer than the interval swallows grid points, the condition's scheduled trigger
   * instants); stop = cancel the running run then start a new one; allow = run in parallel. */
  overlap?: 'skip' | 'stop' | 'allow'
  run: RunSpec
}

/** Scheduling state of an onCalendar condition (embedded in the job model; mirrored to the state file). */
export interface CalCond {
  /** Condition value string (= state file key). */
  key: string
  /** The condition itself (parsed cron / ISO). */
  cal: CalendarCondition
  /** No future match (accepted and flagged, not rejected). */
  neverMatch: boolean
  /** ISO condition already fired in this process (consumed). */
  consumed: boolean
  /** Next trigger moment (tick due-check: nextFireMs <= nowMs && !neverMatch && !consumed). */
  nextFireMs: number | null
}

/** In-process record of one job run (persisted to the state file runs array on settlement). */
export interface RunRecord {
  jobId: string
  sessionId: string
  trigger: RunTrigger
  /** Run start moment (= lastActivation; system clock, comparable across timezone switches). */
  startedAt: number
  /** Unique run id (key of the state file runs entry). */
  runId: string
  finishedAt: number
  status: RunStatus | null
  /** finished → null; failed → timeout/cancelled/interrupted/create_failed/turn_error/… */
  cause: string | null
  /** Pending settlement cause for an in-flight run (timeout / cancelled / interrupted). */
  pendingCause: 'timeout' | 'cancelled' | 'interrupted' | null
  /** followup delivery failure reason (settlement fallback). */
  followupError: string | null
  /** Handle of the created run session (null when create failed). */
  handle: AgentHandle | null
  /** runtimeMaxSec timer cancel handle (cordis timer service). */
  maxTimer: (() => void) | null
  /** Whether the run has settled (later events are ignored after settlement). */
  settled: boolean
  /** Owing job model (written by the scheduler; disabled-state manual runs use the in-memory disabled registry model directly). */
  model: JobModel | null
}

export type RunTrigger = 'scheduled' | 'monotonic' | 'startup' | 'manual'
export type RunStatus = 'finished' | 'failed'

/** Run settlement outcome (onRunEnd input). */
export interface RunOutcome {
  status: RunStatus
  cause: string | null
  finishedAt: number
  /** Last assistant text (truncated to SUMMARY_LIMIT). */
  summary: string
  /** Failure note (e.g. timeout message / followup error). */
  error: string | null
}

/** Job model: the in-process live object for one job file (hot-updated on rescan; the model object keeps the same address). */
export interface JobModel {
  id: string
  /** Validated spec (the raw object returned by validateJob, typed as JobSpec). */
  spec: JobSpec
  /** Validation success result that created this model (includes the calendar condition objects). */
  valid: ValidateSuccess
  /** Effective timezone (job-level timeZone or system timezone; updated when the system timezone changes). */
  tz: string
  persistent: boolean
  defer: boolean
  overlap: 'skip' | 'stop' | 'allow'
  /** Max run duration (ms); null = unlimited ("0" / "infinity" / unset). */
  runtimeMaxMs: number | null
  /** onActiveSec span (ms); null = unset. */
  monotonicSpanMs: number | null
  /** onStartupSec span (ms); null = unset. */
  startupSpanMs: number | null
  /** onStartupSec already fired in this process (kept across disable→enable). */
  startupConsumed: boolean
  /** onCalendar condition set (same elements as valid.calendars). */
  calendars: CalCond[]
  /** Persisted state (in-memory mirror of state/<jobId>.json). */
  state: JobState
  /** State-write failure note (shown in status). */
  stateNote: string | null
  /** Deletion flag: run finalization skips state writes and recomputation. */
  deleted: boolean
}

/** Rescan result summary. */
export interface RescanSummary {
  added: number
  enabled: number
  disabled: number
  rejected: number
}

/** TimerScheduler constructor options (injected during plugin apply). */
export interface SchedulerOptions {
  ctx: Context
  logger: Logger
  jobsDir: string
}

/** cordis Logger facade (return type of ctx.logger()). */
export type { Logger } from '@deepseek-ai/cordis'

// ── validateJob results (discriminated union: ok distinguishes success/failure) ──

/** Validation success: carries normalized scheduling parameters and calendar condition objects. */
export interface ValidateSuccess {
  ok: true
  errors: []
  /** Original validated spec object (file key order preserved; the rescan hot-update comparison
   * is order-independent via util.canonicalJson, so key order is not load-bearing). */
  spec: JobSpec
  /** Effective timezone (job-level timeZone or defaultTz). */
  tz: string
  persistent: boolean
  defer: boolean
  /** Default 'skip'. */
  overlap: 'skip' | 'stop' | 'allow'
  /** "0" / "infinity" / unset → null; invalid input never reaches this branch. */
  runtimeMaxMs: number | null
  /** onActiveSec span (ms); unset → null. */
  onUnitActiveSecMs: number | null
  /** onStartupSec span (ms); unset → null. */
  onStartupSecMs: number | null
  calendars: CalendarCondition[]
  /** List of neverMatch condition values (accepted and flagged). */
  neverMatch: string[]
}

/** Validation failure: the whole spec is rejected (no last-good fallback). */
export interface ValidateFailure {
  ok: false
  errors: string[]
}

export type ValidateResult = ValidateSuccess | ValidateFailure
