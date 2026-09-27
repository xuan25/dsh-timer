// dsh-timer run executor: each run creates a fresh independent session (full inheritance
// from the run session), fires the initial followup, and settles via whenIdle. The create
// call is bounded by CREATE_TIMEOUT_MS (timeout → create_failed + orphan cancel/dispose),
// so a stuck create always settles — the scheduled tick kicks the create off detached
// (never awaits it), so the deadline bounds one create, not the scheduler.
// Note: agent.followup returns void (not a promise; verified against dsh-agent 0.1.5-rc.3) —
// turn_error can only be detected by scanning the session events for turn/end; the edge case
// of no turn/end and no pendingCause falls back to finished (a warn log is emitted here).
// Event reading uses session.snapshotEvents() (the dsh-session public event-log API): the
// snapshot observes every appended event, so settlement does not depend on a live event
// subscription.
// Agent plane of the run session: composed through the host's agent preset service via
// the create call's setup hook — the framework's baseline composition alone carries only
// the host's tool allowlist, so without the mount a run session sees no tools beyond it.
// A job that NAMES a preset resolves it strictly (resolveMountable; unresolvable/broken
// preset or absent service → create_failed: a job file is declarative config, a typo'd
// preset id must not silently degrade). A job WITHOUT a preset mounts the deployment
// default preset, degrading to the baseline composition (a warn) when the host provides
// no service or no usable default.
// Run-session lifecycle: a run session lives exactly one run and is disposed by the
// plugin after settlement (the on-disk session log is the audit trail). The plugin keeps
// no retention mechanism and does not bend this behavior to compensate for framework
// defects observed in other components.
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { AgentHandle, AgentSetup } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { parse as parseYaml } from 'yaml'
import { SUMMARY_LIMIT, type StateRun } from './state.js'
import { PLUGIN_NAME, errMsg } from './util.js'
import type { Context, JobModel, Logger, RunOutcome, RunRecord, RunTrigger } from './types.js'

/** Deployment default root for per-job run working directories; the job schema run.cwd description mirrors this value. */
export const DEFAULT_RUN_CWD_ROOT = '/workspace/timer/runs'

/**
 * Bounded deadline for `ctx.agents.create`: a create that does not resolve within
 * this window settles the run as failed/create_failed ("agent create timed out after Nms") and
 * the late-resolving agent is cancelled + disposed (orphan protection). This is the only
 * escape for a hung create; it bounds one create, never the scheduler (the tick kicks the
 * create off detached and never awaits it).
 */
export const CREATE_TIMEOUT_MS = 300_000

/** Prompt = task + summary convention line. */
export function buildRunPrompt(taskPrompt: string): string {
  return `${taskPrompt}\n\n(This is a ${PLUGIN_NAME} scheduled task run. When the task is done, output a plain-text result summary of 1-5 sentences, and nothing else.)`
}

/**
 * Minimal session event shape (only the fields this module needs; the full SessionEvent union is scanned as unknown).
 * dsh-session nests event payloads under `data`: append(type, data) logs { type, seq, time,
 * data }, and the agent-loop payloads are turn/end → data:{ turn, reason } and
 * assistant/message → data:{ turn, step, message } (verified against dsh-session 0.1.5-rc.3)
 * — the settlement read sites below therefore read event.data.reason / event.data.message,
 * never event.reason / event.message.
 */
interface EventLike {
  type?: unknown
  data?: {
    reason?: unknown
    message?: { content?: unknown } | null
  } | null
}

/** Find the most recent turn/end event, scanning from the tail; null when absent. */
function lastTurnEnd(events: readonly unknown[]): EventLike | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as EventLike | null
    if (e && e.type === 'turn/end') return e
  }
  return null
}

/** Find the most recent non-empty assistant text, scanning from the tail; truncated to the limit; '' when absent. */
function lastAssistantText(events: readonly unknown[], limit: number): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as EventLike | null
    if (e && e.type === 'assistant/message') {
      let text = ''
      const content = e.data?.message?.content
      if (Array.isArray(content)) {
        for (const part of content) {
          const p = part as { type?: unknown; text?: unknown } | null
          if (p && p.type === 'text' && typeof p.text === 'string') text += p.text
        }
      }
      text = text.trim()
      if (text) return text.length > limit ? text.slice(0, limit) : text
    }
  }
  return ''
}

/** Normalize a turn/end reason: strings are used as-is; objects take .reason / .kind; anything else → 'error'. */
function reasonKind(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object') {
    const r = reason as { reason?: unknown; kind?: unknown }
    if (typeof r.reason === 'string') return r.reason
    if (typeof r.kind === 'string') return r.kind
  }
  return 'error'
}

/** turn/end event → settlement mapping (run settlement matrix). */
function settleFromTurnEnd(
  endEvent: EventLike | null,
  run: RunRecord,
): { status: 'finished' | 'failed'; cause: string | null } {
  const kind = reasonKind(endEvent?.data?.reason)
  if (kind === 'completed' || kind === 'blocked' || kind === 'max-tokens') return { status: 'finished', cause: null }
  if (kind === 'error') return { status: 'failed', cause: 'turn_error' }
  if (kind === 'aborted') return { status: 'failed', cause: run.pendingCause ?? 'cancelled' }
  if (kind === 'interrupted') return { status: 'failed', cause: 'interrupted' }
  return { status: 'failed', cause: run.pendingCause ?? 'turn_error' }
}

/**
 * Settings-document namespace holding the deployment's default model selection — the
 * canonical store the framework's agent-default-model service is built on. The literal
 * mirrors the constant the owning package exports; the package is spelled out locally
 * because it is not a dependency of this plugin.
 */
export const DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'

/** A deployment-pinned default model route: both fields non-empty strings. */
interface DefaultModelSelection {
  provider: string
  model: string
}

/** Validate a candidate default selection: valid only when both fields are non-empty strings. */
function normalizeDefaultSelection(value: unknown): DefaultModelSelection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as { provider?: unknown; model?: unknown }
  if (typeof v.provider !== 'string' || v.provider === '') return undefined
  if (typeof v.model !== 'string' || v.model === '') return undefined
  return { provider: v.provider, model: v.model }
}

/**
 * Read the deployment's default model selection, trying three SOFT sources in order —
 * none of them is a required inject, so a host providing none of them simply has no
 * default route (no error is raised by this read):
 *  1. the framework's agent-default-model service, when the host provides it — read via
 *     `ctx.get` (cordis' non-strict service read: it returns undefined for a service the
 *     host does not provide, unlike a direct property access which throws
 *     `cannot get property ... without inject`);
 *  2. the settings service's section under the default-model namespace, when the host
 *     provides the settings document but not the service;
 *  3. the raw settings document file at the harness home (`settings.yaml`), the same
 *     file both sources above are built on — read at run creation, so edits to the file
 *     are picked up by the next run.
 * Any source failure (missing file, unparseable YAML, malformed section) degrades to
 * "no source": a route-less run then settles with the framework's own no-provider/model
 * rejection surfaced in the run record (see turnErrorMessage).
 */
export async function readDefaultModelSelection(ctx: Context): Promise<DefaultModelSelection | undefined> {
  const get = ctx.get
  if (typeof get === 'function') {
    const service = get('agentDefaultModel') as { currentSelection?: () => unknown } | undefined
    const fromService = normalizeDefaultSelection(service?.currentSelection?.())
    if (fromService) return fromService
    const settings = get('settings') as { section?: (ns: string) => unknown } | undefined
    const fromSettings = normalizeDefaultSelection(settings?.section?.(DEFAULT_MODEL_SETTINGS_NAMESPACE))
    if (fromSettings) return fromSettings
  }
  if (typeof ctx.dshHomePath !== 'function') return undefined
  try {
    const doc = parseYaml(await readFile(ctx.dshHomePath('settings.yaml'), 'utf8')) as unknown
    return normalizeDefaultSelection((doc as { [ns: string]: unknown } | null)?.[DEFAULT_MODEL_SETTINGS_NAMESPACE])
  } catch {
    return undefined
  }
}

/**
 * The host's agent preset service (dsh-agent-presets): the agent-plane composition source
 * (persona / instructions / the full tool roster). Accessed through cordis' non-strict
 * `ctx.get` exactly like the default-model sources above — a host without the service
 * (or an out-of-product host) simply gets the baseline composition for preset-less runs.
 * Structural surface only: dsh-agent-presets is not a dependency of this plugin.
 */
interface PresetService {
  /** Deployment default when id is omitted; rejects for an unknown preset id. */
  resolve(id?: string): Promise<{ id: string }>
  /** Like resolve, additionally rejecting a preset that exists but fails composition validation. */
  resolveMountable?(id?: string): Promise<{ id: string }>
  /** Plug the preset's agent-plane composition into the unpublished agent scope (the create's setup hook). */
  mount(agentCtx: Context, id: string): Promise<void>
}

/** The host's agent preset service, or undefined when the host provides none. */
function getPresetsService(ctx: Context): PresetService | undefined {
  const get = ctx.get
  if (typeof get !== 'function') return undefined
  try {
    const service = get('agentPresets')
    return service === undefined || service === null ? undefined : (service as PresetService)
  } catch {
    return undefined
  }
}

/**
 * Model route for the run session. The framework requires an explicit provider/model
 * pair for headless sessions: a turn whose route is incomplete rejects at the first
 * request and the run settles failed/turn_error. Resolution order:
 *  1. `run.model` containing "/" → the prefix before the first slash is the provider,
 *     the remainder the model id (a model id that itself contains a slash must include
 *     the provider prefix). This branch never touches any host service — an explicit
 *     route works on every host, even one providing no default-model source at all.
 *  2. `run.model` without "/" → that model id on the deployment's default provider,
 *     from readDefaultModelSelection.
 *  3. no `run.model` → the deployment's default selection (provider + model) from
 *     readDefaultModelSelection, the same route the framework's own headless runner
 *     applies.
 *  4. neither → no route is passed; the first turn fails and the turn/end error message
 *     is surfaced in the run record (see turnErrorMessage).
 * The reasoning effort follows the selected provider/model's own default (the headless
 * convention).
 */
async function resolveAgentOptions(
  ctx: Context,
  model: string | null | undefined,
): Promise<{ provider?: string; model?: string }> {
  const out: { provider?: string; model?: string } = {}
  if (model) {
    const slash = model.indexOf('/')
    if (slash > 0) {
      out.provider = model.slice(0, slash)
      out.model = model.slice(slash + 1)
      return out
    }
    const selection = await readDefaultModelSelection(ctx)
    if (selection) out.provider = selection.provider
    out.model = model
    return out
  }
  const selection = await readDefaultModelSelection(ctx)
  if (selection) {
    out.provider = selection.provider
    out.model = selection.model
  }
  return out
}

/**
 * The framework's error message from a turn/end reason payload: the error kind carries
 * `error: { message, code }`. Returns '' when the payload carries none (string reasons,
 * or an error object without a message) so callers can fall back to null.
 */
function turnErrorMessage(reason: unknown): string {
  if (!reason || typeof reason !== 'object') return ''
  const error = (reason as { error?: unknown }).error
  if (!error || typeof error !== 'object') return ''
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : ''
}

export interface StartRunParams {
  ctx: Context
  logger: Logger
  model: JobModel
  run: RunRecord
  /** Callback after the run starts (the scheduler records lastActivation + the state file running entry). */
  onRunStart: (model: JobModel, run: RunRecord, record: StateRun) => void
  /** Callback after the run settles (scheduler state file finalization + recomputeRunEnd). */
  onRunEnd: (model: JobModel, run: RunRecord, outcome: RunOutcome) => void
}

export type StartRunResult = { ok: true } | { ok: false; error: string }

/**
 * Start one run. The run is registered in state before the session is created (lastActivation =
 * run start moment, persisted immediately, so a create failure cannot open a double-fire window
 * for onActiveSec); create failure → failed/create_failed (the fire is already consumed:
 * cron re-arms from the actual trigger moment, ISO is treated as consumed → no retry storm).
 * Run-cwd creation failure fails the run immediately the same way (no session is created).
 * Agent preset resolution is part of the same create-failure surface: an
 * unavailable job-named preset — or the host's absent agent-presets service — fails the
 * run create_failed before any session is created.
 * The create call is bounded by CREATE_TIMEOUT_MS: a create that does not resolve in time
 * settles the run as failed/create_failed ("agent create timed out after Nms"), and the
 * late-resolving agent is cancelled + disposed (orphan protection), so a stuck create
 * always settles — the scheduled tick kicks startRun off detached (fire-and-forget; it
 * never awaits the create), while the manual path awaits the result. A create that
 * REJECTS (missing agent
 * factory, or the factory's own setup failure) settles the run identically ("agent create
 * failed: <reason>"): the create API is async, so its failure surface is a promise
 * rejection — caught in the race's onRejected branch, exactly like the timeout. startRun
 * itself never rejects for a create failure; every failure mode returns { ok: false }
 * through failCreate.
 * A stop requested while the session is being created (handle not yet assigned, the tick's
 * cancel was a no-op) is delivered to the just-created agent so the settlement records a
 * truthful failed/cancelled.
 */
export async function startRun({ ctx, logger, model, run, onRunStart, onRunEnd }: StartRunParams): Promise<StartRunResult> {
  const spec = model.spec.run
  const cwd = spec.cwd || `${DEFAULT_RUN_CWD_ROOT}/${model.id}/`

  const record0: StateRun = {
    runId: run.runId,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    status: 'running',
    cause: null,
    finishedAt: null,
    durationMs: null,
    summary: null,
    trigger: run.trigger,
  }
  onRunStart(model, run, record0)

  const failCreate = (error: string): StartRunResult => {
    run.settled = true
    run.status = 'failed'
    run.cause = 'create_failed'
    run.finishedAt = Date.now()
    onRunEnd(model, run, {
      status: 'failed',
      cause: 'create_failed',
      finishedAt: run.finishedAt,
      summary: '',
      error,
    })
    return { ok: false, error }
  }

  try {
    mkdirSync(cwd, { recursive: true })
  } catch (err) {
    // Run-cwd creation failure = immediate run failure: no session is created, the run
    // settles as failed/create_failed right after registration.
    return failCreate(`failed to create run directory ${cwd}: ${errMsg(err)}`)
  }

  const meta: { cwd: string; agentPreset?: string } = { cwd }
  const agentOptions = await resolveAgentOptions(ctx, spec.model)
  // Agent-plane composition: the framework's baseline composition carries only the host's
  // tool allowlist; the full agent plane is mounted through the host's agent preset
  // service via the create call's setup hook. The setup hook awaits mount and returns
  // void: the agent loop awaits the setup result and calls ?.commit() on it
  // (AgentSetupCommit | void), while mount returns its standing-mount record, not a
  // commit — leaking that return value crashes create with
  // "(intermediate value)?.commit is not a function".
  // A job that NAMES a preset is declarative
  // config: an unresolvable or broken preset (or an absent service) fails the run
  // create_failed, because silently falling back would hide a typo'd preset id. A job
  // WITHOUT a preset mounts the deployment default preset; an absent service or an
  // unavailable default degrades to the baseline composition (a warn), never failing
  // every preset-less job.
  const presets = getPresetsService(ctx)
  let setup: AgentSetup | undefined
  if (spec.preset) {
    if (presets === undefined) {
      return failCreate(`agent preset "${spec.preset}" is set but the host provides no agent preset service`)
    }
    try {
      const resolved = presets.resolveMountable
        ? await presets.resolveMountable(spec.preset)
        : await presets.resolve(spec.preset)
      meta.agentPreset = resolved.id
      setup = async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id)
      }
    } catch (err) {
      return failCreate(`agent preset "${spec.preset}" is unavailable: ${errMsg(err)}`)
    }
  } else if (presets !== undefined) {
    try {
      const resolved = await presets.resolve()
      meta.agentPreset = resolved.id
      setup = async (agentCtx) => {
        await presets.mount(agentCtx, resolved.id)
      }
    } catch (err) {
      logger.warn(`job=${model.id} no usable default agent preset (${errMsg(err)}); continuing with the baseline composition`)
    }
  }
  // SessionId is a type-level brand (Branded<'SessionId'>); at runtime it is just a string,
  // matching the JS version's behavior. ctx.agents.create is async: every create failure
  // (missing factory, setup failure) surfaces as a rejection of the returned promise and can
  // never throw synchronously — so no try/catch wraps the call. The rejection is settled in
  // the race's onRejected branch below (failCreate, exactly like a timeout).
  const createPromise = ctx.agents.create({
    sessionId: run.sessionId as SessionId,
    meta,
    ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
    ...(setup ? { setup } : {}),
  })

  // Bounded create: the deadline is armed on the cordis timer service (fiber-aware) and the
  // run proceeds with whichever of create / deadline settles first.
  let deadlineDispose: (() => void) | null = null
  let deadlineDisposed = false
  const disarmDeadline = (): void => {
    if (deadlineDisposed || deadlineDispose === null) return
    deadlineDisposed = true
    try {
      deadlineDispose()
    } catch {
      /* timer already fired */
    }
  }
  const deadlineSignal = new Promise<{ timedOut: true }>((resolve) => {
    deadlineDispose = ctx.timeout(() => {
      resolve({ timedOut: true })
      // Orphan protection: a create that resolves after the deadline would leave an untracked
      // in-flight session; cancel it and dispose it instead.
      void createPromise.then(
        (late) => {
          try {
            late.agent.cancel({ kind: 'user' })
          } catch {
            /* agent gone already */
          }
          void late.dispose().catch(() => {
            /* already disposed */
          })
        },
        () => {
          /* create rejected after the deadline: nothing to dispose */
        },
      )
    }, CREATE_TIMEOUT_MS)
  })

  const createResult = await Promise.race([
    createPromise.then(
      (handle): { timedOut: false; handle: AgentHandle } => ({ timedOut: false, handle }),
      (err): { failed: string } => ({ failed: errMsg(err) }),
    ),
    deadlineSignal,
  ])
  disarmDeadline()
  if ('failed' in createResult) {
    // A rejected create (missing agent factory, or the factory's own setup failure) settles
    // the run exactly like a timeout: failed/create_failed. No session is left behind — a
    // rejected create has no agent to dispose (the deadline branch's orphan protection only
    // covers a create that RESOLVES after the deadline).
    return failCreate(`agent create failed: ${createResult.failed}`)
  }
  if (createResult.timedOut) {
    return failCreate(`agent create timed out after ${CREATE_TIMEOUT_MS}ms`)
  }
  const created = createResult.handle

  run.handle = created
  if (run.pendingCause === 'cancelled' || run.pendingCause === 'interrupted') {
    // A stop (user/overlap stop) or a process-exit interrupt was requested while the session was
    // being created: deliver it to the just-created turn so the settlement is truthful (the
    // scheduler's cancel could not reach an unassigned handle).
    try {
      created.agent.cancel({ kind: 'user' })
    } catch (err) {
      logger.warn(`job=${model.id} failed to send late stop cancel: ${errMsg(err)}`)
    }
  }
  if (spec.policy) {
    try {
      setSandboxMode(created.agent.session, spec.policy)
    } catch (err) {
      logger.warn(`job=${model.id} failed to set policy (${errMsg(err)}); continuing with the default policy`)
    }
  }

  if (model.runtimeMaxMs !== null && model.runtimeMaxMs > 0) {
    // The max run duration uses the cordis timer service. The effect is registered on the
    // timer service's own fiber, so neither run settlement nor package dispose reclaims it
    // automatically; it is cancelled by the explicit run.maxTimer() dispose at run end.
    run.maxTimer = ctx.timeout(() => {
      if (run.settled) return
      run.pendingCause = 'timeout'
      try {
        created.agent.cancel({ kind: 'user' })
      } catch (err) {
        logger.warn(`job=${model.id} failed to send timeout cancel: ${errMsg(err)}`)
      }
    }, model.runtimeMaxMs)
  }

  const msg = createUserMessage({
    content: [{ type: 'text', text: buildRunPrompt(spec.prompt) }],
    source: { kind: 'user' },
  })
  let p: unknown
  try {
    p = created.agent.followup(msg)
  } catch (err) {
    run.followupError = errMsg(err)
  }
  if (p && typeof (p as { catch?: unknown }).catch === 'function') {
    ;(p as { catch: (fn: (err: unknown) => void) => void }).catch((err) => {
      if (!run.settled) run.followupError = errMsg(err)
    })
  }

  void (async () => {
    try {
      await created.agent.whenIdle()
    } catch {
      /* whenIdle is not expected to reject; ignore */
    }
    if (run.settled) return
    run.settled = true
    try {
      if (run.maxTimer) {
        try {
          run.maxTimer()
        } catch {
          /* timer already disposed */
        }
        run.maxTimer = null
      }
      run.finishedAt = Date.now()
      let events: readonly unknown[] = []
      try {
        // Public API reading the full event log (including turn/end and assistant messages).
        events = created.agent.session.snapshotEvents()
      } catch {
        events = []
      }
      const endEvent = lastTurnEnd(events)
      let outcome: { status: 'finished' | 'failed'; cause: string | null }
      if (
        run.pendingCause === 'timeout' ||
        run.pendingCause === 'cancelled' ||
        run.pendingCause === 'interrupted'
      ) {
        outcome = { status: 'failed', cause: run.pendingCause }
      } else if (endEvent) {
        outcome = settleFromTurnEnd(endEvent, run)
      } else if (run.followupError) {
        outcome = { status: 'failed', cause: 'turn_error' }
      } else {
        logger.warn(`job=${model.id} run ended without a turn/end event; falling back to finished`)
        outcome = { status: 'finished', cause: null }
      }
      let summary = ''
      try {
        summary = lastAssistantText(events, SUMMARY_LIMIT)
      } catch {
        summary = ''
      }
      run.status = outcome.status
      run.cause = outcome.cause
      try {
        await created.dispose()
      } catch {
        /* already disposed */
      }
      onRunEnd(model, run, {
        ...outcome,
        finishedAt: run.finishedAt,
        summary,
        error:
          run.pendingCause === 'timeout'
            ? `runtimeMaxSec=${model.runtimeMaxMs}ms timed out`
            : outcome.cause === 'interrupted'
              ? 'interrupted by process restart'
              : run.followupError ??
                (outcome.cause === 'turn_error'
                  ? turnErrorMessage(endEvent?.data?.reason) || null
                  : null),
      })
    } catch (err) {
      // Defensive: the settlement body above is expected never to throw; if it does (an event
      // parsing or bookkeeping defect), log it and settle the run as failed/turn_error so the
      // state record still reaches a terminal state and the throw does not escape the detached
      // promise as an unhandled rejection (Node default: the host process would crash). The
      // degraded onRunEnd call is guarded again: if even it throws, the state record stays in
      // place and the next process start's startup backfill crash net settles it.
      logger.error(`job=${model.id} run settlement threw: ${errMsg(err)}`)
      run.status = 'failed'
      run.cause = 'turn_error'
      if (run.finishedAt === 0) run.finishedAt = Date.now()
      try {
        await created.dispose()
      } catch {
        /* already disposed */
      }
      try {
        onRunEnd(model, run, {
          status: 'failed',
          cause: 'turn_error',
          finishedAt: run.finishedAt,
          summary: '',
          error: `settlement failed: ${errMsg(err)}`,
        })
      } catch (err2) {
        logger.error(`job=${model.id} degraded settlement also failed: ${errMsg(err2)}`)
      }
    }
  })()

  return { ok: true }
}

/**
 * Create a new (not yet started) run record object.
 * @param params.jobId job id.
 * @param params.sessionId session id (default: random UUID).
 * @param params.trigger trigger source (scheduled/monotonic/startup/manual).
 * @param params.startedAt start moment (default Date.now()).
 */
export function newRunRecord(params: {
  jobId: string
  sessionId?: string
  trigger: RunTrigger
  startedAt?: number
}): RunRecord {
  return {
    jobId: params.jobId,
    sessionId: params.sessionId ?? randomUUID(),
    startedAt: params.startedAt ?? Date.now(),
    trigger: params.trigger,
    runId: randomUUID(),
    finishedAt: 0,
    status: null,
    cause: null,
    pendingCause: null,
    followupError: null,
    handle: null,
    maxTimer: null,
    settled: false,
    model: null,
  }
}
