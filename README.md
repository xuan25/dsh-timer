# dsh-timer

dsh-timer gives a dsh deployment a built-in job scheduler: when a trigger expires the plugin starts a fresh prompted session, so recurring work - daily reports, periodic checks, one-shot tasks - runs on schedule inside the dsh process.

- Jobs live in a job directory, written by hand or with the nine-verb `timer` tool
- Three trigger kinds: cron expressions and one-shot ISO times, intervals counted from the last run, and one-shot startup delays
- Each run is a fresh prompted session with a configurable working directory, preset, model, file policy, and reasoning effort
- A per-job state file tracks the next trigger and the 50 most recent run records
- systemd.timer-style behavior: persistent catch-up after downtime, overlap policies (skip/stop/allow), run-time limits, timezone and clock-rewind handling
- Live rescan: the job directory is watched with a 500 ms debounce, so job edits take effect in seconds
- Session offload: a per-minute sweep archives settled run sessions that outlived the job's `run.sessionRetention` window, keeping the framework session store bounded

This README is the operations quick reference. The complete field reference with examples is [`schemas/job.schema.json`](./schemas/job.schema.json); usage details, examples, and troubleshooting live in the in-package skill [`skill/dsh-timer/SKILL.md`](./skill/dsh-timer/SKILL.md).

## Installation

dsh-timer is an out-of-tree plugin for a dsh profile. Install it with the dsh plugin command:

```sh
dsh plugin --profile <name> add dsh-timer
```

No configuration is required: the plugin registers itself and reads jobs from the job directory described below. One optional plugin config field refines the deployment's layout: `jobsDir` (the job directory, below). Its only other on-disk state is the session offload's retention log and archive under `$DSH_HOME/dsh-timer/` (see Session offload).

## Jobs

### Job directory

The plugin resolves the job directory in the following order:

1. Explicit candidates, in this order: the `jobsDir` plugin config value, then the environment variable `DSH_TIMER_JOBS_DIR`. If a designated candidate is unavailable, the plugin start fails hard.
2. The default directory `<profileDir>/timers`, used only when no candidate is designated, where `profileDir` is the dsh profile directory that hosts the plugin. The profile is detected from the plugin's install location, or - when the plugin lives outside any install tree - from the running process's harness home (`$DSH_HOME`, resolved through the framework-provided `dshHomePath` service) by the framework's `dsh-profile-<name>` profile naming; exactly one profile must be found. If the resulting directory is unavailable, the plugin writes a log entry and starts degraded: no jobs are loaded and no state is persisted until the directory is fixed and reloaded.
3. If no candidate is designated and no unique profile can be determined (zero or multiple profiles found, or the host does not provide the harness-home service), the plugin start throws; the error points at the explicit overrides from item 1, plus a `jobsDir` entry in the profile's `cordis.patch.yml` (a `!!js` loader expression, e.g. `dshHomePath('profiles','<name>','timers')`, shown below). A development directory that lives outside the profile must be designated through candidate 1.

The last channel above can be written as a loader expression. A `!!js` value in a plugin config is a YAML scalar tagged with the loader-expression tag: when the plugin entry activates, the loader evaluates the expression in a scope where every framework service - including `dshHomePath`, the harness-home path resolver - is available as an identifier, and the expression's result replaces the value:

```yaml
# <profileDir>/cordis.patch.yml - pin the job directory from the profile layer
- id: dsh-timer
  config:
    jobsDir: !!js dshHomePath('profiles', '<name>', 'timers')
```

Here `<name>` is the profile directory name under the harness home. A patch entry replaces the whole `config` key of the targeted entry; dsh-timer's default config is empty, so the example sets the field it needs.

### Run root

A job's run root is the working directory its run session is created in, and - under the plugin's privilege model - the job's control scope: a session outside that root (and below full access) manages the job only through the approval channel. The run root is the spec's explicit `run.cwd`; an `add` without one inherits the creating session's workspace itself (`<session-cwd>`) and persists the inherited value into the job file, so a job created through the plugin always carries its run root in its own file. A job whose spec sets no `run.cwd` has an undetermined run root: managing it fails closed through the approval channel, and its runs fail `create_failed` with the actionable remedy (set `run.cwd` in the job file).

The plugin ships no host-absolute run path of its own: every run root is either the caller's session fact or the spec's own explicit value.

The directory layout is as follows:

| Path (relative to the job directory) | Content |
| --- | --- |
| `<id>.json` | one job per file; the in-file `enable` field decides whether the job is active (absent or `true` = enabled, `false` = disabled; a disabled job keeps living in the same file) |
| `state/<jobId>.json` | the job's runtime state (see "State file" below); only the plugin writes it |
| a job file that fails to parse or fails validation | the id is rejected and the reason is reported in `status`; the plugin keeps no last-good state |
| any other file name or subdirectory | ignored and never rejected |

A job id must match `^[a-z0-9][a-z0-9-]{0,63}$` - a lowercase letter or a digit first, then up to 63 lowercase letters, digits, or hyphens.

The plugin watches the job directory with a 500 ms debounce and rescans on any change; the `reload` verb of the `timer` tool forces the same rescan. A job that is disabled, or whose spec becomes invalid, while a run is in progress keeps its state file, so fixing the spec restores the job's run history.

### Job file fields

The table below is a quick reference; see `schemas/job.schema.json` for the complete field descriptions with examples. The three trigger fields each accept a `null` value meaning that trigger is not used, and at least one trigger field must be non-null.

| Field | Type | Default | Semantics |
| --- | --- | --- | --- |
| `enable` | boolean | `true` | When `false`, the job is stored disabled in the same file: it is never scheduled, but it can still be run manually and re-enabled by flipping the field. |
| `onCalendar` | `string[]` or `null` | - | Each entry is a 5/6-field cron expression (strict cron parsing, recurring) or a full ISO instant (one-shot). |
| `onActiveSec` | time span or `null` | - | Counted from the last activation, which is the most recent run's start moment. |
| `onStartupSec` | time span or `null` | - | Counted from process start and fires once per process. |
| `timeZone` | IANA timezone name | the system timezone | Overrides the system timezone for the job; applies only to calendar conditions. Ambiguous local times (DST folds) resolve to the first occurrence; a one-shot ISO instant inside a DST gap is rejected. |
| `persistent` | boolean | `false` | When `true`, if a trigger was due while the process was down or the job disabled, the plugin fires exactly one catch-up run after recovery, rebased to the current moment, and re-arms from the actual trigger moment. The missed interval is not persisted. |
| `deferReactivation` | boolean | `false` | Applies only to jobs that have onCalendar conditions (on other jobs the value is accepted and ignored). When `true`, a condition that starts a run is suspended for the duration of that run (its due moments are skipped without advancing the phase) and is re-armed from the run end moment. When `false`, the phase advances at every due moment even while a run is in progress. |
| `runtimeMaxSec` | time span, `0`, `infinity`, or `null` | no limit | A run that exceeds the limit is cancelled and recorded as `failed` with cause `timeout`. |
| `overlap` | `skip`, `stop`, or `allow` | `skip` | Defines what happens when a trigger fires while a run is already in progress. `skip` consumes the trigger in place (the phase advances at the due moment and no catch-up fire happens after the run ends - a run longer than the interval swallows grid points); `stop` cancels the in-progress run first and then starts; `allow` starts a parallel run. |
| `run` | object (required) | - | The run block. `prompt` is required and non-empty; `cwd`, `preset`, `model`, `policy`, `sessionRetention`, and `reasoningEffort` are optional - full field semantics in `schemas/job.schema.json` (run-cwd inheritance is covered in the Run-root section above; `sessionRetention` is covered in the Session-offload section below; `reasoningEffort` is a closed set `off/minimal/low/medium/high/xhigh/max` validated at load, absent or null = the framework's provider default). |

Time spans use the systemd syntax: the units `us`/`usec`, `ms`/`msec`, `s`/`sec`/`second(s)`, `m`/`min`/`mins`/`minute(s)`, `h`/`hour(s)`, `d`/`day(s)`, `w`/`week(s)`, `M`/`month(s)` (approx. 30 days), `y`/`year(s)` (approx. 365 days) - case-sensitive (`m` is minutes, `M` is months) - where a bare number means seconds and units may be combined (for example `30s`, `5min`, `1h30min`, or `2d`). The `*Sec` field names follow the systemd time directive names; a `Sec` field value is a span string (or `null` where the field tolerates it) - a JSON number is never accepted. A span shorter than half a millisecond rounds to 0 ms and makes the job fire on every tick; prefer values of at least 1 ms.

### State file

The plugin persists each job's runtime state in `<job directory>/state/<jobId>.json` using atomic, best-effort writes with a stable key order; explicit `null` keys are preserved. The file format is [`schemas/state.schema.json`](./schemas/state.schema.json):

```jsonc
{
  "schemaVersion": 1,
  "jobId": "example",
  "lastActivationMs": 1727200000000,     // most recent run start moment (null when never run; the onActiveSec base then falls back to process start)
  "lastTriggerMs": 1727100000000,        // job-level last on-calendar elapse (fire or overlap=skip consume; the phase anchor for the next elapse)
  "calendars": {                            // indexed by onCalendar value
    "0 9 * * 1-5": {
      "value": "0 9 * * 1-5",
      "kind": "cron",                       // cron | iso
      "neverMatch": false,
      "consumed": false,                     // true after a one-shot ISO has fired
      "nextFireMs": 1727300000000
    }
  },
  "runs": [ /* most recent 50, FIFO */ ]
}
```

A run record inside `runs` has the following keys:

| Key | Meaning |
| --- | --- |
| `runId` | the unique identifier of the run |
| `sessionId` | the dsh session that executed the run |
| `trigger` | which condition fired: `scheduled` (a calendar condition), `monotonic` (`onActiveSec`), `startup` (`onStartupSec`), or `manual` (the `run` verb) |
| `startedAt` / `finishedAt` | epoch milliseconds; the run's start and end moments |
| `status` | `running` while the run is in progress, then `finished` or `failed` |
| `cause` | null for a finished run; the value is set only on failure: `timeout`, `cancelled`, `interrupted`, `create_failed`, or `turn_error` |
| `durationMs` | the run's elapsed duration in milliseconds |
| `summary` | a summary of the run, truncated to 2000 characters |
| `error` | the error text when the run failed |

`finished` only records that the turn ended cleanly; it does not claim that the task succeeded - the outcome lives in `summary` and the session transcript. A job that has never run reports no run in status (`recent run: none (no runs yet)` in the detail, `last run: none (no runs yet)` on the overview line).

## Managing timers

The plugin registers the `timer` tool, which exposes the following nine verbs, and the `dsh-timer` skill:

| Verb | Effect |
| --- | --- |
| `reload` | rescans the job directory |
| `status` (id optional) | shows an overview or a single job's detail |
| `run` | triggers the job manually once (allowed for disabled jobs too; unconditional start) |
| `enable` | sets the in-file `enable` field to true (the onStartupSec already-fired flag is preserved via in-process memory) |
| `disable` | sets the in-file `enable` field to false, cancelling the job's in-progress runs first (= `disable --now`) |
| `add` | creates a job; rejects if the id already exists (delete the job first to replace it) or if the spec is invalid |
| `update` | replaces the spec of an existing job in place; rejects if the id is unknown (use `add`) or if the spec is invalid; the job's state file is preserved |
| `delete` | deletes the job file and its state file (in-progress runs settle without writing state) |
| `cancel` | cancels all in-progress runs of the job |

## Session offload

Job runs leave on-disk session logs in the framework session store; at run volume (frequent intervals, long prompts) the store grows without bound. The per-minute offload sweep archives settled run sessions once the job's effective retention window elapses, so the store stays bounded: the store is never deleted, only moved, a run that is still in flight is kept until it settles, and a job that vanishes from the job directory is offloaded immediately regardless of age.

- **Windows**: `run.sessionRetention` is per-job (config layer: the job file's `run` block, hot-updated through the live rescan): a non-negative integer number of milliseconds, or a duration string of 1-2 digits+unit segments (units d/h/m/s/ms) in descending order (e.g. `24h`, `4h30m`, `90s`, `5000ms`; a bare numeric string is invalid). 0 / null / absent = the unit default (see below; no offload when it is 0); an invalid value warns and is treated as 0. A job without a `run.cwd` is never offloaded (its runs fail `create_failed` first).
- **Unit default window**: `TIMER_SESSION_RETENTION` (env, read once at boot; a duration string like `24h` - a bare numeric string is invalid; absent = 0, invalid warns and falls back to 0) sets the default retention window for every job without an explicit `run.sessionRetention` (absent or null); an explicit job value always takes precedence over it.
- **Budget**: `TIMER_OFFLOAD_BATCH` (env, default 50) bounds the sessions one sweep may process; an invalid value warns and falls back to 50, never disabling the sweep. When consecutive sweeps observe new log lines arriving faster than the budget, the sweep logs a trend warning (raise the knob or lower the retention windows; the warning takes no action on its own).
- **Failure semantics**: an unreachable persistence service, a missing store root, or an archive on a different mount disables the sweep for that round (a visible warning; log lines are never lost); a failed individual move keeps the entry for the next round.

## Clock & timezone

During operation the plugin detects the following wall-clock events:

| Event | Detection | Effect |
| --- | --- | --- |
| clock rewind | the wall clock lags the monotonic clock by more than 1 s between two consecutive ticks | all trigger times are recomputed from the new current moment |
| system timezone change | the mtime of `/etc/localtime` changes | calendar conditions without a job-level `timeZone` are recomputed under the new timezone; if the new timezone cannot be decoded, the plugin keeps the old timezone and writes a log entry |

## Development

The package is written in TypeScript using only the erasable syntax subset (no enums, namespaces, parameter properties, or decorators), so Node 24 can run the output with plain type stripping. The `tsc` build compiles `src/` into `lib/` as ESM (NodeNext resolution, strict mode).

### Layout

| Path | Content |
| --- | --- |
| `src/` | the TypeScript source |
| `lib/` | the compiled output, shipped with the package |
| `schemas/` | the machine-readable contracts: `job.schema.json` (job file) and `state.schema.json` (state file) |
| `skill/` | the in-package skill |
| `test/selftest.mjs` | the pure-logic selftest |
| `test/smoke.mjs` | the framework-path smoke (tool schema validation, skill provider); needs the peer packages installed |
| `test/schema-gate.mjs` | the ajv-based schema gate (both schemas compiled as draft 2020-12, positive/negative cases including the structural trigger rule); uses an ajv 8 build that supports draft 2020-12, probed from the host toolchain (the `DSH_HOME` env, then the default host install location) rather than the package's own dependency tree |

### Plugin entry

The package entry is `lib/index.js`. Its default export `DshTimerPlugin` extends the cordis `Service` and follows the class-form plugin contract: `static name`, `static inject`, `static Config` (a schemastery schema that exposes `~standard.validate`), and an instance `async *[Service.init]()` generator that yields the disposer first and then starts the scheduler.

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run build` | compiles `src/` into `lib/` with `tsc` |
| `npm run typecheck` | runs `tsc --noEmit` |
| `npm run lint` | runs `eslint src/` (flat config + @typescript-eslint, including the type-aware no-floating-promises rule) |
| `npm run selftest` | runs the selftest described below |

### Selftest

The selftest asserts the pure logic (util, time, cron, rearm, validator, and state) plus the croner test vectors against the compiled `lib/`, covers the session-offload plane (window parsing, retention-log mechanics, the sweep's window/liveness/budget/trend semantics, the run-lifecycle write gate, and the layout pin), and cross-checks the `timer` tool schema's null branches against `schemas/job.schema.json` as a source-level sync guard.
