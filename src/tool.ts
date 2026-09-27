// dsh-timer timer tool: 8 verbs.
// The parameter schema is a strict declaration: the framework validates arguments against it
// before execute and rejects type/enum/required violations with an `invalid arguments` error;
// the validator then enforces the semantic rules (at least one trigger in effect, a
// non-whitespace prompt, cron/ISO and time-span syntax). The null branches in the schema
// mirror the null tolerance of schemas/job.schema.json so both spec paths accept the same values.
// When a verb throws, the framework returns error.message to the model as the failure content.
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from './types.js'
import type { TimerScheduler } from './scheduler.js'

export const VERBS = ['reload', 'status', 'run', 'enable', 'disable', 'add', 'delete', 'cancel']

/**
 * Register the timer tool (8 verbs → TimerScheduler methods).
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
        'add creates a new job or overwrites an existing one. ' +
        'delete removes the job config and its state file. ' +
        'cancel cancels all in-progress runs of a job. ' +
        'Job spec fields: onCalendar, onActiveSec, onStartupSec, timeZone, persistent, deferReactivation, runtimeMaxSec, overlap, enable, run.',
      parameters: {
        verb: { type: 'string', required: true, enum: VERBS, description: 'The verb to execute.' },
        id: {
          type: 'string',
          description:
            'Job id. It is required for run, enable, disable, add, delete, and cancel; omit it with status to get the overview of all jobs.',
        },
        spec: {
          type: 'object',
          additionalProperties: true,
          description:
            'Job spec for add. A valid spec needs at least one trigger in effect (onCalendar, onActiveSec, or onStartupSec; setting a trigger field to null means that trigger is explicitly not used) and a run object with a non-empty prompt. ' +
            'onCalendar is an array of cron expressions or ISO datetimes, or null to explicitly not use the calendar trigger. ' +
            'onActiveSec re-arms the job that long after its last run started, or null to explicitly not use the trigger. ' +
            'onStartupSec fires once that long after process start, or null to explicitly not use the trigger. ' +
            'timeZone overrides the system timezone for calendar conditions. ' +
            'persistent recovers missed calendar triggers with one catch-up fire. ' +
            'deferReactivation computes the next trigger from the run end instead of the scheduled time. ' +
            'runtimeMaxSec bounds the duration of a single run; 0 / infinity / null means no limit. ' +
            'overlap decides what happens when a trigger fires while a run is in progress: skip, stop, or allow. ' +
            'enable stores the job disabled when false. ' +
            'run holds the per-run settings; prompt is required, and null or an omitted cwd, preset, model, or policy keeps the deployment default.',
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
                'When true, calendar triggers missed while the job was inactive fire once after it becomes active again; the default is false.',
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
                'Per-run settings. prompt is required; cwd, preset, model, and policy are optional, and null or an omitted field keeps the deployment default; a preset-less run mounts the deployment\'s default agent preset (the framework\'s baseline composition when the host provides no preset service or no usable default).',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'The prompt that starts each run; it must not be whitespace-only.',
                },
                cwd: {
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                  description: 'Working directory of the run session; null or an omitted field keeps the default.',
                },
                preset: {
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                  description: 'Agent preset of the run session; naming a preset that is unresolvable or broken fails the run as create_failed; null or an omitted field mounts the deployment\'s default preset (the framework\'s baseline composition when the host provides no usable one).',
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
      async execute(args) {
        const verb = args?.verb
        if (!verb) return `missing verb (${VERBS.join('/')})`
        switch (verb) {
          case 'reload':
            return scheduler.reload()
          case 'status':
            return scheduler.statusText(args?.id)
          case 'run':
            return scheduler.manualRun(args?.id)
          case 'enable':
            return scheduler.setEnabled(args?.id, true)
          case 'disable':
            return scheduler.setEnabled(args?.id, false)
          case 'add':
            return scheduler.addJob(args?.id, args?.spec)
          case 'delete':
            return scheduler.deleteJob(args?.id)
          case 'cancel':
            return scheduler.cancelJob(args?.id)
          default:
            return `unknown verb: ${verb}`
        }
      },
    }),
  )
}
