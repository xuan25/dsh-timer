// dsh-timer timer tool: 9 verbs.
// The parameter schema is a strict declaration: the framework validates arguments against it
// before execute and rejects type/enum/required violations with an `invalid arguments` error;
// the validator then enforces the semantic rules (at least one trigger in effect, a
// non-whitespace prompt, cron/ISO and time-span syntax). The null branches in the schema
// mirror the null tolerance of schemas/job.schema.json so both spec paths accept the same values.
// When a verb throws, the framework returns error.message to the model as the failure content.
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context, Policy } from './types.js'
import type { ApprovalSeam, CallerContext, RuntimeAgentFace } from './privilege.js'
import type { TimerScheduler } from './scheduler.js'

export const VERBS = ['reload', 'status', 'run', 'enable', 'disable', 'add', 'update', 'delete', 'cancel']

/**
 * Derive the caller identity of the in-flight tool call for the privilege checks.
 * `exec.agent` is the runtime agent driving the caller session (the public Agent
 * interface carries only the id; the runtime aspect carries the live session, whose
 * header holds the session cwd). Both framework services are read through cordis'
 * non-strict `ctx.get` accessor (the context proxy requires a declared inject for
 * property access inside a runtime, and a host may compose either service or neither
 * - `ctx.get` returns undefined then and the check degrades or fails closed instead
 * of throwing).
 */
function deriveCallerContext(ctx: Context, exec: ToolRunContext | undefined): CallerContext {
  const sandboxPolicy = ctx.get('sandboxPolicy') as
    | { readonly defaultMode: Policy; overrideOf(session: unknown): Policy | undefined }
    | undefined
  const hasPolicyWorld = sandboxPolicy !== undefined && sandboxPolicy !== null
  const agent = (exec?.agent as unknown as RuntimeAgentFace | undefined) ?? null
  const session = agent?.session
  const policy = !hasPolicyWorld || agent === null || session === undefined
    ? null
    : (sandboxPolicy as { readonly defaultMode: Policy; overrideOf(session: unknown): Policy | undefined }).overrideOf(session) ??
      sandboxPolicy.defaultMode
  const approval = (ctx.get('approval') as ApprovalSeam | undefined) ?? null
  return {
    hasPolicyWorld,
    policy,
    defaultMode: hasPolicyWorld ? sandboxPolicy.defaultMode : null,
    cwd: session?.header?.cwd ?? null,
    agent,
    approval,
    callId: exec?.callId,
    signal: exec?.signal,
  }
}

/**
 * Register the timer tool (9 verbs -> TimerScheduler methods).
 * @param ctx cordis Context (the host must have loaded the dsh-tools service).
 * @param scheduler the plugin-side scheduler instance (a thrown error = verb failure; the framework relays error.message).
 * @returns framework effect disposer (unregisters the tool when the fiber is unloaded).
 */
export function registerTool(ctx: Context, scheduler: TimerScheduler): () => void {
  return ctx.tools.register(
    defineTool({
      name: 'timer',
      description:
        'Manage scheduled jobs stored as JSON files under the plugin jobsDir. ' +
        'reload rescans the jobs directory and reports how many jobs are enabled, disabled, or rejected; ' +
        'status shows one job when an id is given, or an overview of all jobs when it is omitted; ' +
        'run triggers one manual run immediately; disabled jobs may be run manually. ' +
        'enable and disable switch the in-file enable field of an existing job. ' +
        'disable first cancels the in-progress runs of the job, matching systemd disable --now. ' +
        'add creates a new job (create-only: it fails if a job with the same id already exists; delete the job first to replace it, which also removes its state file). ' +
        'update replaces the spec of an existing job in place (update-only: it fails if the job does not exist; add creates it); the job state file is preserved, so run history and scheduling anchors survive and a changed trigger reschedules from the existing anchor; in-progress runs keep executing the spec they started with. ' +
        'delete removes the job config and its state file. ' +
        'cancel cancels all in-progress runs of a job. ' +
        'Privilege rules: two axes gate the job-acting verbs (update, enable, disable, run, cancel, delete) - the level axis (the job\'s file-access policy above this session\'s own level) and the scope axis (the job\'s effective run root outside this session\'s workspace root; a job\'s own run session manages itself freely) - either routing through the approval channel for a one-shot human decision; a full-access session is exempt from both axes; add is exempt from the scope axis and a non-full-access session may set a new job\'s explicit run cwd only at or under its own session cwd (denied locally, no approval); an approved operation lifts the cwd rule; the run.cwd inheritance rules are in the cwd field description. ' +
        'Job spec fields: onCalendar, onActiveSec, onStartupSec, timeZone, persistent, deferReactivation, runtimeMaxSec, overlap, enable, run.',
      parameters: {
        verb: { type: 'string', required: true, enum: VERBS, description: 'The verb to execute.' },
        id: {
          type: 'string',
          description:
            'Job id. It is required for run, enable, disable, add, update, delete, and cancel; omit it with status to get the overview of all jobs.',
        },
        spec: {
          type: 'object',
          additionalProperties: true,
          description:
            'Job spec for add and update. A valid spec needs at least one trigger in effect (onCalendar, onActiveSec, or onStartupSec; a trigger set to null is explicitly not used) plus a run object with a non-empty prompt. Each field\'s semantics are in its field description below.',
          properties: {
            onCalendar: {
              oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
              description:
                'Cron expressions or ISO datetimes that trigger the job; a run starts when the wall clock matches one of them. Setting the field to null means the calendar trigger is explicitly not used.',
            },
            onActiveSec: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              description: 'A span such as 30min; the job re-arms that long after its last run started. Setting the field to null means the trigger is explicitly not used.',
            },
            onStartupSec: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              description: 'A span such as 5s; fires once, measured from process start. Setting the field to null means the trigger is explicitly not used.',
            },
            timeZone: {
              type: 'string',
              description: 'An IANA timezone name applied to calendar conditions; it overrides the system timezone.',
            },
            persistent: {
              type: 'boolean',
              description:
                'When true, calendar triggers missed while the process was down or the job was disabled fire exactly once after recovery, rebased to the current moment; the default is false.',
            },
            deferReactivation: {
              type: 'boolean',
              description:
                'When true, the next trigger is computed from the run end moment instead of the scheduled time; ignored on jobs without calendar conditions; the default is false.',
            },
            runtimeMaxSec: {
              oneOf: [{ type: 'string' }, { type: 'null' }],
              description:
                'A span such as 2m that bounds the duration of a single run, or 0 / infinity / null for no limit; omitting the field means no limit. A run that exceeds the limit is cancelled and recorded as failed.',
            },
            overlap: {
              type: 'string',
              enum: ['skip', 'stop', 'allow'],
              description:
                'What to do when a trigger fires while a run is in progress: skip the trigger, stop the in-progress run, or allow concurrent runs. The default is skip.',
            },
            enable: {
              type: 'boolean',
              description:
                'When false the job is stored disabled: it is never scheduled, but it can still be run manually. Omitting the field or setting true stores the job enabled; the default is true.',
            },
            run: {
              type: 'object',
              additionalProperties: true,
              description:
                'Per-run settings: prompt (required) plus the optional fields cwd, preset, model, and policy - see their field descriptions for the exact semantics.',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'The prompt that starts each run; it must not be whitespace-only.',
                },
                cwd: {
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                  description:
                    'Working directory of the run session. On add, a null or an omitted field inherits the creating session\'s workspace itself (<session-cwd>); a creating session without a cwd must set an explicit value or the add is refused. On update, a null or an omitted field keeps the job\'s existing run cwd.',
                },
                preset: {
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                  description: 'Agent preset of the run session; naming a preset that is unresolvable or broken fails the run as create_failed; null or an omitted field mounts the deployment\'s default preset.',
                },
                model: {
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                  description: 'Model route of the run session; null or an omitted field uses the deployment\'s default model selection, when a source provides it.',
                },
                policy: {
                  oneOf: [
                    { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
                    { type: 'null' },
                  ],
                  description: 'File access policy of the run session; null or an omitted field uses the deployment default.',
                },
              },
            },
          },
        },
      },
      output: {
        schema: { type: 'string' },
        render: (args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const verb = args?.verb
        if (!verb) return `missing verb (${VERBS.join('/')})`
        // The caller identity of this in-flight call: the privilege checks
        // gate every verb that can create, modify, or act on a job.
        const caller = deriveCallerContext(ctx, exec)
        switch (verb) {
          case 'reload':
            return scheduler.reload()
          case 'status':
            return scheduler.statusText(args?.id)
          case 'run':
            return scheduler.manualRun(args?.id, caller)
          case 'enable':
            return scheduler.setEnabled(args?.id, true, caller)
          case 'disable':
            return scheduler.setEnabled(args?.id, false, caller)
          case 'add':
            return scheduler.addJob(args?.id, args?.spec, caller)
          case 'update':
            return scheduler.updateJob(args?.id, args?.spec, caller)
          case 'delete':
            return scheduler.deleteJob(args?.id, caller)
          case 'cancel':
            return scheduler.cancelJob(args?.id, caller)
          default:
            return `unknown verb: ${verb}`
        }
      },
    }),
  )
}
