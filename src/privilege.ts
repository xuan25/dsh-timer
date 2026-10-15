// dsh-timer privilege checks: policy monotonicity, the run-root scope rule, the
// approval-channel escalation, and the run.cwd caller-root rule. Pure logic with the
// framework seams kept as minimal structural interfaces - no dsh-* imports, so the module
// stays testable in the zero-framework selftest.
//
// Threat model: the tool handler runs with the plugin process's file authority (it writes
// job files outside the caller session's sandbox root), so the caller's own file policy
// must gate what job policies it may create or act on, or a low-privilege session could
// persistently install higher-privilege run sessions. The scope rule adds the second
// axis: a job's run root is its control domain, and a session outside that domain must
// not manage the job (rewrite, stop, or delete it) - not even at the same policy level -
// or sibling scopes could interfere with each other's jobs, system-critical ones included.
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { Policy } from './types.js'

/** Closed approval outcomes, mirroring the dsh-user-approval ApprovalOutcome vocabulary. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * The approval service face consumed through cordis' non-strict `ctx.get('approval')`
 * accessor (the dsh-user-approval package composes the real service; a host without it
 * yields undefined and the check fails closed). Declared structurally so the plugin gains
 * no new dependency.
 */
export interface ApprovalSeam {
  request(req: {
    readonly agent: unknown
    readonly toolName: string
    readonly callId?: unknown
    readonly reason?: string
    readonly displayReason?: { readonly en: string; readonly [locale: string]: string }
    readonly signal?: AbortSignal
  }): Promise<ApprovalOutcome>
}

/**
 * Runtime agent face as it appears in a tool execution: the public Agent interface carries
 * only the id; the runtime aspect (dsh-agent) carries the live session behind it, whose
 * header holds the session cwd.
 */
export interface RuntimeAgentFace {
  readonly session: { readonly header: { readonly cwd?: string } }
}

/**
 * Caller identity for the privilege checks, derived once per tool call by the tool handler
 * from the execution context (deriveCallerContext in tool.ts).
 */
export interface CallerContext {
  /** Whether the host composes the sandbox-policy service (read through the non-strict ctx.get accessor). Hosts without a policy world have nothing to enforce against, so every check is skipped there. */
  readonly hasPolicyWorld: boolean
  /** The caller session's effective policy (its override ?? the deployment default). null = caller unknown (agent-less call): ranked as the minimum, read-only, with no approval routing. */
  readonly policy: Policy | null
  /** The deployment default policy (the sandbox-policy service's defaultMode); null = no policy world. */
  readonly defaultMode: Policy | null
  /** The caller session's absolute cwd (SessionHeader.cwd); null = unknown - no anchor for the run.cwd rule. */
  readonly cwd: string | null
  /** The runtime agent face (the approval routing target); null = no routing target. */
  readonly agent: RuntimeAgentFace | null
  /** The approval service from ctx.get('approval'); null = the host composes none. */
  readonly approval: ApprovalSeam | null
  /** The tool call id (approval audit pairing). */
  readonly callId?: string
  /** The tool call's abort signal (cancellation lifetime of the approval request). */
  readonly signal?: AbortSignal
}

/** Monotone file-access policy ranks (dsh-sandbox-policy SandboxMode). */
export const POLICY_RANK: Readonly<Record<Policy, number>> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}

/** Map a rank back to its policy name (for error and approval messages). */
export function policyOfRank(rank: number): Policy {
  if (rank >= POLICY_RANK['danger-full-access']) return 'danger-full-access'
  if (rank >= POLICY_RANK['workspace-write']) return 'workspace-write'
  return 'read-only'
}

/** The explicit run.cwd of a spec (string only; omitted or null = inherited from the creating session's workspace at add time and persisted into the job file). */
export function specRunCwd(spec: unknown): string | null | undefined {
  const run = (spec as { run?: { cwd?: unknown } } | null)?.run
  const cwd = run?.cwd
  return typeof cwd === 'string' ? cwd : cwd === null ? null : undefined
}

/** The policy literals a spec pins on its run block; undefined = the spec leaves it to the deployment default. */
export function specRunPolicy(spec: unknown): Policy | undefined {
  const run = (spec as { run?: { policy?: unknown } } | null)?.run
  const policy = run?.policy
  return policy === 'read-only' || policy === 'workspace-write' || policy === 'danger-full-access' ? policy : undefined
}

/**
 * The effective policy a spec would give its runs: the spec's explicit policy, else the
 * deployment default of the caller's policy world; null = no policy world to resolve against.
 */
export function effectiveJobPolicy(spec: unknown, caller: CallerContext | undefined): Policy | null {
  if (!caller || !caller.hasPolicyWorld || caller.defaultMode === null) return null
  const pinned = specRunPolicy(spec)
  return pinned === undefined ? caller.defaultMode : pinned
}

/** The effective policy of an in-memory job model; null = no policy world to resolve against. */
export function modelJobPolicy(model: { spec: { run?: { policy?: Policy | null } } }, caller: CallerContext | undefined): Policy | null {
  if (!caller || !caller.hasPolicyWorld || caller.defaultMode === null) return null
  return model.spec.run?.policy ?? caller.defaultMode
}

/**
 * The run root a job is created with when its spec omits run.cwd: the creating
 * session's workspace itself, persisted into the job file so the stored spec is
 * self-describing. A creating session without a cwd yields null and the add is
 * refused locally (set run.cwd explicitly).
 */
export function inheritRunRoot(callerCwd: string | null): string | null {
  return callerCwd
}

/**
 * The job's effective run root: the spec's explicit run cwd, or - for a spec that leaves
 * it unset - null, so the root is undetermined and fails closed. The same derivation the runner uses for the run
 * session's cwd. The run root is the job's control scope under the scope rule - and,
 * because the runner creates the run session with this root as its session cwd, the very
 * property that lets a job's own run session manage itself; jobs created from a
 * different session carry a different workspace root and stay outside its scope.
 */
export function runRootOfSpec(spec: unknown): string | null {
  const cwd = specRunCwd(spec)
  if (typeof cwd === 'string') return cwd
  return null
}

/**
 * One privilege check for a verb the caller is about to perform.
 * - `verb` / `jobId`: naming for the messages.
 * - `jobPolicy`: the level the verb acts on - the resulting policy for add; the MAX of the
 *   existing job's level and the resulting level for update (a lower-level session may not
 *   touch a higher-level job at all, not even to demote or rewrite it); the job's existing
 *   level for enable / disable / run / cancel / delete.
 * - `runCwd`: the new spec's explicit run cwd (add / update only).
 * - `runRoot`: the job's effective run root for the management verbs (update / enable /
 *   disable / run / cancel / delete): its run cwd - the job's control scope under the
 *   scope rule. null = the run root could not be determined (the spec omits run cwd, or
 *   it could not be read) and fails closed as outside every scope. Absent for add,
 *   which carries no scope axis.
 */
export interface PrivilegeCheck {
  readonly verb: 'add' | 'update' | 'enable' | 'disable' | 'run' | 'delete' | 'cancel'
  readonly jobId: string
  readonly jobPolicy: Policy | null
  readonly runCwd?: string | null
  readonly runRoot?: string | null
}

/**
 * Run-root scope verdict for a management verb: the job's effective run root must sit at
 * or under the caller session's cwd (canonicalized on both sides, so a symlink under the
 * caller root cannot point outside it). A job's own run session is exempt by
 * construction: the runner creates the run session with the job's run root as its session
 * cwd, so every job manages itself freely; a job of a different workspace root stays out
 * of its scope.
 * Fail closed: a caller without a known cwd - or a job whose run root could not be
 * determined - cannot be verified in scope, and is treated as outside.
 */
type ScopeVerdict =
  | { kind: 'in' }
  | { kind: 'outside'; target: string; root: string }
  | { kind: 'no-anchor'; target: string }
  | { kind: 'unknown-root' }

function scopeVerdict(caller: CallerContext, check: PrivilegeCheck): ScopeVerdict {
  if (check.runRoot === undefined) return { kind: 'in' } // add: governed by the new spec's runCwd rule
  if (check.runRoot === null) return { kind: 'unknown-root' }
  const target = canonicalize(check.runRoot)
  if (caller.cwd === null) return { kind: 'no-anchor', target }
  const root = canonicalize(caller.cwd)
  if (target === root || target.startsWith(root + path.sep)) return { kind: 'in' }
  return { kind: 'outside', target, root }
}

/**
 * Policy monotonicity + the run-root scope rule + the approval-channel escalation + the
 * run.cwd caller-root rule.
 *
 * Two axes gate a job-acting verb, both escalating through the same approval channel (a
 * one-shot human decision per operation, mirroring the framework's own service-tool
 * pattern; no approval service, no agent context, a rejected or cancelled answer, or an
 * unavailable answerer all fail closed with a distinct message; one approval covers a
 * level gap and a scope breach together):
 * - the level axis: the job's level above the caller's level (a gap). A full-access
 *   caller can never be below a job, so it is exempt from this axis by construction.
 * - the scope axis: the job's effective run root outside the caller session's cwd. A
 *   caller below danger-full-access may not manage (update / enable / disable / run /
 *   cancel / delete) a job whose runs write outside its own root; add carries no scope
 *   axis (its control surface is the new spec's runCwd rule below). A full-access caller
 *   is exempt from the scope axis too: it is not subject to cwd constraints. A job's own
 *   run session is exempt by construction: its session cwd is the job's run root.
 *
 * When the operation proceeds WITHOUT escalation, from a caller below danger-full-access,
 * the run.cwd caller-root rule still applies: an explicit run.cwd in the new spec (add /
 * update) must sit at or under the caller session's own cwd. Omitted or null cwd never
 * reaches this rule: at add time it is inherited from the creating session's workspace
 * (materialized into the job file before the check), and at update time it keeps the
 * job's existing run root - so the rule below only sees cwd values the caller actually
 * chose. An approved operation lifts the rule: the human saw the cwd in the approval
 * question.
 */
export async function checkCallerPrivilege(
  caller: CallerContext | undefined,
  check: PrivilegeCheck,
): Promise<void> {
  if (caller === undefined || !caller.hasPolicyWorld) return
  const jobRank = check.jobPolicy === null ? 0 : POLICY_RANK[check.jobPolicy]
  const callerRank = caller.policy === null ? 0 : POLICY_RANK[caller.policy]
  const gap = jobRank > callerRank
  const verdict: ScopeVerdict = caller.policy === 'danger-full-access' ? { kind: 'in' } : scopeVerdict(caller, check)
  if (!gap && verdict.kind === 'in') {
    if (caller.policy !== 'danger-full-access') enforceRunCwd(caller, check.runCwd)
    return
  }
  const jobLabel = check.jobPolicy === null ? 'the deployment default' : `'${check.jobPolicy}'`
  const callerLabel = caller.policy === null ? 'unknown' : `'${caller.policy}'`
  const headClauses: string[] = []
  const reasonClauses: string[] = []
  const displayClauses: string[] = []
  if (gap) {
    headClauses.push(`job '${check.jobId}' runs at policy ${jobLabel}, above this session's policy ${callerLabel}`)
    reasonClauses.push(`job policy ${jobLabel} exceeds the caller session policy ${callerLabel}`)
    displayClauses.push(`would run with file access '${check.jobPolicy}', above this session's own level (${callerLabel})`)
  }
  if (verdict.kind === 'outside') {
    headClauses.push(`job '${check.jobId}' runs in '${verdict.target}', outside this session's workspace root '${verdict.root}'`)
    reasonClauses.push(`job run root ${verdict.target} sits outside the caller session cwd ${verdict.root}`)
    displayClauses.push(`runs in directory '${verdict.target}', outside this session's workspace root (${verdict.root})`)
  } else if (verdict.kind === 'no-anchor') {
    headClauses.push(`job '${check.jobId}' runs in '${verdict.target}', but this session has no cwd to anchor it against`)
    reasonClauses.push(`job run root ${verdict.target} cannot be verified: the caller session has no cwd`)
    displayClauses.push(`runs in directory '${verdict.target}', but this session has no cwd to anchor it against`)
  } else if (verdict.kind === 'unknown-root') {
    headClauses.push(`job '${check.jobId}' has an undetermined run root (its spec sets no run cwd, or it could not be read)`)
    reasonClauses.push(`job run root could not be determined (its spec sets no run cwd, or it could not be read)`)
    displayClauses.push('has an undetermined run root (its spec sets no run cwd, or it could not be read)')
  }
  const head = headClauses.join('; ')
  if (caller.agent === null) {
    throw new Error(`${head}; no agent context to route approval through (operation denied)`)
  }
  if (caller.approval === null) {
    throw new Error(`${head}; no approval channel is available (operation denied)`)
  }
  const cwdNote = typeof check.runCwd === 'string' ? ` Run cwd: ${check.runCwd}.` : ''
  const outcome = await caller.approval.request({
    agent: caller.agent,
    toolName: 'timer',
    callId: caller.callId,
    reason: `timer ${check.verb} on job '${check.jobId}': ${reasonClauses.join('; ')}`,
    displayReason: {
      en: `Scheduled job '${check.jobId}' ${displayClauses.join(', ')}. Approve this one timer ${check.verb} operation?${cwdNote}`,
    },
    signal: caller.signal,
  })
  if (outcome === 'allowed-once') return
  if (outcome === 'rejected') throw new Error(`${head}; the user rejected the approval`)
  if (outcome === 'cancelled') throw new Error(`${head}; the approval request was cancelled`)
  throw new Error(`${head}; no approval channel is available (operation denied)`) // 'unavailable'
}

/**
 * The run.cwd caller-root rule: at or under the caller's own cwd, canonicalized on both
 * sides. A caller without a known cwd cannot anchor the rule, so an explicit run.cwd is
 * denied for it (only explicit values reach this rule - see the inheritance semantics in
 * the checkCallerPrivilege doc above).
 */
function enforceRunCwd(caller: CallerContext, runCwd: string | null | undefined): void {
  if (runCwd === undefined || runCwd === null || runCwd === '') return
  const outside = `a session may only set a run cwd at or under its own cwd`
  if (caller.cwd === null) {
    throw new Error(`run cwd '${runCwd}' is not allowed: this session has no cwd to anchor it against (${outside})`)
  }
  const target = canonicalize(runCwd)
  const root = canonicalize(caller.cwd)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`run cwd '${target}' is outside this session's workspace root '${root}' (${outside})`)
  }
}

/**
 * Canonicalize a possibly-relative, possibly-symlinked path: resolve it lexically against
 * the process cwd (the same base the runner's mkdirSync uses for run cwds), then apply the
 * real path of the deepest existing prefix. The target run directory itself does not exist
 * yet (the runner creates it), so only its existing prefix is resolved - which still stops
 * a symlink under the caller's root from pointing outside it.
 */
export function canonicalize(p: string): string {
  const abs = path.resolve(p)
  let probe = abs
  for (;;) {
    if (existsSync(probe)) {
      let realProbe = probe
      try {
        realProbe = realpathSync(probe)
      } catch {
        /* lexical probe stands */
      }
      return realProbe + abs.slice(probe.length)
    }
    const parent = path.dirname(probe)
    if (parent === probe) return abs // reached the filesystem root without an existing prefix
    probe = parent
  }
}
