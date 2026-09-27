// dsh-timer — in-process scheduled-task plugin for dsh.
// In-process execution: a 30s tick scans <jobsDir>/<id>.json → fires on expiry → each run
// creates a fresh prompted session.
// Plugin form = cordis class plugin (Service subclass): `new DshTimerPlugin(ctx, validatedConfig)`.
// The instance `async *[Service.init]()` carries the lifecycle: yield the disposer
// (scheduler.stop + the three registration unregisters), then await scheduler.start()
// (a failed start = plugin apply failure, matching the JS version's apply-throws semantics).
import Schema from '@deepseek-ai/schemastery'
import { Service, type Context } from '@deepseek-ai/cordis'
import { PLUGIN_NAME, resolveJobsDir } from './util.js'
import { TimerScheduler } from './scheduler.js'
import { registerTool } from './tool.js'
import { registerSkill } from './skill.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Harness-home path resolver the framework provides on the root context at boot
     * (dsh-app-boot): `dshHomePath(...segments)` joins onto the resolved harness home
     * ($DSH_HOME, else ~/.dsh). Optional in the framework's own typing: a host that does
     * not provide it cannot host this plugin (the declared-missing service parks the
     * plugin fiber — see the class doc); all dsh product hosts provide it.
     */
    dshHomePath?: (...segments: string[]) => string
  }
}

/** Plugin configuration (the schemastery-validated shape; jobsDir is optional). */
export interface DshTimerConfig {
  /** Job directory (optional); defaults try env DSH_TIMER_JOBS_DIR, then <profileDir>/timers (profile via the install-root walk-up or the harness-home dsh-profile-* discovery, see resolveJobsDir). */
  jobsDir?: string
}

/**
 * dsh-timer plugin (class form):
 * the constructor performs synchronous initialization (logger / jobsDir resolution / scheduler
 * construction / tool / skill / system-prompt section registration);
 * `*[Service.init]()` registers the disposer and starts scheduling (tick timer + directory
 * watch go through the cordis timer service).
 *
 * inject = every service the plugin reads: agents (run executor) and timer (the cordis timer
 * service, TimerService from cordis-plugin-timer, providing ctx.timeout/ctx.interval) plus the
 * dsh host services tools / skills / systemPrompt (dsh-tools / dsh-skill / dsh-system-prompt:
 * ctx.tools.register / ctx.skills.registerProvider / ctx.systemPrompt.section) and dshHomePath
 * (the framework's harness-home path resolver, dsh-app-boot: provided on the root context at
 * boot and read once by the constructor for the default jobsDir discovery via the
 * harness-home dsh-profile-* convention when the install-root walk-up finds nothing). Under
 * cordis 4.0.2 the proxy store lookup precedes the inject check, so an undeclared read of a
 * present service succeeds; declaring all six converts a host-missing-the-service failure
 * from the cryptic `cannot get property "X" without inject` into the clear `cannot get
 * required service "X"`, keeping the declaration consistent with the actual read sites.
 * A declared service with no implementation parks the plugin fiber (it never activates,
 * it does not throw): a host without dshHomePath therefore never starts this plugin —
 * all dsh product hosts provide it at boot, so this only affects out-of-product hosts.
 * OPTIONAL host services (the framework's agent-default-model service and the settings
 * document service, behind the run session's default model route) are deliberately NOT
 * declared here and are never read as direct ctx properties: the run executor reads them
 * through cordis' built-in non-strict accessor `ctx.get(name)` (declared on the
 * framework's own Context type, mixed onto every context by the reflection layer; it
 * returns the host-provided service or undefined when the host provides none), which
 * tolerates their absence (see readDefaultModelSelection in runner.ts) — a direct
 * property read of an undeclared service throws `cannot get property ... without
 * inject` at runtime, and declaring one in `inject` would park the plugin on every
 * host that lacks it.
 */
export class DshTimerPlugin extends Service {
  static name = PLUGIN_NAME
  static readonly inject = ['agents', 'timer', 'tools', 'skills', 'systemPrompt', 'dshHomePath']
  static readonly Config = Schema.object({
    jobsDir: Schema.string().description('Job directory (optional); defaults try env DSH_TIMER_JOBS_DIR, then <profileDir>/timers (profile via the install-root walk-up or the harness-home dsh-profile-* discovery)'),
  })

  private readonly scheduler: TimerScheduler
  private readonly disposeTool: () => void
  private readonly disposeSkill: () => void
  private readonly disposePrompt: () => void

  constructor(ctx: Context, config: DshTimerConfig) {
    super(ctx, PLUGIN_NAME)
    const logger = ctx.logger(PLUGIN_NAME)
    const jobsDir = resolveJobsDir(config, logger, ctx.dshHomePath)
    this.scheduler = new TimerScheduler({ ctx, logger, jobsDir })
    this.disposeTool = registerTool(ctx, this.scheduler)
    this.disposeSkill = registerSkill(ctx)
    this.disposePrompt = ctx.systemPrompt.section({
      name: PLUGIN_NAME,
      order: 3000,
      text: `Scheduled tasks are managed by the ${PLUGIN_NAME} plugin (timer tool, 8 verbs: reload/status/run/enable/disable/add/delete/cancel); see the ${PLUGIN_NAME} skill for task file fields and semantics.`,
    })
  }

  /**
   * Lifecycle hook (under cordis 4.0.2 the only init form that takes effect = the instance
   * method generator; the static [Service.init] form is not invoked by the runner).
   * Yield the package-dispose cleanup (scheduler.stop + the three unregisters) first,
   * then start scheduling.
   */
  async *[Service.init](): AsyncGenerator<() => Promise<void>, void, unknown> {
    yield async () => {
      // Awaits the exit-side settlement: stop() settles every in-flight run and awaits
      // one state-file write per affected model before resolving, so the settled records
      // are on disk before disposal proceeds (crash/kill still falls back to backfill).
      await this.scheduler.stop()
      try {
        this.disposeTool()
      } catch {
        /* */
      }
      try {
        this.disposeSkill()
      } catch {
        /* */
      }
      try {
        this.disposePrompt()
      } catch {
        /* */
      }
    }
    await this.scheduler.start()
  }
}

export default DshTimerPlugin
