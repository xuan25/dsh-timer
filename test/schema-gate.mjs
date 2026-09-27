// ajv pos/neg gate for the shipped JSON Schemas (draft 2020-12).
// Unlike selftest (zero-framework) and smoke (framework tool/skill paths), this gate
// checks the standalone schema files as any ecosystem consumer (ajv, IDEs, linters)
// would: it compiles both schemas and asserts their structural accept/reject behavior,
// including the at-least-one-non-null-trigger rule encoded in the job schema root
// allOf. The package tree only carries ajv 6 (a transitive eslint dependency,
// draft-07 only), so this gate pins the host tree's ajv 8 2020-12 build, the same
// tree the peer packages resolve from; the sanity check below fails if the pinned
// path ever resolves to a non-2020-12 build.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/ajv/dist/2020.js'

// Sanity: the pinned build must be the draft 2020-12 validator. `items: false`
// is only legal in 2020-12 (draft-07 requires items to be a schema or an array
// of schemas, so a draft-07 build fails to compile it); it must compile here
// and reject any item.
{
  let probe
  try {
    probe = new Ajv2020().compile({ type: 'array', items: false })
  } catch {
    throw new Error('pinned ajv build is not the draft 2020-12 validator (items:false failed to compile)')
  }
  if (probe(['a'])) throw new Error('pinned ajv build is not the draft 2020-12 validator (items:false accepted an item)')
}

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const jobSchema = JSON.parse(readFileSync(path.join(PKG, 'schemas', 'job.schema.json'), 'utf8'))
const stateSchema = JSON.parse(readFileSync(path.join(PKG, 'schemas', 'state.schema.json'), 'utf8'))

const ajv = new Ajv2020({ allErrors: true, strict: false })
const vJob = ajv.compile(jobSchema)
const vState = ajv.compile(stateSchema)

let failures = 0
function check(label, fn) {
  try {
    fn()
    console.log(`ok: ${label}`)
  } catch (e) {
    failures++
    console.log(`FAIL: ${label} — ${e.message}`)
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }
function expectValid(validator, name, data) {
  const r = validator(data)
  assert(r, `${name} should be VALID but got: ${(validator.errors || []).map((e) => `${e.instancePath} ${e.message}`).join('; ')}`)
}
function expectInvalid(validator, name, data) {
  const r = validator(data)
  assert(!r, `${name} should be INVALID`)
}

// ── job schema ──
check('job: valid minimal spec', () =>
  expectValid(vJob, 'job: valid minimal spec', { onCalendar: ['0 9 * * 1-5'], run: { prompt: 'p' } }))
check('job: null triggers + null run fields with one active trigger', () =>
  expectValid(vJob, 'job: null triggers + null run fields', { onCalendar: null, onActiveSec: null, onStartupSec: '30s', run: { prompt: 'p', cwd: null, preset: null, model: null, policy: null } }))
check('job: calendar-only spec', () =>
  expectValid(vJob, 'job: calendar only', { onCalendar: ['0 9 * * *'], run: { prompt: 'p' } }))
check('job: empty calendar array + startup trigger', () =>
  expectValid(vJob, 'job: array + startup', { onCalendar: [], onStartupSec: '5min', run: { prompt: 'p' } }))
// At-least-one-non-null-trigger rule, structurally encoded in the root allOf/not:
// a trigger that is missing or null counts as inactive; all three inactive = rejected.
check('job: all triggers null rejected by the schema itself', () =>
  expectInvalid(vJob, 'job: all triggers null', { onCalendar: null, onActiveSec: null, onStartupSec: null, run: { prompt: 'p' } }))
check('job: all triggers missing rejected by the schema itself', () =>
  expectInvalid(vJob, 'job: all triggers missing', { run: { prompt: 'p' } }))
check('job: two triggers missing + one null rejected', () =>
  expectInvalid(vJob, 'job: two missing one null', { onActiveSec: null, onStartupSec: null, run: { prompt: 'p' } }))
check('job: runtimeMaxSec null accepted (no limit)', () =>
  expectValid(vJob, 'job: runtimeMaxSec null', { onCalendar: ['0 9 * * *'], runtimeMaxSec: null, run: { prompt: 'p' } }))
check('job: runtimeMaxSec number rejected', () =>
  expectInvalid(vJob, 'job: runtimeMaxSec number', { onCalendar: ['0 9 * * *'], runtimeMaxSec: 42, run: { prompt: 'p' } }))
check('job: onCalendar wrong type', () =>
  expectInvalid(vJob, 'job: onCalendar wrong type', { onCalendar: 42, run: { prompt: 'p' } }))
check('job: run.prompt missing', () =>
  expectInvalid(vJob, 'job: run.prompt missing', { onCalendar: ['0 9 * * *'], run: {} }))
check('job: policy enum violation', () =>
  expectInvalid(vJob, 'job: policy enum violation', { onCalendar: ['0 9 * * *'], run: { prompt: 'p', policy: 'all' } }))
check('job: unknown top-level key', () =>
  expectInvalid(vJob, 'job: unknown top-level key', { onCalendar: ['0 9 * * *'], run: { prompt: 'p' }, bogus: 1 }))

// ── state schema ──
const goodState = { schemaVersion: 1, jobId: 'demo', lastActivationMs: null, lastTriggerMs: null, calendars: {}, runs: [] }
check('state: valid zero-run state', () =>
  expectValid(vState, 'state: valid zero-run state', goodState))
check('state: unknown extra key tolerated', () =>
  expectValid(vState, 'state: unknown extra key tolerated', { ...goodState, missed: [1], transient: 'x' }))
check('state: full calendars + settled run', () =>
  expectValid(vState, 'state: full calendars + settled run', {
    schemaVersion: 1, jobId: 'demo', lastActivationMs: 1750000000000, lastTriggerMs: 1750000000000,
    calendars: { '0 9 * * *': { value: '0 9 * * *', kind: 'cron', neverMatch: false, consumed: false, nextFireMs: 1750100000000 } },
    runs: [{ runId: 'r1', sessionId: 's1', trigger: 'scheduled', startedAt: 1750000000000, status: 'finished', cause: null, finishedAt: 1750000060000, durationMs: 60000, summary: '', error: null }],
  }))
check('state: legacy file without the job anchor tolerated', () =>
  expectValid(vState, 'state: legacy file without the job anchor tolerated', { schemaVersion: 1, jobId: 'demo', lastActivationMs: null, calendars: {}, runs: [] }))
check('state: evicted run record (optional fields omitted)', () =>
  expectValid(vState, 'state: evicted run record', { ...goodState, runs: [{ runId: 'r1', startedAt: 1, status: 'finished' }] }))
check('state: schemaVersion = 2', () =>
  expectInvalid(vState, 'state: schemaVersion = 2', { ...goodState, schemaVersion: 2 }))
check('state: calendars entry missing kind', () =>
  expectInvalid(vState, 'state: calendars entry missing kind', { ...goodState, calendars: { '0 9 * * *': { value: '0 9 * * *', neverMatch: false, consumed: false, nextFireMs: null } } }))
check('state: job anchor wrong type', () =>
  expectInvalid(vState, 'state: job anchor wrong type', { ...goodState, lastTriggerMs: 'nope' }))
check('state: startedAt string', () =>
  expectInvalid(vState, 'state: startedAt string', { ...goodState, runs: [{ runId: 'r1', startedAt: 'x', status: 'running' }] }))
check('state: calendars array', () =>
  expectInvalid(vState, 'state: calendars array', { ...goodState, calendars: [] }))
check('state: run entry missing runId', () =>
  expectInvalid(vState, 'state: run entry missing runId', { ...goodState, runs: [{ startedAt: 1, status: 'running' }] }))

console.log(failures === 0 ? 'schema gate: all checks passed' : `schema gate: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
