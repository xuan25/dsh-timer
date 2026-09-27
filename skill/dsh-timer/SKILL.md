---
name: dsh-timer
description: "dsh-timer scheduled task plugin usage guide: 8 verbs, task file fields, examples, semantics highlights, and a troubleshooting decision tree."
whenToUse: when you need to create / inspect / enable-disable / manually trigger / delete scheduled tasks (dsh-timer timer tool)
---

# dsh-timer Usage Guide

Scheduled tasks are managed by the dsh-timer plugin. A task = `<jobsDir>/<id>.json` (`jobsDir` is on the first line of the `timer` tool's status output); the id charset is `^[a-z0-9][a-z0-9-]{0,63}$`. Trigger due times are checked by a 30-second tick, so the worst-case reaction latency is about 30 s.

## 1. The 8 verbs (timer tool)

| verb | args | description |
| --- | --- | --- |
| `reload` | — | rescan jobsDir (directory changes also trigger it automatically; a manual reload forces immediate effect) |
| `status` | `id` (optional) | omitted = overview (three groups: enabled/disabled/rejected; disabled jobs are shown from their in-memory model and include recent runs); with id = that job's detail (job-level last on-calendar elapse, next trigger, up to 5 recent runs newest first, incl. runId/sessionId) |
| `run` | `id` | manually trigger once (unconditional start; disabled jobs allowed too — their in-memory model is used directly); returns immediately; recorded in state after completion |
| `enable` | `id` | set the in-file `enable` field to true (atomic read-modify-write, then an immediate rescan; the onStartupSec already-fired flag is preserved via in-process memory) |
| `disable` | `id` | set the in-file `enable` field to false, cancelling all in-progress runs of the job first; the job's in-memory model and state file are kept, so re-enabling restores the schedule with its run history |
| `add` | `id`, `spec` | create/overwrite a job (upsert): the spec is validated first (an invalid spec throws and no file is written), then `<id>.json` is written and the directory rescanned; an existing job's spec file is overwritten and its resulting state is the new spec's `enable` field (absent = enabled) |
| `delete` | `id` | delete the config file and state file; in-progress runs settle but do not write state or recompute |
| `cancel` | `id` | cancel all in-progress runs of the job (recorded as failed/cancelled); a no-op if none are in progress |

## 2. Job file fields quick reference

The table below is a quick reference; the complete field reference (full field descriptions, examples, and rejection conditions) is `../../schemas/job.schema.json` relative to this file (the `schemas/` directory of the plugin package root).

```jsonc
{
  "enable": true,               // default true; false = stored disabled in the same file (never scheduled, still manually runnable, re-enable by flipping the field)
  "onCalendar": ["0 9 * * 1-5", "2026-10-01T00:00:00+08:00"], // at least one non-null trigger kind; cron (5/6 fields, recurring) or a full ISO instant (one-shot); null = explicitly not used
  "onActiveSec": "30min",   // span since the last activation (most recent run start moment); null = explicitly not used
  "onStartupSec": "5min",       // span since process start, once per process; null = explicitly not used
  "timeZone": "Asia/Shanghai",  // IANA name, overrides the system timezone (calendar conditions only)
  "persistent": true,           // default false; onCalendar catch-up semantics — see §5
  "deferReactivation": true,    // default false; applies only to onCalendar jobs (ignored on monotonic-only jobs); suspension-across-run semantics — see §5
  "runtimeMaxSec": "0",         // span, or 0/infinity/null = no time limit; timeout → failed/timeout
  "overlap": "skip",            // skip(default: consume in place)|stop(cancel running then start)|allow(parallel)
  "run": {
    "prompt": "required: the prompt (a whitespace-only prompt is rejected)",
    "cwd": "/workspace/x",      // default /workspace/timer/runs/<id>/; null = same as omitting the field
    "preset": "",               // agent preset of the run session (mounted through the host's agent preset service when the session is created); naming a preset that is unresolvable or broken fails the run as create_failed; null = same as omitting (the deployment's default preset, or the framework's baseline composition when the host provides no usable one)
    "model": "provider/model",  // model route: "provider/model", or a bare model id (rides the deployment's default provider); omitted = the deployment's default model selection, when a source provides it (the host's agent-default-model service, or the settings section/document that service is built on); null = same as omitting the field
    "policy": "workspace-write" // read-only|workspace-write|danger-full-access; null = deployment default
  }
}
```

Span syntax: `30s` / `5min` / `1h` / `2d` / `1w` / `1M`(month) / `1y`(year) / bare number = seconds; case-sensitive (`m` = minute, `M` = month); word forms accepted (`5mins`, `1minute`, `2hours`, `1year`); combinable like `1h30min`.

## 3. Examples

```bash
# weekday 09:00 Shanghai-timezone inspection; long runs do not chain
timer verb=add id=daily-check spec='{"onCalendar":["0 9 * * 1-5"],"timeZone":"Asia/Shanghai","deferReactivation":true,"run":{"prompt":"Inspect and summarize"}}'

# heartbeat every 30 minutes (restart-safe: the phase continues from the persisted lastActivation; a never-run job re-arms from the new process start)
timer verb=add id=heartbeat spec='{"onActiveSec":"30min","run":{"prompt":"One-sentence heartbeat"}}'

# one-shot reminder (consumed after firing; status marks it "[fired (one-shot ISO instant)]")
timer verb=add id=ny-2027 spec='{"onCalendar":["2027-01-01T00:00:00+08:00"],"run":{"prompt":"New Year reminder"}}'
```

## 4. Management channels

- Model side: the `timer` tool (the 8 verbs above); every task-file change must go through `add`/`enable`/`disable`/`delete` — never write task files directly with fs tools.
- Human side: `<jobsDir>/<id>.json` may also be edited by hand (saving triggers an automatic rescan after the 500 ms debounce; a broken file rejects that id with no last-good); deleting = remove the job file + its state file.

## 5. Semantics highlights

- **overlap**: skip (default) = a trigger that becomes due while a run is in progress is consumed in place on that tick (the schedule phase advances at the due moment; no catch-up fire after the run ends — a run longer than the interval swallows grid points; plan schedules accordingly); stop = cancel the running run then start; allow = run in parallel. Manual `run` is not subject to overlap.
- **deferReactivation**: false (default) = the phase advances at every due moment even while a run is in progress (a due moment under overlap=skip is consumed in place); true = a condition that starts a run is suspended for the duration of that run (its due moments are skipped without advancing the phase) and is re-armed from the run end moment. The field applies only to jobs that have onCalendar conditions; on jobs that have only monotonic conditions the value is accepted and ignored.
- **persistent**: when false, onCalendar triggers missed while down are silently dropped (next trigger time = nextMatch(restart moment); the phase is reset; no missed persistence); when true, exactly one catch-up fire after restart / disable→enable (rebased to the current moment), then re-armed from the actual trigger moment. onActiveSec/onStartupSec are not subject to this semantics.
- **neverMatch**: a cron with no match across the exhaustive search window (sweep capped at AD 3000; e.g. `0 0 31 2 *`) → that condition never fires on its own; status shows the `[no future match]` marker; it is not rejected.
- **Zero runs**: status shows `recent run: none (no runs yet)`; `lastActivation` when never run = the process start moment.
- **create_failed**: when a run cannot be started before the session is created — the run working directory cannot be created, session creation fails, or session creation exceeds the 5-minute deadline — failed/create_failed is recorded (a session that completes after the deadline is cancelled and disposed, never left running untracked); that fire is treated as consumed (cron re-arms from the actual trigger moment, ISO is treated as consumed) → no retry storm.
- **clock & timezone**: on a clock rewind (wall − monotonic delta < −1 s between ticks) the plugin clamps the schedule anchor to the new now and recomputes all conditions (log entry: `clock rewound`; grid points in the erased interval elapse once more); on a system timezone change (/etc/localtime mtime change) calendar conditions without a job-level `timeZone` recompute under the new timezone (a new next match that falls in the past → one fire rebased to now); no per-fire chase either way.
- **Run result summary**: the task prompt is automatically appended with an instruction to "output a plain-text result summary of 1-5 sentences after completion"; the summary is truncated to ≤2000 characters and stored in state.

## 6. Troubleshooting decision tree & evidence locations

When status output looks wrong, check in this order:

1. The job is not in the [enabled] group → look at the [rejected] reason: field spelling / undeclared fields / trigger syntax / invalid `timeZone` / `enable` not a boolean / JSON parse failure.
2. A scheduled trigger seems to have been missed → check `in-progress runs:` in the job detail: with overlap=skip (default), a due trigger during an in-progress run is consumed in place (no catch-up fire) — the `last on-calendar elapse` line shows when the phase last advanced and `next` points at the next unconsumed trigger.
3. `failed/timeout` → cancelled at the runtimeMaxSec deadline; increase the value or check for a stuck run.
4. `failed/turn_error` → an error inside the run (a model/tool exception, or a missing model route: the framework rejects a turn whose provider/model pair is incomplete — the run record's `error` field carries the framework's message). If the error says the agent has no provider/model, set `run.model` — a `provider/model` string always resolves, while a bare model id needs the deployment to provide a default model selection (the host's agent-default-model service, or the settings source that service is built on); otherwise look at that run's session record.
5. `failed/create_failed` recurring → session creation failed; check the plugin log.
6. Abnormal behavior after re-enabling → check the state file `<jobsDir>/state/<id>.json` for corruption (an enabled job auto-resets with a `state note`; a disabled job keeps its in-memory state and records a note only).
7. A condition shows `[no future match]` and the job's `next` is none → neverMatch (see §5); not a fault — periodic triggering requires changing the job spec.
8. All trigger moments shifted together → suspected clock jump or system timezone change (see the clock & timezone bullet in §5); the plugin log records `clock rewound` / timezone-change entries.
9. No jobs appear in the status overview at all → the plugin failed to start, or it started degraded: an unavailable designated job directory, or a profile that cannot be detected uniquely (or a host without the framework's harness-home service), fails plugin start; a missing resolved default directory means a degraded start (no jobs loaded, no state persisted) — check the plugin log.

Evidence locations: the state file `<jobsDir>/state/<id>.json` (run records carry runId/sessionId — use the sessionId to look up the full run session record); the plugin log (prefix `dsh-timer`).
