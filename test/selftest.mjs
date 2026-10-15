// dsh-timer selftest: pure-logic modules + croner probe vectors + runner settlement
// behavior probe (stub session, real dsh-session event envelope; no live framework services).
// Run: node test/selftest.mjs. All green = exit code 0.
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { JOB_ID_RE, TICK_MS, CLOCK_JUMP_MS, parseSpan, parseRuntimeMax, getProfileDir, canonicalJson, discoverProfileDir, resolveJobsDir } = await import(path.join(PKG, 'lib/util.js'))
const T = await import(path.join(PKG, 'lib/time.js'))
const C = await import(path.join(PKG, 'lib/cron.js'))
const R = await import(path.join(PKG, 'lib/rearm.js'))
const { validateJob } = await import(path.join(PKG, 'lib/validator.js'))
const S = await import(path.join(PKG, 'lib/state.js'))

let passed = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) passed++
  else failures.push(`${name}${extra ? ` - ${extra}` : ''}`)
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
}

// -- constants & job ids ---------------------------------------------
eq('TICK_MS', TICK_MS, 30_000)
eq('CLOCK_JUMP_MS', CLOCK_JUMP_MS, 1_000)
ok('JOB_ID_RE valid set', [
  JOB_ID_RE.test('a'), JOB_ID_RE.test('abc'), JOB_ID_RE.test('a-b-1'), JOB_ID_RE.test('9'),
  JOB_ID_RE.test('a'.repeat(64)),
].every(Boolean))
ok('JOB_ID_RE invalid set', [
  JOB_ID_RE.test(' '), JOB_ID_RE.test('ABC'), JOB_ID_RE.test('-abc'),
  JOB_ID_RE.test('a_b'), JOB_ID_RE.test('a.b'), JOB_ID_RE.test('a'.repeat(65)),
].every((x) => !x))
eq('getProfileDir non node_modules -> null', getProfileDir(PKG), null)
eq('getProfileDir node_modules hit', getProfileDir('/x/node_modules/dsh-timer'), '/x')

// -- parseSpan (systemd-style span) ---------------------------------
const SPAN_CASES = [
  ['30', 30_000], ['5min', 300_000], ['1h30min', 5_400_000], ['2d', 172_800_000],
  ['1h 30min', 5_400_000], ['0', 0], ['abc', null], ['1M', 2_592_000_000],
  ['1m', 60_000], ['90', 90_000], ['1w', 604_800_000], ['5usec', 0], ['2ms', 2],
  ['abc123', null], ['1x', null], ['1 min', null], ['1m30s', 90_000],
  ['5mins', 300_000], ['1minute', 60_000], ['2hours', 7_200_000],
  ['1year', 31_536_000_000], ['1month', 2_592_000_000], ['1M 2m', 2_592_120_000],
  ['30sec', 30_000], ['30sec5min', 330_000], ['1usec', 0],
  ['', null], [42, null],
]
for (const [v, want] of SPAN_CASES) eq(`parseSpan(${JSON.stringify(v)})`, parseSpan(v), want)
eq('parseSpan positive "0" -> null', parseSpan('0', { positive: true }), null)
eq('parseSpan positive "30" -> 30000', parseSpan('30', { positive: true }), 30_000)
eq('parseSpan positive "5usec" -> 0 (positive pre-round, rounds to 0)', parseSpan('5usec', { positive: true }), 0)
eq('parseSpan positive "1usec" -> 0 (positive pre-round, rounds to 0)', parseSpan('1usec', { positive: true }), 0)
eq('parseSpan "0.5ms" -> null (fractional component is not in the span grammar)', parseSpan('0.5ms'), null)
eq('parseRuntimeMax "0" -> null', parseRuntimeMax('0'), null)
eq('parseRuntimeMax "infinity" -> null', parseRuntimeMax('infinity'), null)
eq('parseRuntimeMax "10min" -> 600000', parseRuntimeMax('10min'), 600_000)
eq('parseRuntimeMax "30" -> 30000', parseRuntimeMax('30'), 30_000)
eq('parseRuntimeMax "1usec" -> 0 (positive pre-round, rounds to 0)', parseRuntimeMax('1usec'), 0)
eq('parseRuntimeMax "abc" -> undefined', parseRuntimeMax('abc'), undefined)
eq('parseRuntimeMax "-5" -> undefined', parseRuntimeMax('-5'), undefined)
eq('parseRuntimeMax null -> null (no limit)', parseRuntimeMax(null), null)
eq('parseRuntimeMax 42 -> undefined (numbers rejected)', parseRuntimeMax(42), undefined)

// -- canonical JSON (order-independent spec comparison; the hot-update re-adopt regression) -----
{
  eq('canonical equal under key reordering',
    canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } }),
    canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 }))
  ok('canonical discriminates where order-sensitive stringify does not',
    (() => {
      const A = { a: 1, b: 2 }
      const B = { b: 2, a: 1 }
      return JSON.stringify(A) !== JSON.stringify(B) && canonicalJson(A) === canonicalJson(B)
    })())
  eq('canonical nested keys sorted recursively, array element order kept',
    canonicalJson({ b: { z: 1, y: [2, 1] }, a: 0 }), canonicalJson({ a: 0, b: { y: [2, 1], z: 1 } }))
  ok('canonical array element order is significant', canonicalJson({ a: [1, 2] }) !== canonicalJson({ a: [2, 1] }))
  eq('canonical undefined object values omitted (JSON.stringify parity)', canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }))
  eq('canonical primitives', [canonicalJson(42), canonicalJson('x'), canonicalJson(null), canonicalJson(true), canonicalJson('a\nb')], ['42', '"x"', 'null', 'true', '"a\\nb"'])
}

// -- timezone utilities -----------------------------------------
eq('isValidTimeZone true/false sets', [
  T.isValidTimeZone('Asia/Shanghai'), T.isValidTimeZone('UTC'), T.isValidTimeZone('America/New_York'),
  !T.isValidTimeZone('Asia/Nope'), !T.isValidTimeZone(''), !T.isValidTimeZone('foo/bar/bad!'),
], [true, true, true, true, true, true])
eq('systemTimeZone shape', typeof T.systemTimeZone() === 'string' && T.systemTimeZone().length > 0, true, T.systemTimeZone())
eq('wallParts SH', T.wallParts(Date.parse('2026-08-24T16:00:00Z'), 'Asia/Shanghai'),
  { year: 2026, month: 8, day: 25, hour: 0, minute: 0, second: 0 })
eq('wallParts NY winter', T.wallParts(Date.parse('2026-01-15T12:00:00Z'), 'America/New_York'),
  { year: 2026, month: 1, day: 15, hour: 7, minute: 0, second: 0 })
eq('wallParts NY summer', T.wallParts(Date.parse('2026-07-15T12:00:00Z'), 'America/New_York'),
  { year: 2026, month: 7, day: 15, hour: 8, minute: 0, second: 0 })
eq('tzOffsetMs NY winter -5h', T.tzOffsetMs(Date.parse('2026-01-15T12:00:00Z'), 'America/New_York'), -18_000_000)
eq('tzOffsetMs NY summer -4h', T.tzOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'America/New_York'), -14_400_000)
eq('wallToMs winter inverse', T.wallToMs({ year: 2026, month: 1, day: 15, hour: 7, minute: 0, second: 0 }, 'America/New_York'), Date.parse('2026-01-15T12:00:00Z'))
eq('wallToMs summer inverse', T.wallToMs({ year: 2026, month: 7, day: 15, hour: 8, minute: 0, second: 0 }, 'America/New_York'), Date.parse('2026-07-15T12:00:00Z'))
eq('wallToMs DST gap -> null', T.wallToMs({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, 'America/New_York'), null)
eq('wallToMs normal after gap', T.wallToMs({ year: 2026, month: 3, day: 8, hour: 3, minute: 30, second: 0 }, 'America/New_York'), Date.parse('2026-03-08T07:30:00Z'))
eq('formatWall', T.formatWall(Date.parse('2026-08-24T16:00:00Z'), 'Asia/Shanghai'), '2026-08-25 00:00:00 (Asia/Shanghai)')
const dec = T.decodeSystemTimeZoneFromLocaltime()
ok('decodeSystemTimeZoneFromLocaltime shape', ['symlink', 'scanned', null].includes(dec.source) && (dec.tz === null || typeof dec.tz === 'string'), JSON.stringify(dec))
const det = T.makeTzChangeDetector()
eq('tz detector first call = baseline (false)', det(), false)
eq('tz detector unchanged (false)', det(), false)

// -- cron parsing / vectors -----------------------------------------
const BASE = Date.parse('2026-08-24T16:00:00Z')
function nextMs(value, tz, fromMs = BASE) {
  const cal = C.CalendarCondition.fromParsed(value, C.parseCalendarValue(value, tz), tz)
  return cal.nextMatch(fromMs)
}
eq('parseCalendarValue cron classification', C.parseCalendarValue('0 9 * * *', 'UTC'), { ok: true, kind: 'cron' })
eq('parseCalendarValue zoned +08', C.parseCalendarValue('2026-12-25T09:00:00+08:00', 'UTC').instantMs, Date.parse('2026-12-25T01:00:00Z'))
eq('parseCalendarValue zoned +05:30', C.parseCalendarValue('2026-06-15T12:30:00+05:30', 'UTC').instantMs, Date.parse('2026-06-15T07:00:00Z'))
eq('parseCalendarValue zoned -05:30', C.parseCalendarValue('2026-06-15T12:30:00-05:30', 'UTC').instantMs, Date.parse('2026-06-15T18:00:00Z'))
eq('parseCalendarValue Z suffix', C.parseCalendarValue('2026-06-15T12:30:00Z', 'UTC').instantMs, Date.parse('2026-06-15T12:30:00Z'))
eq('parseCalendarValue naive winter', C.parseCalendarValue('2026-01-15T12:30:00'.replace('12:30', '12:00'), 'America/New_York').instantMs, Date.parse('2026-01-15T17:00:00Z'))
eq('parseCalendarValue naive DST gap', C.parseCalendarValue('2026-03-08T02:30:00', 'America/New_York'), { ok: false, kind: 'iso', error: 'does not exist in timezone America/New_York (DST gap)' })
eq('parseCalendarValue naive after gap', C.parseCalendarValue('2026-03-08T03:30:00', 'America/New_York').instantMs, Date.parse('2026-03-08T07:30:00Z'))
eq('nextMatch on the hour (UTC)', nextMs('0 * * * *', 'UTC'), Date.parse('2026-08-24T17:00:00Z'))
eq('nextMatch 6-field seconds', nextMs('55 * * * * *', 'UTC'), Date.parse('2026-08-24T16:00:55Z'))
eq('nextMatch weekday (SH)', nextMs('0 12 * * 1-5', 'Asia/Shanghai'), Date.parse('2026-08-25T04:00:00Z'))
eq('nextMatch day 31 (SH)', nextMs('0 0 31 * *', 'Asia/Shanghai'), Date.parse('2026-08-30T16:00:00Z'))
eq('nextMatch DOM/DOW OR (SH)', nextMs('0 0 13 * 5', 'Asia/Shanghai'), Date.parse('2026-08-27T16:00:00Z'))
eq('nextMatch 2/31 never matches -> null', nextMs('0 0 31 2 *', 'UTC'), null)
eq('nextMatch 2/29 leap year', nextMs('0 0 29 2 *', 'UTC'), Date.parse('2028-02-29T00:00:00Z'))
eq('nextMatch 2/29 from 2027', nextMs('0 0 29 2 *', 'UTC', Date.parse('2027-01-01T00:00:00Z')), Date.parse('2028-02-29T00:00:00Z'))
eq('isNeverMatch 2/31', C.CalendarCondition.fromParsed('0 0 31 2 *', C.parseCalendarValue('0 0 31 2 *', 'UTC'), 'UTC').isNeverMatch(BASE), true)
eq('nextMatch strictly after from (on-the-hour boundary not reused)', nextMs('0 9 * * *', 'UTC', Date.parse('2026-08-24T09:00:00Z')), Date.parse('2026-08-25T09:00:00Z'))
eq('nextMatch from truncated to ms', nextMs('0 * * * *', 'UTC', Date.parse('2026-08-24T16:00:59Z') + 123), Date.parse('2026-08-24T17:00:00Z'))
const THROW_VECTORS = ['99 * * * *', '0 25 * * *', '* * 32 * *', '* * * * 9', 'a * * * *', '0 9 * *', '0 9 * * * * *']
for (const v of THROW_VECTORS) {
  let threw = false
  try { C.assertCronPattern(v, 'UTC') } catch { threw = true }
  ok(`assertCronPattern throws ${JSON.stringify(v)}`, threw)
}
ok('assertCronPattern valid does not throw', (() => { try { C.assertCronPattern('0 9 * * 1-5', 'Asia/Shanghai'); return true } catch { return false } })())

// -- validator matrix --------------------------------------------
const NOW = Date.parse('2026-09-20T00:00:00Z')
function vj(spec, opts = {}) { return validateJob(spec, { nowMs: NOW, defaultTz: 'UTC', ...opts }) }
function expectReject(name, spec, substr) {
  const r = vj(spec)
  ok(name, r.ok === false && r.errors.length > 0 && (substr === undefined || r.errors.some((e) => e.includes(substr))), `errors=${JSON.stringify(r.errors)}`)
}
{
  const r = vj({ onCalendar: ['0 9 * * *'], run: { prompt: 'p' } })
  ok('validator minimal valid ok', r.ok === true && r.errors.length === 0, JSON.stringify(r.errors))
  eq('validator defaults', [r.tz, r.persistent, r.defer, r.overlap, r.runtimeMaxMs, r.onUnitActiveSecMs, r.onStartupSecMs], ['UTC', false, false, 'skip', null, null, null])
  eq('validator calendars shape', r.calendars.length, 1)
  ok('validator calendars type', r.calendars[0].kind === 'cron' && typeof r.calendars[0].nextMatch === 'function')
  eq('validator cron condition tz defaults to defaultTz', r.calendars[0].tz, 'UTC')
  eq('validator neverMatch empty', r.neverMatch, [])
}
{
  const r = vj({
    onCalendar: ['0 9 * * 1-5', '2027-01-01T00:00:00+08:00'],
    onActiveSec: '1h30min', onStartupSec: '30s',
    timeZone: 'Asia/Shanghai', persistent: true, deferReactivation: true,
    runtimeMaxSec: '10min', overlap: 'stop',
    run: { prompt: 'p', cwd: '/tmp/x', preset: 'pp', model: 'mm', policy: 'read-only' },
  })
  ok('validator all-fields valid ok', r.ok === true, JSON.stringify(r.errors))
  eq('validator all-fields values', [r.tz, r.persistent, r.defer, r.overlap, r.runtimeMaxMs, r.onUnitActiveSecMs, r.onStartupSecMs], ['Asia/Shanghai', true, true, 'stop', 600_000, 5_400_000, 30_000])
  eq('validator dual triggers', r.calendars.map((c) => c.kind), ['cron', 'iso'])
  eq('validator zoned ISO wallParts null', r.calendars[1].wallParts, null)
  // every calendar condition carries the job's effective timezone (the job-level
  // timeZone, not the default timezone), so cron matching fires in the job tz.
  eq('validator cron condition tz = job-level timeZone', r.calendars[0].tz, 'Asia/Shanghai')
  // 2026-09-20T00:00:00Z = Sunday 08:00 Asia/Shanghai -> next weekday 09:00 SH = Monday 2026-09-21T01:00:00Z
  eq('validator cron condition nextMatch in job tz', r.calendars[0].nextMatch(NOW), Date.parse('2026-09-21T01:00:00Z'))
}
{
  const r = vj({ onCalendar: ['0 0 31 2 *'], run: { prompt: 'p' } })
  ok('validator neverMatch accepted + flagged', r.ok === true && r.neverMatch.length === 1 && r.neverMatch[0] === '0 0 31 2 *', JSON.stringify(r.neverMatch))
}
{
  const r = vj({ onCalendar: ['0 9 * * *', '0 9 * * *'], run: { prompt: 'p' } })
  eq('validator duplicate values deduped', r.calendars.length, 1)
}
{
  const r = vj({ onCalendar: ['2027-01-01T00:00:00Z'], runtimeMaxSec: '0', run: { prompt: 'p' } })
  ok('validator one-shot ISO + runtimeMaxSec 0 valid', r.ok === true && r.runtimeMaxMs === null && r.calendars[0].kind === 'iso', JSON.stringify(r.errors))
}
{ // naive ISO stores its wall components (the tz-change re-resolution input); the stored
  // wall time is tz-independent while instantMs follows the effective timezone
  const r = vj({ onCalendar: ['2027-01-01T09:00:00'], run: { prompt: 'p' } })
  ok('validator naive ISO valid (defaultTz)', r.ok === true && r.calendars[0].kind === 'iso', JSON.stringify(r.errors))
  eq('validator naive ISO resolved against defaultTz', r.calendars[0].instantMs, Date.parse('2027-01-01T09:00:00Z'))
  eq('validator naive ISO wallParts stored', r.calendars[0].wallParts, { year: 2027, month: 1, day: 1, hour: 9, minute: 0, second: 0 })
  const r2 = vj({ onCalendar: ['2027-01-01T09:00:00'], timeZone: 'Asia/Shanghai', run: { prompt: 'p' } })
  ok('validator naive ISO valid (job tz)', r2.ok === true, JSON.stringify(r2.errors))
  eq('validator naive ISO resolved against job tz', r2.calendars[0].instantMs, Date.parse('2027-01-01T01:00:00Z'))
  eq('validator naive ISO wallParts tz-independent', r2.calendars[0].wallParts, { year: 2027, month: 1, day: 1, hour: 9, minute: 0, second: 0 })
}
expectReject('validator spec not an object', null, 'spec is not an object')
expectReject('validator spec is an array', [1], 'spec is not an object')
expectReject('validator unknown top-level field', { onCalendar: ['0 9 * * *'], Bogus: 1, run: { prompt: 'p' } }, 'unknown top-level field')
expectReject('validator onCalendar not an array', { onCalendar: '0 9 * * *', run: { prompt: 'p' } }, 'array of strings')
expectReject('validator onCalendar empty string', { onCalendar: [''], run: { prompt: 'p' } }, 'empty string')
expectReject('validator missing trigger', { run: { prompt: 'p' } }, 'missing trigger')
expectReject('validator cron out of range 99 min', { onCalendar: ['99 * * * *'], run: { prompt: 'p' } })
expectReject('validator cron out of range 25 h', { onCalendar: ['0 25 * * *'], run: { prompt: 'p' } })
expectReject('validator cron 4 fields rejected', { onCalendar: ['0 9 * *'], run: { prompt: 'p' } })
expectReject('validator cron 7 fields rejected', { onCalendar: ['0 9 * * * * *'], run: { prompt: 'p' } })
expectReject('validator illegal cron char', { onCalendar: ['a * * * *'], run: { prompt: 'p' } })
{
  // deferReactivation on a monotonic-only job is accepted and ignored (no longer rejected).
  const rDefer = vj({ onActiveSec: '30s', deferReactivation: true, run: { prompt: 'p' } })
  ok('validator deferReactivation without onCalendar accepted (stored, ignored in rearm)', rDefer.ok === true && rDefer.defer === true, JSON.stringify(rDefer.errors))
}
expectReject('validator persistent not boolean', { onCalendar: ['0 9 * * *'], persistent: 'yes', run: { prompt: 'p' } }, 'must be a boolean')
expectReject('validator invalid timezone', { onCalendar: ['0 9 * * *'], timeZone: 'Asia/Nope', run: { prompt: 'p' } }, 'IANA')
expectReject('validator DST gap ISO rejected', { onCalendar: ['2026-03-08T02:30:00'], timeZone: 'America/New_York', run: { prompt: 'p' } }, 'DST gap')
expectReject('validator onActiveSec 0 rejected', { onActiveSec: '0', run: { prompt: 'p' } }, 'positive time span')
expectReject('validator onStartupSec invalid', { onStartupSec: 'abc', run: { prompt: 'p' } }, 'positive time span')
{
  // the three trigger fields accept null = explicitly not using that trigger
  // (treated as absent); null triggers do not satisfy the at-least-one-trigger requirement.
  const rn1 = vj({ onCalendar: null, onActiveSec: '30s', run: { prompt: 'p' } })
  ok('validator onCalendar null accepted (explicit non-use)', rn1.ok === true && rn1.calendars.length === 0, JSON.stringify(rn1.errors))
  const rn2 = vj({ onCalendar: ['0 9 * * *'], onActiveSec: null, run: { prompt: 'p' } })
  ok('validator onActiveSec null accepted (explicit non-use)', rn2.ok === true && rn2.onUnitActiveSecMs === null, JSON.stringify(rn2.errors))
  const rn3 = vj({ onCalendar: ['0 9 * * *'], onStartupSec: null, run: { prompt: 'p' } })
  ok('validator onStartupSec null accepted (explicit non-use)', rn3.ok === true && rn3.onStartupSecMs === null, JSON.stringify(rn3.errors))
  const rn4 = vj({ onCalendar: null, onActiveSec: null, onStartupSec: '30s', run: { prompt: 'p' } })
  ok('validator mixed null triggers normalize to absent', rn4.ok === true && rn4.calendars.length === 0 && rn4.onUnitActiveSecMs === null && rn4.onStartupSecMs === 30_000, JSON.stringify(rn4.errors))
  expectReject('validator all three triggers null -> missing trigger', { onCalendar: null, onActiveSec: null, onStartupSec: null, run: { prompt: 'p' } }, 'missing trigger')
  expectReject('validator onActiveSec invalid string still rejected', { onActiveSec: 'abc', run: { prompt: 'p' } }, 'positive time span')
  expectReject('validator onCalendar string rejected (not array, not null)', { onCalendar: 'x', run: { prompt: 'p' } }, 'array of strings')
}
expectReject('validator runtimeMaxSec invalid "abc"', { onCalendar: ['0 9 * * *'], runtimeMaxSec: 'abc', run: { prompt: 'p' } }, 'runtimeMaxSec invalid')
ok('validator runtimeMaxSec null valid (no limit)', (() => {
  const r = vj({ onCalendar: ['0 9 * * *'], runtimeMaxSec: null, run: { prompt: 'p' } })
  return r.ok === true && r.runtimeMaxMs === null
})())
expectReject('validator runtimeMaxSec number rejected', { onCalendar: ['0 9 * * *'], runtimeMaxSec: 42, run: { prompt: 'p' } }, 'runtimeMaxSec invalid')
expectReject('validator overlap invalid', { onCalendar: ['0 9 * * *'], overlap: 'queue', run: { prompt: 'p' } }, 'overlap invalid')
expectReject('validator missing run block', { onCalendar: ['0 9 * * *'] }, 'missing run block')
expectReject('validator run.prompt empty', { onCalendar: ['0 9 * * *'], run: { prompt: '  ' } }, 'run.prompt')
expectReject('validator run unknown field', { onCalendar: ['0 9 * * *'], run: { prompt: 'p', extra: 1 } }, 'unknown field in run')
expectReject('validator run.policy invalid', { onCalendar: ['0 9 * * *'], run: { prompt: 'p', policy: 'all' } }, 'run.policy invalid')
expectReject('validator run not an object', { onCalendar: ['0 9 * * *'], run: 'p' }, 'run must be an object')
{
  // run.cwd/preset/model/policy accept null (= explicit unset) and an empty string (= a legal string value).
  const rNull = vj({ onCalendar: ['0 9 * * *'], run: { prompt: 'p', cwd: null, preset: null, model: null, policy: null } })
  ok('validator run.* null accepted (explicit unset)', rNull.ok === true, JSON.stringify(rNull.errors))
  const rEmpty = vj({ onCalendar: ['0 9 * * *'], run: { prompt: 'p', cwd: '', preset: '', model: '' } })
  ok('validator run.* empty string accepted', rEmpty.ok === true, JSON.stringify(rEmpty.errors))
  expectReject('validator run.cwd non-string non-null rejected', { onCalendar: ['0 9 * * *'], run: { prompt: 'p', cwd: 42 } }, 'run.cwd must be a string or null')
  expectReject('validator run.model non-string non-null rejected', { onCalendar: ['0 9 * * *'], run: { prompt: 'p', model: 42 } }, 'run.model must be a string or null')
  expectReject('validator run.policy non-string non-null rejected', { onCalendar: ['0 9 * * *'], run: { prompt: 'p', policy: 42 } }, 'run.policy invalid')
}
{
  // the tool schema must declare the same null branches as
  // job.schema.json for the eight null-tolerant fields (the three
  // trigger fields + the four run.* fields + runtimeMaxSec, where null = no limit); the
  // framework validates arguments against the tool schema before execute, so a schema
  // without a null branch makes the documented null contract unreachable on the tool path.
  // Source-level sync guard: this selftest has zero framework dependencies and cannot run
  // that validation itself.
  const toolSrc = readFileSync(path.join(PKG, 'src/tool.ts'), 'utf8')
  const jobSchema = JSON.parse(readFileSync(path.join(PKG, 'schemas', 'job.schema.json'), 'utf8'))
  function fieldNode(src, field) {
    const i = src.indexOf(`${field}: {`)
    if (i < 0) return ''
    let depth = 0
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') {
        depth--
        if (depth === 0) return src.slice(i, j + 1)
      }
    }
    return ''
  }
  for (const f of ['onCalendar', 'onActiveSec', 'onStartupSec', 'runtimeMaxSec']) {
    const jt = jobSchema.properties[f].type
    ok(`contract sync: job.schema.json ${f} is null-tolerant`, Array.isArray(jt) && jt.includes('null'))
    ok(`contract sync: tool schema ${f} declares a null branch`, fieldNode(toolSrc, f).includes("type: 'null'"))
  }
  const runNode = fieldNode(toolSrc, 'run')
  for (const f of ['cwd', 'preset', 'model', 'policy']) {
    const jt = jobSchema.properties.run.properties[f].type
    ok(`contract sync: job.schema.json run.${f} is null-tolerant`, Array.isArray(jt) && jt.includes('null'))
    ok(`contract sync: tool schema run.${f} declares a null branch`, fieldNode(runNode, f).includes("type: 'null'"))
  }
}
{
  // the plugin ships no host-absolute run path and no directory layout of its own: a job's
  // run root is either the creating session's workspace itself (inherited at add time,
  // persisted into the job file) or the spec's explicit run.cwd - there is no
  // deployment-declared default run root and no per-job subpath. Bind the code shape and
  // the schema description so the artifact sites cannot drift apart.
  const runnerSrc = readFileSync(path.join(PKG, 'src/runner.ts'), 'utf8')
  const cwdDesc = JSON.parse(readFileSync(path.join(PKG, 'schemas', 'job.schema.json'), 'utf8')).properties.run.properties.cwd.description
  ok('contract sync: the schema says inheritance lands on the session workspace itself, with no subpath', cwdDesc.includes('<session-cwd>') && !cwdDesc.includes('timer/runs'))
  ok('contract sync: runner takes the run cwd from the spec only (no derivation of its own)', runnerSrc.includes('const cwd = spec.cwd'))
  ok('contract sync: runner fails the run create_failed when the spec sets no run cwd', runnerSrc.includes('has no run cwd: set run.cwd in the job spec'))
}
{
  // decoupling guard: no source file carries a host-absolute run path (the fixed
  // deployment constant is gone; every run root is a caller session fact or an explicit
  // job value), and neither a deployment-declared default run root (the config field, the
  // env variable, and the derivation are all removed: an undetermined run root fails
  // closed instead) nor a per-job run-directory subpath exists on the artifact surface
  // (inheritance lands on the creating session's workspace itself).
  const srcFiles = readdirSync(path.join(PKG, 'src')).filter((f) => f.endsWith('.ts'))
  // The token is assembled from parts: the hygiene guard below scans this file for the
  // contiguous host-path literal, so the guard's own needle must not spell it out.
  const hostPathToken = '/' + 'workspace' + '/'
  const withHostPath = srcFiles.filter((f) => readFileSync(path.join(PKG, 'src', f), 'utf8').includes(hostPathToken))
  ok('decoupling: no src file carries a host-absolute run path', withHostPath.length === 0, withHostPath.join(','))
  const rootToken = 'defaultRunCwdRoot'
  const subToken = 'DEFAULT_RUN_ROOT_SUBDIR'
  const rootHit = []
  for (const f of srcFiles) {
    const src = readFileSync(path.join(PKG, 'src', f), 'utf8')
    if (src.includes(rootToken) || src.includes(subToken)) rootHit.push(f)
  }
  for (const f of ['README.md', path.join('schemas', 'job.schema.json'), path.join('skill', 'dsh-timer', 'SKILL.md')]) {
    const src = readFileSync(path.join(PKG, f), 'utf8')
    if (src.includes(rootToken) || src.includes('DSH_TIMER_RUN_CWD_ROOT') || src.includes('timer/runs')) rootHit.push(f)
  }
  ok('decoupling: no deployment-declared default run root or per-job subpath on the artifact surface', rootHit.length === 0, rootHit.join(','))
}
{
  // source-level guards for the run executor's
  // bounded create and immediate-failure paths. This selftest has zero framework
  // dependencies and cannot drive startRun behaviorally (it needs the framework ctx), so
  // the behaviors are bound to their code shape here; the behavioral side is covered by
  // host-side acceptance.
  const runnerSrc = readFileSync(path.join(PKG, 'src/runner.ts'), 'utf8')
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  ok('contract sync: runner declares CREATE_TIMEOUT_MS = 300_000', runnerSrc.includes('CREATE_TIMEOUT_MS = 300_000'))
  ok('contract sync: runner arms the create deadline on the cordis timer service', runnerSrc.includes('ctx.timeout(() => {') && runnerSrc.includes(', CREATE_TIMEOUT_MS)'))
  ok('contract sync: runner races create against the deadline signal', runnerSrc.includes('Promise.race([') && runnerSrc.includes('deadlineSignal'))
  ok('contract sync: runner settles a timed-out create as create_failed', runnerSrc.includes('agent create timed out after ${CREATE_TIMEOUT_MS}ms'))
  ok('contract sync: runner cancels + disposes the late-resolving agent (orphan protection)', runnerSrc.includes("late.agent.cancel({ kind: 'user' })") && runnerSrc.includes('late.dispose()'))
  ok('contract sync: runner fails the run immediately on run-cwd creation failure', runnerSrc.includes('failed to create run directory ${cwd}: ${errMsg(err)}') && runnerSrc.includes('return failCreate('))
  ok('contract sync: scheduler tick is single-flight (overlapping intervals dropped)', schedulerSrc.includes('if (this.tickInFlight) return') && schedulerSrc.includes('this.tickInFlight = false'))
}
{
  // source-level guards for the interrupted
  // settlement paths. A settled interrupted run carries the pinned
  // error string, so both backfill mechanisms (graceful-exit settlement and startup
  // backfill) write the same record shape. A stop or process-exit interrupt
  // landing in the create window (handle not yet assigned) is delivered to the
  // just-created turn, and the no-turn/end settlement shortcut settles it truthfully.
  // The state schema's trigger description/example use the four-value
  // enum instead of the earlier condition-name wording.
  const runnerSrc = readFileSync(path.join(PKG, 'src/runner.ts'), 'utf8')
  const stateSchemaSrc = readFileSync(path.join(PKG, 'schemas', 'state.schema.json'), 'utf8')
  ok('contract sync: runner settles interrupted runs with the pinned error string', runnerSrc.includes("'interrupted by process restart'"))
  ok('contract sync: runner delivers a late stop or interrupt to a just-created turn', runnerSrc.includes("run.pendingCause === 'cancelled' || run.pendingCause === 'interrupted'"))
  ok('contract sync: runner settles a no-turn/end interrupted run from pendingCause', runnerSrc.includes("run.pendingCause === 'interrupted'") && runnerSrc.includes("outcome = { status: 'failed', cause: run.pendingCause }"))
  ok('contract sync: state schema trigger describes the four-value enum', stateSchemaSrc.includes('one of scheduled, monotonic, startup, manual'))
  ok('contract sync: state schema trigger example is a real trigger value', stateSchemaSrc.includes('"trigger": "scheduled"') && !stateSchemaSrc.includes('"trigger": "onActiveSec"'))
}
{
  // all three cancel paths (tick overlap=stop,
  // disable --now via cancelActiveRuns, cancel verb) go through the shared markCancelled guard,
  // so a run already carrying a first-recorded cause (e.g. an in-flight runtimeMaxSec timeout)
  // is never re-marked 'cancelled' and keeps its original settlement attribution. The
  // pinned rescan report line is built once (rescanLine) and used by both the rescan log and
  // the reload verb report, so the two can no longer drift. The state schema example
  // shows a UUID sessionId on the running record (the sole writer always emits a UUID); the
  // tolerant ["string", "null"] type branch stays for foreign-file leniency.
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  const stateSchemaSrc = readFileSync(path.join(PKG, 'schemas', 'state.schema.json'), 'utf8')
  ok('contract sync: all three cancel paths go through the guarded markCancelled helper', schedulerSrc.includes('private markCancelled(') && schedulerSrc.includes('if (run.settled || run.pendingCause !== null) return false') && schedulerSrc.includes("this.markCancelled(model.id, r, 'stop cancel')") && schedulerSrc.includes("this.markCancelled(idKey, run, 'cancel send')") && schedulerSrc.includes("this.markCancelled(model.id, run, 'disable cancel')"))
  ok('contract sync: pinned rescan report line built by one shared rescanLine builder', schedulerSrc.includes('private rescanLine(') && schedulerSrc.includes('this.logger.info(this.rescanLine(summary))') && schedulerSrc.includes('this.rescanLine(r)'))
  ok('contract sync: state schema example running record carries a UUID sessionId', stateSchemaSrc.includes('"sessionId": "1a2b3c4d-5e6f-4a5b-8c7d-9e0f1a2b3c4d"') && !stateSchemaSrc.includes('"sessionId": null') && stateSchemaSrc.includes('"type": ["string", "null"]'))
}
{
  // the shipped prompt wrapper pins
  // English convention line; guard the doc<->code string match so a CJK re-translation or
  // rewording of the prompt wrapper breaks the gate instead of silently drifting.
  const runnerSrc = readFileSync(path.join(PKG, 'src/runner.ts'), 'utf8')
  ok('contract sync: runner prompt wrapper ships the pinned English convention line', runnerSrc.includes('export function buildRunPrompt(taskPrompt: string)') && runnerSrc.includes('(This is a ${PLUGIN_NAME} scheduled task run. When the task is done, output a plain-text result summary of 1-5 sentences, and nothing else.)'))
}
{
  // loadState strips ALL unknown extra keys at
  // every level (top / calendar entries / run records), so "tolerated = never written back"
  // is literally true (source guard + behavioral round-trip through a foreign-keyed file).
  // In-flight runs are attributed to the model instance that started them (run.model,
  // captured at creation); a job deleted + recreated under the same id never inherits a stale
  // generation's in-flight runs in overlap / status / cancel / disable (source guard; the
  // behavior is framework-gated and covered by host-side acceptance).
  const stateSrc = readFileSync(path.join(PKG, 'src/state.ts'), 'utf8')
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  ok('contract sync: loadState normalizes away all unknown extra keys', stateSrc.includes('export function normalizeState(') && stateSrc.includes("['schemaVersion', 'jobId', 'lastActivationMs', 'lastTriggerMs', 'calendars', 'runs']") && stateSrc.includes("['value', 'kind', 'neverMatch', 'consumed', 'nextFireMs']") && stateSrc.includes("['runId', 'sessionId', 'trigger', 'startedAt', 'finishedAt', 'durationMs', 'status', 'cause', 'summary', 'error']") && /normalizeState\(s\)/.test(stateSrc) && !stateSrc.includes('delete (s as { missed?: unknown }).missed'))
  ok('contract sync: in-flight runs filtered to the owning model instance', schedulerSrc.includes('private ownedRuns(model: JobModel): RunRecord[]') && schedulerSrc.includes('run.model === model') && (schedulerSrc.match(/this\.ownedRuns\(model\)/g) ?? []).length >= 3 && schedulerSrc.includes('private cancelActiveRuns(model: JobModel): number'))
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'timer-selftest-'))
    const file = path.join(dir, 'probe.json')
    try {
      writeFileSync(file, JSON.stringify({
        schemaVersion: 1, jobId: 'probe', lastActivationMs: null,
        missed: 3, operatorNote: 'foreign top-level key',
        // lastTriggerMs inside a calendar entry is a tolerated foreign key (the anchor is
        // job-level), stripped on load
        calendars: { '0 9 * * *': { value: '0 9 * * *', kind: 'cron', neverMatch: false, consumed: false, lastTriggerMs: null, nextFireMs: null, stale: true } },
        runs: [{ runId: 'r1', startedAt: 1, status: 'finished', cause: null, followedBy: 'foreign run key' }],
      }, null, 2) + '\n', { flag: 'w' })
      const r = await S.loadState(file)
      ok('state loadState unknown keys tolerated at all levels', r.state !== null && r.corrupt === false)
      if (r.state) {
        ok('state loadState strips foreign top-level keys on load', !('missed' in r.state) && !('operatorNote' in r.state) && Object.keys(r.state).sort().join(',') === 'calendars,jobId,lastActivationMs,lastTriggerMs,runs,schemaVersion')
        const cal = r.state.calendars['0 9 * * *']
        ok('state loadState strips legacy per-condition anchor and foreign calendar keys on load', !!cal && !('stale' in cal) && !('lastTriggerMs' in cal) && Object.keys(cal).sort().join(',') === 'consumed,kind,neverMatch,nextFireMs,value')
        const rec = r.state.runs[0]
        ok('state loadState strips foreign run keys on load', !!rec && !('followedBy' in rec) && Object.keys(rec).sort().join(',') === 'cause,runId,startedAt,status')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
{
  // hot-update and span/doc contract fixes:
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  // The enabled->disabled flip branch hot-updates the spec and reloads state before the
  // registry move (symmetric with the disabled->disabled and disabled->enabled paths).
  const inJobsBlock = schedulerSrc.slice(
    schedulerSrc.indexOf('if (inJobs) {'),
    schedulerSrc.indexOf('const inDisabled = this.disabledJobs.get(id)'),
  )
  const flipBranch = inJobsBlock.slice(
    inJobsBlock.indexOf('if (!enabled) {'),
    inJobsBlock.indexOf('if (canonicalJson(v.spec) === canonicalJson(inJobs.spec))'),
  )
  ok('enabled->disabled flip hot-updates spec, reloads state and rebuilds calendars', flipBranch.includes('this.applySpecUpdate(inJobs, v)') && flipBranch.includes('this.cancelActiveRuns(inJobs)') && flipBranch.includes('this.jobs.delete(id)') && flipBranch.includes('this.disabledJobs.set(id, inJobs)') && flipBranch.includes('this.reloadJobState(inJobs)') && flipBranch.includes('this.buildCalendars(inJobs, nowMs)'))
  ok('spec update precedes the registry move in the flip branch', flipBranch.indexOf('applySpecUpdate(inJobs, v)') !== -1 && flipBranch.indexOf('applySpecUpdate(inJobs, v)') < flipBranch.indexOf('this.jobs.delete(id)'))
  // fmtNext (shared by list and detail modes) prints ms units and reports the earliest due label.
  const fmtNext = schedulerSrc.slice(schedulerSrc.indexOf('private fmtNext('), schedulerSrc.indexOf('/** Single-job detail'))
  ok('fmtNext span labels use ms units in both modes', fmtNext.includes('onActiveSec ${model.monotonicSpanMs}ms') && fmtNext.includes('onStartupSec ${model.startupSpanMs}ms') && !fmtNext.includes('/ 1000).toString()}s'))
  ok('due candidates are sorted by time before the earliest due label is reported', fmtNext.slice(fmtNext.indexOf('const due'), fmtNext.indexOf('is due')).includes('.sort((a, b) => a.at - b.at)'))
  ok('dead neverMatch re-check removed from the detail condition line', !schedulerSrc.includes('if (!cond.neverMatch)'))
  // Shipped docs state the word-form unit set (the implementation superset SPAN_CASES pins),
  // not a closed 9-unit set.
  const readme = readFileSync(path.join(PKG, 'README.md'), 'utf8')
  const skillMd = readFileSync(path.join(PKG, 'skill/dsh-timer/SKILL.md'), 'utf8')
  ok('README span syntax lists the word-form unit set and drops the closed-set claim', readme.includes('`us`/`usec`') && readme.includes('`m`/`min`/`mins`/`minute(s)`') && readme.includes('`y`/`year(s)`') && !readme.includes('closed unit set'))
  ok('SKILL span syntax mentions word-form acceptance', skillMd.includes('word forms accepted'))
}
{
  // doc-drift fix:
  // state run records accept sessionId as string | null (tolerant state-schema side). The
  // plugin never writes null itself (only generated UUID strings or an absent key), so the
  // tolerant contract is pinned on the read side: docstring wording + schema type.
  const stateSrc = readFileSync(path.join(PKG, 'src/state.ts'), 'utf8')
  const stateSchemaSrc = readFileSync(path.join(PKG, 'schemas', 'state.schema.json'), 'utf8')
  ok('state.ts checkStateShape docstring states sessionId (string | null)', stateSrc.includes('when present, sessionId (string | null), trigger (string)'))
  ok('state.schema.json keeps the tolerant sessionId type string|null', /"sessionId"\s*:\s*\{\s*"type"\s*:\s*\[\s*"string"\s*,\s*"null"\s*\]/.test(stateSchemaSrc))
}
{
  // ctx.agents.create is
  // async - every create failure arrives as a promise rejection, never as a synchronous
  // throw - so the old try/catch around the call was dead code, and the race's create
  // branch carried no onRejected handler: a rejected create escaped startRun (its declared
  // StartRunResult was never reached), could abort the tick's job for-loop (sibling jobs
  // missing their trigger), and left the already-registered run record unsettled (in-memory
  // zombie; default overlap=skip then stalls the job until process restart). Now the race
  // converts the rejection into a failed result settled through failCreate, and the tick /
  // manualRun loops contain any unforeseen rejection per job (settleUnsettledRun).
  const runnerSrc = readFileSync(path.join(PKG, 'src/runner.ts'), 'utf8')
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  ok('runner.ts race create branch has an onRejected handler (rejection -> failed result)', runnerSrc.includes('(err): { failed: string } => ({ failed: errMsg(err) })'))
  ok('runner.ts settles a rejected create through failCreate (agent create failed: ...)', runnerSrc.includes("if ('failed' in createResult)") && runnerSrc.includes('agent create failed: '))
  ok('scheduler.ts contains the per-job startRun rejection guard (tick + manualRun)', (schedulerSrc.match(/unexpected startRun rejection/g) ?? []).length >= 2)
}
{
  // add = create only, and a missing id fails fast:
  // the job-id assertion must reject a missing id before any String() coercion - the
  // literal "undefined" is a grammatically legal job id, so coercing String(undefined)
  // would turn an omitted id argument into a silently created job named "undefined".
  // add no longer overwrites: a job whose file already exists is rejected before any
  // write (the existing job's spec and state files are untouched); replacing a job is a
  // delete followed by an add - the delete also removes the state file, so next-fire
  // times and one-shot marks do not survive the replacement. The tool description and
  // SKILL.md carry the full create-only wording; the README pins it on the verb rows
  // (create-only on the add row, state-file wipe on the delete row).
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  const toolSrc = readFileSync(path.join(PKG, 'src/tool.ts'), 'utf8')
  const skillMd = readFileSync(path.join(PKG, 'skill/dsh-timer/SKILL.md'), 'utf8')
  const readmeMd = readFileSync(path.join(PKG, 'README.md'), 'utf8')
  ok('assertJobId rejects a missing id before any String() coercion', schedulerSrc.includes("if (typeof id !== 'string') throw new Error('job id is required"))
  ok('addJob rejects an existing job id and never overwrites (the overwrote verb is gone)', schedulerSrc.includes('already exists; delete it first') && !schedulerSrc.includes('overwrote'))
  ok('the tool description states add is create-only', toolSrc.includes('it fails if a job with the same id already exists'))
  ok('SKILL.md states the delete state-file wipe on the add row', skillMd.includes('which also removes its state file'))
  ok('README pins create-only on the add row and the state-file wipe on the delete row', readmeMd.includes('rejects if the id already exists') && readmeMd.includes('deletes the job file and its state file'))
  ok('SKILL.md troubleshooting maps the missing-id and already-exists failures', skillMd.includes('a separate tool argument of the verb') && skillMd.includes('already exists'))
  // update = update only (the mirror of create-only add): the job file must exist, the
  // whole spec is replaced in place after validation (an invalid spec leaves the existing
  // file untouched), and the state file is never removed - run history, phase anchors and
  // one-shot marks survive exactly like a manual edit of the job file (state is keyed by
  // job id, independent of spec content). A changed trigger reschedules from the existing
  // anchor (no phase reset); in-progress runs keep executing the spec they started with.
  const upd = schedulerSrc.slice(schedulerSrc.indexOf('async updateJob('), schedulerSrc.indexOf('async deleteJob('))
  ok('updateJob rejects an unknown id and points to add', upd.includes('not found; add creates it'))
  ok('updateJob validates the spec before the file write', upd.includes('validateJob(spec') && upd.indexOf('validateJob(spec') < upd.indexOf('writeJsonFile'))
  ok('updateJob never removes the state file', !upd.includes('unlinkStateFile') && !upd.includes('fsp.unlink'))
  ok('the tool description states update is update-only and preserves the job state file', toolSrc.includes('update replaces the spec of an existing job in place') && toolSrc.includes('the job state file is preserved'))
  ok('VERBS carries the update verb and the dispatch routes it to updateJob', toolSrc.includes("'reload', 'status', 'run', 'enable', 'disable', 'add', 'update', 'delete', 'cancel'") && toolSrc.includes("case 'update':") && toolSrc.includes('scheduler.updateJob(args?.id, args?.spec, caller)'))
  ok('README pins update-only and state preservation on the update row', readmeMd.includes('replaces the spec of an existing job in place') && readmeMd.includes("the job's state file is preserved"))
  ok('SKILL.md states the update state preservation on the update row', skillMd.includes('the state file is preserved'))
  ok('SKILL.md troubleshooting maps the update not-found failure and the rejected-job repair', skillMd.includes('no job file with that id') && skillMd.includes('promotes it out of rejected'))
}
{
  // tick/create decoupling:
  // the tick never awaits startRun - a due job's create is a detached self-settling
  // lifecycle (the CREATE_TIMEOUT_MS deadline is the only escape for a hung create;
  // failCreate / onRunEnd settle the run and its state file; process restart backfills a
  // record the previous process could not settle), so one job's hung create can no longer
  // delay the tick's remaining jobs or later ticks. The tick's create-failed fire
  // bookkeeping moves into the detached .then continuation (it runs at create settlement -
  // the same moment the old post-await bookkeeping ran); an unforeseen startRun rejection
  // is contained per job by the continuation's rejection handler (settleUnsettledRun). The
  // manual path still awaits startRun (the operator gets the result).
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  ok('tick kicks startRun off detached (void + .then continuation, never awaited)', schedulerSrc.includes('void startRun(') && schedulerSrc.includes(').then('))
  ok('only the manual path awaits startRun', (schedulerSrc.match(/await startRun\(/g) ?? []).length === 1)
  ok('tick() is synchronous (no suspension points; the reentrancy guard is structurally defensive)', schedulerSrc.includes('private tick(): void'))
  ok('create-failed fire bookkeeping runs in the detached continuation (both .then branches)', (schedulerSrc.match(/this\.bookkeepCreateFailed\(/g) ?? []).length === 2)
}
{
  // deterministic exit-side settlement:
  // stop() no longer only marks pendingCause - before it resolves it settles every
  // unsettled run as failed (first-recorded-cause-wins: a pre-existing cancelled/timeout
  // beats the exit mark; the error mapping is identical to the runner's whenIdle
  // settlement so both settlement mechanisms write the same record shape), raises the
  // settled flag before settlement so a still-pending whenIdle IIFE bails out without a
  // second write, and awaits one state-file write per affected model (deterministic
  // exit-side write - unlike the fire-and-forget settlement persists, it lands before the
  // process exits). The plugin disposer awaits stop() (the framework awaits the disposer).
  // The tick interval is disposed before settlement and the tick's stopped guard no-ops a
  // late interval callback, so exit latency is O(1) + disk write, no tick-period
  // component. Startup backfill remains the crash/kill net.
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  const indexSrc = readFileSync(path.join(PKG, 'src/index.ts'), 'utf8')
  ok('stop() is async (deterministic settlement before it resolves)', schedulerSrc.includes('async stop(): Promise<void>'))
  ok('the plugin disposer awaits stop()', indexSrc.includes('await this.scheduler.stop()'))
  ok('the tick no-ops after exit has begun (late interval callback race)', schedulerSrc.includes('no new run is dispatched after exit has begun'))
  ok('the exit path preserves a first-recorded cause (cancelled/timeout beats interrupted)', schedulerSrc.includes("if (!run.pendingCause) run.pendingCause = 'interrupted'"))
  ok('the exit-side settlement uses the shared shipped interrupted error string', schedulerSrc.includes("'interrupted by process restart'"))
  ok('the exit path awaits one state-file write per affected model', schedulerSrc.includes('await this.persistStateFile(model)'))
  ok('settlement targets are collected per run model (deleted models excluded)', schedulerSrc.includes('settleTargets'))
}
{
  // overlap=skip
  // consumes a due trigger in place (systemd-faithful: the phase advances at the due moment;
  // a run longer than the interval swallows grid points; no catch-up fire after the run ends).
  // The shipped SKILL.md/README must carry the consume wording and must not resurrect the
  // deprecated make-up-fire wording; the status detail reports the job-level last on-calendar elapse.
  const skillMd = readFileSync(path.join(PKG, 'skill/dsh-timer/SKILL.md'), 'utf8')
  const readmeMd = readFileSync(path.join(PKG, 'README.md'), 'utf8')
  ok('SKILL.md overlap bullet states consume-in-place semantics', skillMd.includes('consumed in place'))
  ok('SKILL.md overlap bullet states overlong runs swallow grid points', skillMd.includes('swallows grid points'))
  ok('the deprecated make-up-fire wording is gone from SKILL.md', !skillMd.includes('one delayed make-up fire') && !skillMd.includes('true: no make-up run') && !skillMd.includes('(no make-up run)'))
  ok('SKILL.md status row reports the job-level last on-calendar elapse', skillMd.includes('job-level last on-calendar elapse'))
  ok('README overlap row states consume-in-place semantics', readmeMd.includes('consumes the trigger in place') && readmeMd.includes('swallows grid points'))
  ok('the deprecated recompute wording is gone from README', !readmeMd.includes('max(runEnd, lastTrigger)'))
}
{
  // the deprecated make-up term is
  // renamed to the established catch-up term in the entire shipped
  // surface (SKILL.md / README.md / job.schema.json consume-wording negations now read
  // "no catch-up fire") and in the src comments that mirror them; zero make-up residue remains
  // in any of those files. The phrase guard above stays as the historical regression layer.
  const skillMd = readFileSync(path.join(PKG, 'skill/dsh-timer/SKILL.md'), 'utf8')
  const readmeMd = readFileSync(path.join(PKG, 'README.md'), 'utf8')
  const jobSchema = readFileSync(path.join(PKG, 'schemas/job.schema.json'), 'utf8')
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  const typesSrc = readFileSync(path.join(PKG, 'src/types.ts'), 'utf8')
  ok('no make-up term remains in shipped SKILL.md', !skillMd.includes('make-up'))
  ok('no make-up term remains in shipped README.md', !readmeMd.includes('make-up'))
  ok('no make-up term remains in shipped job.schema.json', !jobSchema.includes('make-up'))
  ok('no make-up term remains in src/scheduler.ts', !schedulerSrc.includes('make-up'))
  ok('no make-up term remains in src/types.ts', !typesSrc.includes('make-up'))
}
{
  // minor fixes: runner settlement crash guard, persistStateFile
  // delete race closure, stop() best-effort run-session dispose):
  // m1: the whenIdle IIFE's settlement body is wrapped in a defensive try/catch - an unexpected
  // throw (event parsing / bookkeeping defect) logs and settles the run as failed/turn_error
  // (degraded settlement, itself guarded) instead of escaping the detached promise as an
  // unhandled rejection (Node default: the host process would crash).
  // m2: persistStateFile re-checks model.deleted before the write and, as the sole state-file
  // writer, removes the file again (best effort) when the job is deleted while the write is in
  // flight - a job deleted during the write window no longer leaves a re-created orphan state
  // file behind after its own unlink.
  // m3: stop() disposes the run session (best effort) in addition to cancelling it - the run's
  // whenIdle IIFE bails out at its settled check and never reaches its own dispose, so without
  // this the agent handles of interrupted runs would linger in memory on the in-process-unload
  // path until the process exits.
  const runnerSrc = readFileSync(path.join(PKG, 'src/runner.ts'), 'utf8')
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  ok('a settlement-body throw logs and settles the run as failed/turn_error', runnerSrc.includes('run settlement threw'))
  ok('the degraded settlement error string marks the settlement failure', runnerSrc.includes('settlement failed: '))
  ok('persistStateFile no-ops for a deleted job', schedulerSrc.includes('if (model.deleted) return Promise.resolve()'))
  ok('a state write landing after a delete removes the file again (sole writer closes the race)', schedulerSrc.includes('fsp.unlink(this.stateFileOf(model.id))'))
  ok('stop() disposes the run session of an interrupted run (best effort)', schedulerSrc.includes('run.handle?.dispose()'))
}
{
  // the settlement recompute gate was keyed to model.latestRunId -
  // the most recently STARTED run - so a non-latest settlement (an earlier parallel run
  // ending under overlap=allow, a stop-cancelled run) never recomputed, leaving stale armed
  // deadlines that fired at grid points a spec-compliant recompute would skip (a catch-up
  // fire):
  // per systemd's re-arm-on-deactivation (timer.c timer_trigger_notify case TIMER_RUNNING),
  // a full recompute of all trigger conditions runs only when the settled run was the LAST
  // in-flight run (the in-flight set becomes empty). Intermediate settlements (an earlier
  // parallel run under overlap=allow, a stop-cancelled run, a user cancellation) only
  // record and trigger no recompute - which structurally eliminates the stop-replacement
  // cascade (no cancellation-origin plumbing needed). create_failed settlements stay
  // excluded (their re-arm is owned by bookkeepCreateFailed). The latestRunId model field
  // and its latestRunMemory plumbing (the gate was the sole reader) are removed as dead state.
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  const typesSrc = readFileSync(path.join(PKG, 'src/types.ts'), 'utf8')
  ok('the settlement recompute gate is the deactivation check (in-flight set empty), not the latest-run anchor', schedulerSrc.includes('this.ownedRuns(live).length === 0'))
  ok('the latestRunId gate conjunction is gone', !schedulerSrc.includes('live.latestRunId === run.runId'))
  ok('the create_failed exclusion is preserved (re-arm owned by bookkeepCreateFailed)', schedulerSrc.includes("outcome.cause !== 'create_failed'"))
  ok('the dead latestRunMemory plumbing is removed', !schedulerSrc.includes('latestRunMemory'))
  ok('the dead latestRunId model field is removed from the public types', !typesSrc.includes('latestRunId'))
}
{
  // two span-parsing fixes (word-form unit alternation; positivity check domain):
  // SPAN_RE's unit alternation was missing the `sec` word form that
  // the shipped README promise ("s, sec, second(s)"), so
  // "30sec" truncated to "30s" via the single-char class plus residual "ec" -> null;
  // the fix inserts `sec` right after `seconds?` (ordering: the longer form precedes
  // the shorter so "30seconds" is never truncated to "30sec" + "onds"), which also
  // makes the previously dead UNIT_MS `sec` entry reachable. The
  // positivity check ran on the ROUNDED total (Math.round first, then `ms <= 0`), so
  // a positive sub-millisecond span (1-499us) collapsed to 0 at the integer-ms output
  // resolution and was rejected as non-positive; the fix checks the UNROUNDED total
  // (the spec's input-domain criterion: non-positive values only) and rounds only on
  // the way out.)
  const utilSrc = readFileSync(path.join(PKG, 'src/util.ts'), 'utf8')
  ok('SPAN_RE accepts the sec word form, ordered after seconds? (longer form first)', utilSrc.includes('seconds?|sec|'))
  ok('the sec weight table entry is retained (now reachable)', utilSrc.includes('sec: 1_000'))
  ok('the positivity check runs on the unrounded total', utilSrc.includes('if (positive && total <= 0) return null'))
  ok('the post-round positivity check is gone', !utilSrc.includes('positive && ms <= 0'))
}
{
  // enable is an in-file boolean field; a non-boolean enable is rejected.
  expectReject('validator enable non-boolean rejected', { onCalendar: ['0 9 * * *'], enable: 'yes', run: { prompt: 'p' } }, 'enable must be a boolean')
  ok('validator enable false accepted (stored disabled)', vj({ onCalendar: ['0 9 * * *'], enable: false, run: { prompt: 'p' } }).ok === true)
  ok('validator enable absent accepted (default enabled)', vj({ onCalendar: ['0 9 * * *'], run: { prompt: 'p' } }).ok === true)
}

// -- rearm recompute engine --------------------------------------------
// one job-level anchor (JobState.lastTriggerMs = the last
// on-calendar elapse moment: a fired trigger or a due trigger consumed by an overlap=skip
// skip) is the recompute base for every condition. The anchor is advanced at the elapse
// sites (fire / skip-consume) in the tick, never by the recompute functions, which take it
// explicitly ({ nowMs, anchorMs } or { runEndMs }) and are pure with respect to it.
const T0 = Date.parse('2026-09-20T00:00:00Z')
const MIN = 60_000, H = 3_600_000
function cronCond(value, tz, extra = {}) {
  const cal = C.CalendarCondition.fromParsed(value, C.parseCalendarValue(value, tz), tz)
  return { cal, consumed: false, neverMatch: cal.isNeverMatch(T0), nextFireMs: null, ...extra }
}
function isoCond(instantMs, consumed = false) {
  const value = new Date(instantMs).toISOString()
  const cal = C.CalendarCondition.fromParsed(value, C.parseCalendarValue(value, 'UTC'), 'UTC')
  return { cal, consumed, neverMatch: false, nextFireMs: null }
}
{ // load: non-persistent, stale anchor (triggers missed while the process was down) -> re-arm from now, silently dropped (no missed persistence)
  const c = cronCond('* * * * *', 'UTC')
  const r = R.recomputeLoad(c, { nowMs: T0 + 10 * MIN, anchorMs: T0, persistent: false })
  eq('rearm load non-persistent stale anchor -> nextMatch(now)', r.nextFireMs, T0 + 11 * MIN)
  eq('rearm load non-persistent no missed persistence', r.missed, undefined)
}
{ // load: persistent, stale anchor -> rebase to now (exactly one catch-up fire on the first tick after load)
  const c = cronCond('* * * * *', 'UTC')
  const r = R.recomputeLoad(c, { nowMs: T0 + 10 * MIN, anchorMs: T0, persistent: true })
  eq('rearm load persistent stale anchor -> one catch-up at now', r.nextFireMs, T0 + 10 * MIN)
  eq('rearm load persistent no missed persistence', r.missed, undefined)
}
{ // load: anchor beyond now (the caller must clamp first: a future persisted anchor = out-of-process rewind) -> re-arm from the given anchor, no rebase (the function takes the anchor as given)
  const c = cronCond('* * * * *', 'UTC')
  const r = R.recomputeLoad(c, { nowMs: T0, anchorMs: T0 + H, persistent: true })
  eq('rearm load anchor beyond now re-arms from anchor', r.nextFireMs, T0 + H + MIN)
}
{ // load: first sighting (no anchor persisted) -> base = now
  const c = cronCond('* * * * *', 'UTC')
  const r = R.recomputeLoad(c, { nowMs: T0, anchorMs: null, persistent: false })
  eq('rearm load first sighting re-arms from now', r.nextFireMs, T0 + MIN)
}
{ // load: neverMatch -> terminal
  const c = cronCond('0 0 31 2 *', 'UTC')
  const r = R.recomputeLoad(c, { nowMs: T0 + 10 * MIN, anchorMs: T0, persistent: false })
  eq('rearm load neverMatch terminal', [r.nextFireMs, c.neverMatch], [null, true])
}
{ // load: ISO expired -> one-shot catch-up pointer at the instant (fires on the next tick)
  const c = isoCond(T0 - 5 * MIN, false)
  eq('rearm load iso expired catch-up pointer', R.recomputeLoad(c, { nowMs: T0, anchorMs: null, persistent: false }).nextFireMs, T0 - 5 * MIN)
}
{ // load: ISO consumed -> terminal
  const c = isoCond(T0 + H, true)
  eq('rearm load iso consumed -> null', R.recomputeLoad(c, { nowMs: T0, anchorMs: null, persistent: false }).nextFireMs, null)
}
{ // runEnd: non-suspended condition maintained in place at its elapse moment -> no-op
  const c = cronCond('*/15 * * * *', 'UTC')
  c.nextFireMs = T0 + 30 * MIN
  eq('rearm runEnd non-suspended no-op (maintained in place)', R.recomputeRunEnd(c, { runEndMs: T0 + 20 * MIN }).nextFireMs, T0 + 30 * MIN)
}
{ // runEnd: suspended (a defer=true fire left it at nextFireMs = null) -> re-armed from the run end
  const c = cronCond('*/15 * * * *', 'UTC')
  const r = R.recomputeRunEnd(c, { runEndMs: T0 + 20 * MIN })
  eq('rearm runEnd suspended re-arm from run end', r.nextFireMs, T0 + 30 * MIN)
}
{ // runEnd: suspended with no future match -> neverMatch
  const c = cronCond('0 0 31 2 *', 'UTC')
  const r = R.recomputeRunEnd(c, { runEndMs: T0 + 20 * MIN })
  eq('rearm runEnd suspended neverMatch', [r.nextFireMs, c.neverMatch], [null, true])
}
{ // runEnd: ISO unconsumed kept
  const c = isoCond(T0 + H, false)
  c.nextFireMs = T0 + H
  eq('rearm runEnd iso kept', R.recomputeRunEnd(c, { runEndMs: T0 }).nextFireMs, T0 + H)
}
{ // runEnd: ISO consumed -> terminal
  const c = isoCond(T0 + H, true)
  eq('rearm runEnd iso consumed -> null', R.recomputeRunEnd(c, { runEndMs: T0 }).nextFireMs, null)
}
{ // runEnd: neverMatch -> terminal
  const c = cronCond('0 0 31 2 *', 'UTC')
  c.neverMatch = true
  eq('rearm runEnd neverMatch -> null', R.recomputeRunEnd(c, { runEndMs: T0 }).nextFireMs, null)
}
{ // rewind: re-arm from the (caller-clamped) anchor
  const c = cronCond('0 * * * *', 'UTC')
  const r = R.recomputeClockRewind(c, { nowMs: T0, anchorMs: T0 })
  eq('rearm rewind re-arm from clamped anchor', r.nextFireMs, T0 + H)
}
{ // rewind: no anchor -> base = now
  const c = cronCond('0 * * * *', 'UTC')
  const r = R.recomputeClockRewind(c, { nowMs: T0, anchorMs: null })
  eq('rearm rewind no anchor base=now', r.nextFireMs, T0 + H)
}
{ // rewind: past anchor -> grid points in the erased interval elapse once more (may land <= now: due on the next tick)
  const c = cronCond('0 * * * *', 'UTC')
  const r = R.recomputeClockRewind(c, { nowMs: T0, anchorMs: T0 - H })
  eq('rearm rewind past anchor re-arms from the anchor', r.nextFireMs, T0)
}
{ // rewind: the function never re-clamps - it takes the anchor as given (the caller owns the clamp)
  const c = cronCond('*/10 * * * *', 'UTC')
  const r = R.recomputeClockRewind(c, { nowMs: T0, anchorMs: T0 + 11 * MIN })
  eq('rearm rewind no internal clamp (anchor taken as given)', r.nextFireMs, T0 + 20 * MIN)
}
{ // rewind: the caller clamps the stored job anchor in place before recomputing (source guard)
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  ok('rearm rewind caller clamps the stored anchor to now', schedulerSrc.includes('model.state.lastTriggerMs !== null && model.state.lastTriggerMs > nowMs'))
}
{ // rewind: ISO is never invalidated by a rewind (a fixed instant stays fixed)
  const c = isoCond(T0 + H, false)
  c.nextFireMs = T0 + H
  eq('rearm rewind iso nextFire untouched', R.recomputeClockRewind(c, { nowMs: T0, anchorMs: T0 }).nextFireMs, T0 + H)
}
{ // rewind: neverMatch -> terminal
  const c = cronCond('0 0 31 2 *', 'UTC')
  c.neverMatch = true
  eq('rearm rewind neverMatch -> null', R.recomputeClockRewind(c, { nowMs: T0, anchorMs: null }).nextFireMs, null)
}
// a rewind that
// happens while the process is stopped is invisible to the tick detector (the first tick only
// establishes its baseline). The out-of-process twin of the tick's in-process rewind clamp is
// the buildCalendars clamp at load: a future persisted anchor is clamped to the load now in
// place (unconditional - the 1s threshold is per-tick churn avoidance only), the conditions
// recompute from the new current time, and grid points in the erased interval re-present under
// the rewound clock (re-presented wall-clock labels - new firings at new physical instants,
// not duplicates of an execution). systemd twins: load-time future-stamp rejection
// and the #6036 future-base clamp, both unconditional.
{ // load: out-of-process rewind, post-clamp (anchor := now) -> nf = nextMatch(now): the re-presented label of the erased interval arms in the future
  const c = cronCond('0 * * * *', 'UTC')
  const r = R.recomputeLoad(c, { nowMs: T0 + 30 * MIN, anchorMs: T0 + 30 * MIN, persistent: true })
  eq('post-clamp load re-arms the re-presented label in the future', r.nextFireMs, T0 + H)
}
{ // load: the funnel clamps before recomputing (source guard: buildCalendars owns the load-time rewind correction, rearm.ts stays pure)
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  const bc = schedulerSrc.slice(schedulerSrc.indexOf('private buildCalendars('), schedulerSrc.indexOf('private consumeFire('))
  ok('buildCalendars clamps a future persisted anchor to now in place', bc.includes('if (model.state.lastTriggerMs !== null && model.state.lastTriggerMs > nowMs)') && bc.includes('model.state.lastTriggerMs = nowMs'))
  ok('the load-time clamp is unconditional (the 1s threshold is per-tick churn avoidance only)', !bc.includes('CLOCK_JUMP_MS'))
  ok('the load-time clamp logs the correction (out-of-process clock rewind; recompute from the current time)', bc.includes('out-of-process clock rewind') && bc.includes('clamped to now, recomputing from the current time'))
  ok('the clamp precedes the recompute inside the funnel', bc.indexOf('model.state.lastTriggerMs = nowMs') < bc.indexOf('recomputeLoad('))
  ok('the in-process tick branch documents its out-of-process twin (buildCalendars at load)', schedulerSrc.includes('The out-of-process twin = the buildCalendars clamp at load'))
}
{ // tzChange: cron, new next match still in the future -> kept (re-armed from the anchor)
  const c = cronCond('0 9 * * *', 'Asia/Shanghai')
  const r = R.recomputeTzChange(c, { nowMs: T0, anchorMs: Date.parse('2026-09-19T01:00:00Z') })
  eq('rearm tzChange future kept', r.nextFireMs, Date.parse('2026-09-20T01:00:00Z'))
}
{ // tzChange: cron, anchor beyond now -> re-arm from the anchor (no spurious rebase to now)
  const c = cronCond('0 9 * * *', 'Asia/Shanghai')
  const r = R.recomputeTzChange(c, { nowMs: T0, anchorMs: Date.parse('2026-09-20T01:00:00Z') })
  eq('rearm tzChange anchor beyond now re-arms from anchor', r.nextFireMs, Date.parse('2026-09-21T01:00:00Z'))
}
{ // tzChange: cron, expired -> one catch-up fire rebased to now (no missed persistence)
  const c = cronCond('0 9 * * *', 'Asia/Shanghai')
  const r = R.recomputeTzChange(c, { nowMs: T0, anchorMs: Date.parse('2026-09-18T01:00:00Z') })
  eq('rearm tzChange expired rebase to now', r.nextFireMs, T0)
  eq('rearm tzChange no missed persistence', r.missed, undefined)
}
{ // tzChange: cron, no anchor -> base = now
  const c = cronCond('0 9 * * *', 'Asia/Shanghai')
  const r = R.recomputeTzChange(c, { nowMs: T0, anchorMs: null })
  eq('rearm tzChange no anchor base=now', r.nextFireMs, Date.parse('2026-09-20T01:00:00Z'))
}
{ // tzChange: cron, no future match -> neverMatch
  const c = cronCond('0 0 31 2 *', 'Asia/Shanghai')
  const r = R.recomputeTzChange(c, { nowMs: T0, anchorMs: T0 })
  eq('rearm tzChange neverMatch', [r.nextFireMs, c.neverMatch], [null, true])
}
function naiveIsoCond(value, tz, consumed = false) {
  const cal = C.CalendarCondition.fromParsed(value, C.parseCalendarValue(value, tz), tz)
  return { cal, consumed, neverMatch: false, nextFireMs: null }
}
{ // tzChange: naive ISO re-resolves the stored wall time under the new tz (systemd
  // OnTimezoneChange=false: no cron/ISO exception) - wall 09:00 resolved in UTC (09:00Z)
  // becomes 01:00Z when the zone switches to Asia/Shanghai
  const c = naiveIsoCond('2027-01-01T09:00:00', 'UTC')
  eq('rearm tzChange naive iso baseline instant (UTC)', c.cal.instantMs, Date.parse('2027-01-01T09:00:00Z'))
  eq('rearm tzChange naive iso wallParts stored', c.cal.wallParts, { year: 2027, month: 1, day: 1, hour: 9, minute: 0, second: 0 })
  c.cal.tz = 'Asia/Shanghai'
  const r = R.recomputeTzChange(c, { nowMs: T0, anchorMs: null })
  eq('rearm tzChange naive iso re-resolved under new tz', r.nextFireMs, Date.parse('2027-01-01T01:00:00Z'))
  eq('rearm tzChange naive iso instantMs stored back', c.cal.instantMs, Date.parse('2027-01-01T01:00:00Z'))
}
{ // tzChange: naive ISO re-resolves to the past -> single catch-up fire rebased to now
  const c = naiveIsoCond('2026-01-01T09:00:00', 'UTC')
  c.cal.tz = 'Asia/Shanghai'
  const r = R.recomputeTzChange(c, { nowMs: T0, anchorMs: null })
  eq('rearm tzChange naive iso past rebase to now', r.nextFireMs, T0)
  eq('rearm tzChange naive iso past instantMs re-resolved', c.cal.instantMs, Date.parse('2026-01-01T01:00:00Z'))
}
{ // tzChange: zoned ISO (own offset) is never recomputed - regression guard
  const c = isoCond(Date.parse('2027-01-01T09:00:00Z'), false)
  eq('rearm tzChange zoned iso wallParts null', c.cal.wallParts, null)
  c.cal.tz = 'Asia/Shanghai'
  eq('rearm tzChange zoned iso instant unchanged', R.recomputeTzChange(c, { nowMs: T0, anchorMs: null }).nextFireMs, Date.parse('2027-01-01T09:00:00Z'))
}
{ // tzChange: consumed naive ISO stays terminal under any tz change
  const c = naiveIsoCond('2027-01-01T09:00:00', 'UTC', true)
  c.cal.tz = 'Asia/Shanghai'
  eq('rearm tzChange consumed naive iso terminal', R.recomputeTzChange(c, { nowMs: T0, anchorMs: null }).nextFireMs, null)
}
{ // tzChange: naive ISO wall time inside the new zone's DST gap -> keep the previously
  // resolved absolute moment (deterministic fallback; 02:30 does not exist in NY on 2026-03-08)
  const c = naiveIsoCond('2026-03-08T02:30:00', 'UTC')
  c.nextFireMs = Date.parse('2026-03-08T02:30:00Z') // the armed pointer = the previously resolved instant
  c.cal.tz = 'America/New_York'
  const r = R.recomputeTzChange(c, { nowMs: T0, anchorMs: null })
  eq('rearm tzChange dst gap keeps previously resolved instant', r.nextFireMs, Date.parse('2026-03-08T02:30:00Z'))
}
{ // applyFire: cron defer=false -> re-arm from the actual elapse moment (the job anchor is advanced by the caller at the elapse site)
  const c = cronCond('* * * * *', 'UTC')
  c.nextFireMs = T0
  const r = R.applyFire(c, { defer: false, firedAtMs: T0 })
  eq('rearm applyFire cron re-arm from elapse', [r.firedAt, c.nextFireMs], [T0, T0 + MIN])
}
{ // applyFire: cron defer=true -> suspended (re-armed from the run end at deactivation).
  // regression: the suspended (transient) nextFireMs = null must NOT set neverMatch -
  // the old code conflated "suspended" with "never matches" and permanently killed a
  // defer=true cron job after its first fire (recomputeRunEnd bails on neverMatch, the
  // tick skips it, and the poisoned flag persists through restarts).
  const c = cronCond('* * * * *', 'UTC')
  c.nextFireMs = T0
  const r = R.applyFire(c, { defer: true, firedAtMs: T0 })
  eq('rearm applyFire cron defer suspended (neverMatch untouched)', [r.firedAt, c.nextFireMs, c.neverMatch], [T0, null, false])
}
{ // regression (the poison chain, verbatim): a defer=true fire suspends,
  // the run ends, recomputeRunEnd must re-arm the suspended condition from the run end
  // and leave the condition alive for the next due moment.
  const c = cronCond('* * * * *', 'UTC')
  c.nextFireMs = T0
  R.applyFire(c, { defer: true, firedAtMs: T0 })
  const rr = R.recomputeRunEnd(c, { runEndMs: T0 + 7 * MIN })
  eq('defer fire -> run end re-arms the suspended cron from the run end', [rr.nextFireMs, c.neverMatch], [T0 + 8 * MIN, false])
}
{ // a genuine neverMatch condition stays terminal through a defer fire (the
  // defer branch must not clear the flag either)
  const c = cronCond('0 0 31 2 *', 'UTC')
  R.applyFire(c, { defer: true, firedAtMs: T0 })
  eq('defer fire preserves a genuine neverMatch', [c.nextFireMs, c.neverMatch], [null, true])
}
{ // applyFire: ISO terminates
  const c = isoCond(T0 - 5 * MIN, false)
  const r = R.applyFire(c, { defer: false, firedAtMs: T0 })
  eq('rearm applyFire iso consumed', [r.firedAt, c.consumed, c.nextFireMs], [T0, true, null])
}
{ // applyFire: invariant - re-arm from the actual trigger moment, strictly in the future (structurally no catch-up chain)
  const c = cronCond('*/5 * * * *', 'UTC')
  c.nextFireMs = T0
  R.applyFire(c, { defer: false, firedAtMs: T0 })
  ok('rearm applyFire re-arm strictly future', c.nextFireMs !== null && c.nextFireMs > T0, `nextFire=${c.nextFireMs}`)
}
{
  // consume semantics - the job-level anchor is advanced at
  // every on-calendar elapse site in the tick (a fire OR an overlap=skip consume), and the
  // anchor is passed explicitly to every recompute function; overlap=skip consumes a due
  // trigger in place (no catch-up fire after the run ends - a run longer than the interval
  // swallows grid points; the cost is accepted and expected).
  const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  const stateSrc = readFileSync(path.join(PKG, 'src/state.ts'), 'utf8')
  ok('the overlap=skip site consumes due triggers in place', schedulerSrc.includes('// Consume (systemd-faithful, overlap=skip): due elapses are consumed in place'))
  ok('the fire site advances the shared job anchor at every on-calendar elapse', schedulerSrc.includes('model.state.lastTriggerMs = nowMs // elapse site: the shared anchor advances on every on-calendar elapse'))
  ok('both elapse sites (fire + skip-consume) advance the shared job anchor', (schedulerSrc.match(/if \(expired\.length > 0\) model\.state\.lastTriggerMs = nowMs/g) ?? []).length === 2)
  ok('the load re-arm receives the job-level anchor', schedulerSrc.includes('recomputeLoad(cond, { nowMs, anchorMs: model.state.lastTriggerMs, persistent: model.persistent })'))
  ok('run-end deactivation re-arms from the run end only', schedulerSrc.includes('recomputeRunEnd(cond, { runEndMs: outcome.finishedAt })'))
  ok('the rewind recompute receives the caller-clamped anchor', schedulerSrc.includes('recomputeClockRewind(cond, { nowMs, anchorMs })'))
  ok('the tz-change recompute receives the job anchor', schedulerSrc.includes('recomputeTzChange(cond, { nowMs, anchorMs: model.state.lastTriggerMs })'))
  ok('the state contract carries the job-level anchor and no per-condition anchor', stateSrc.includes("'lastTriggerMs'") && !stateSrc.includes('lastTriggerMs: number | null\n  [key: string]: unknown'))
  ok('the status detail reports the job-level last on-calendar elapse', schedulerSrc.includes('last on-calendar elapse'))
}
// -- state model ------------------------------------------------
{
  const s = S.freshState('demo')
  eq('state fresh shape (no missed)', s, { schemaVersion: 1, jobId: 'demo', lastActivationMs: null, lastTriggerMs: null, calendars: {}, runs: [] })
  eq('state fresh passes shape check', S.checkStateShape(s), true)
}
{
  // full-shape validation - every field type is checked, not just top-level key presence.
  const bad = [
    null,
    [],
    { schemaVersion: 2, jobId: 'x' },
    { schemaVersion: 1 },
    { schemaVersion: 1, jobId: 'x', calendars: null, runs: [] },
    { schemaVersion: 1, jobId: 'x', calendars: {}, runs: 'no' },
    { schemaVersion: 1, jobId: 7, lastActivationMs: null, calendars: {}, runs: [] },
    { schemaVersion: 1, jobId: 'x', lastActivationMs: 'nope', calendars: {}, runs: [] },
    { schemaVersion: 1, jobId: 'x', lastActivationMs: null, calendars: [1], runs: [] },
    { schemaVersion: 1, jobId: 'x', lastActivationMs: null, lastTriggerMs: true, calendars: {}, runs: [] },
    { schemaVersion: 1, jobId: 'x', lastActivationMs: null, calendars: { a: { value: 1, kind: 'cron', neverMatch: false, consumed: false, nextFireMs: null } }, runs: [] },
    { schemaVersion: 1, jobId: 'x', lastActivationMs: null, calendars: { a: { value: 'x', kind: 5, neverMatch: false, consumed: false, nextFireMs: null } }, runs: [] },
    { schemaVersion: 1, jobId: 'x', lastActivationMs: null, calendars: { a: { value: 'x', kind: null, neverMatch: 'yes', consumed: false, nextFireMs: null } }, runs: [] },
    { schemaVersion: 1, jobId: 'x', lastActivationMs: null, calendars: { a: { value: 'x', kind: 'cron', neverMatch: false, consumed: false, nextFireMs: [1] } }, runs: [] },
    { schemaVersion: 1, jobId: 'x', lastActivationMs: null, calendars: {}, runs: [{ runId: 9, startedAt: 1, status: 'running' }] },
    { schemaVersion: 1, jobId: 'x', lastActivationMs: null, calendars: {}, runs: [{ runId: 'r', startedAt: 'x', status: 'running' }] },
    { schemaVersion: 1, jobId: 'x', lastActivationMs: null, calendars: {}, runs: [{ runId: 'r', startedAt: 1 }] },
    { schemaVersion: 1, jobId: 'x', lastActivationMs: null, calendars: {}, runs: [{ runId: 'r', startedAt: 1, status: 'running', finishedAt: 'nope' }] },
  ]
  for (const b of bad) ok(`state shape rejects ${JSON.stringify(b) ?? 'null'}`, S.checkStateShape(b) === false)
  // good: fully-populated calendar entry; in-flight run record (explicit nulls as persisted by the runner);
  // settled run record with optional fields omitted (missing != corrupt); unknown extra key tolerated.
  const good = {
    schemaVersion: 1, jobId: 'x', lastActivationMs: 5, lastTriggerMs: 3,
    calendars: { a: { value: 'a', kind: 'cron', neverMatch: false, consumed: false, nextFireMs: null } },
    runs: [
      { runId: 'r1', sessionId: 's1', trigger: 'scheduled', startedAt: 1, cause: null, finishedAt: null, durationMs: null, summary: null, status: 'running' },
      { runId: 'r2', startedAt: 2, status: 'finished' },
    ],
  }
  eq('state shape passes (full shape)', S.checkStateShape(good), true)
  eq('state legacy missed key tolerated', S.checkStateShape({ ...good, missed: { lastMissedAtMs: 1, count: 2 } }), true)
  // a file written by an older version (no job-level anchor yet) is tolerated
  eq('state legacy file without the job anchor tolerated', S.checkStateShape({ schemaVersion: 1, jobId: 'x', lastActivationMs: 5, calendars: {}, runs: [] }), true)
}
{
  const dir = mkdtempSync(path.join(tmpdir(), 'timer-selftest-'))
  const file = path.join(dir, 'state', 'demo.json')
  try {
    mkdirSync(path.join(dir, 'state'), { recursive: true })
    const r0 = await S.loadState(file)
    eq('state loadState ENOENT', r0, { state: null, corrupt: false })
    // bad JSON
    writeFileSync(file, '{oops')
    const r1 = await S.loadState(file)
    ok('state loadState bad JSON -> corrupt', r1.state === null && r1.corrupt === true)
    // shape mismatch
    writeFileSync(file, JSON.stringify({ schemaVersion: 99 }), { flag: 'w' })
    const r2 = await S.loadState(file)
    ok('state loadState shape mismatch -> corrupt', r2.state === null && r2.corrupt === true)
    // normal
    const fresh = S.freshState('demo')
    writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n', { flag: 'w' })
    const r3 = await S.loadState(file)
    ok('state loadState normal', r3.state !== null && r3.corrupt === false && r3.state.jobId === 'demo')
    // legacy state (extra missed key) -> tolerated + normalized away on load
    const legacy = { schemaVersion: 1, jobId: 'demo', lastActivationMs: 7, calendars: {}, missed: { lastMissedAtMs: 1, count: 3 }, runs: [] }
    writeFileSync(file, JSON.stringify(legacy, null, 2) + '\n', { flag: 'w' })
    const r4 = await S.loadState(file)
    ok('state loadState legacy missed normalized (job anchor defaulted to null)', r4.state !== null && r4.corrupt === false && !('missed' in r4.state) && r4.state.lastTriggerMs === null, JSON.stringify(r4.state))
    // stateFileFor path
    eq('state stateFileFor', S.stateFileFor('/jd', 'a-b'), '/jd/state/a-b.json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
{
  const s = S.freshState('x')
  for (let i = 0; i < 51; i++) S.pushRun(s, { runId: `r${i}`, status: 'running' })
  eq('state pushRun FIFO cap 50', s.runs.length, 50)
  eq('state FIFO drops oldest', s.runs[0].runId, 'r1')
  eq('state FIFO keeps newest', s.runs[49].runId, 'r50')
  S.updateRun(s, 'r10', { status: 'finished', summary: 'ok' })
  const rec = s.runs.find((r) => r.runId === 'r10')
  eq('state updateRun in place', [rec.status, rec.summary], ['finished', 'ok'])
  eq('state updateRun no length change', s.runs.length, 50)
  S.updateRun(s, 'new-r', { status: 'finished' })
  eq('state updateRun upserts missing', s.runs.some((r) => r.runId === 'new-r'), true)
}
{
  eq('state truncateSummary long text cut', S.truncateSummary('a'.repeat(3000)).length, 2000)
  eq('state truncateSummary short text kept', S.truncateSummary('abc'), 'abc')
  eq('state truncateSummary non-string', S.truncateSummary(42), '')
}

// -- event envelope nesting + croner year cap --
// pinned dsh-session 0.1.5-rc.3 nests event payloads under `data` (append(type, data)
// -> { type, seq, time, data }); dsh-agent-loop emits turn/end -> data:{ turn, reason } and
// assistant/message -> data:{ turn, step, message }. Settlement read sites must therefore read
// event.data.reason / event.data.message - the top-level read sites (pre-envelope) silently
// mis-settled every successfully completed run as failed/turn_error with an empty summary
// (no earlier gate drove the successful-settlement path).
{
  const runnerSrc = readFileSync(path.join(PKG, 'src/runner.ts'), 'utf8')
  ok('EventLike declares the data-nested payload shape', runnerSrc.includes('data?: {'))
  ok('settlement reads the turn/end reason from event.data', runnerSrc.includes('endEvent?.data?.reason'))
  ok('summary reads the assistant message from event.data', runnerSrc.includes('e.data?.message?.content'))
  ok('no top-level endEvent reason read site remains', !runnerSrc.includes('endEvent?.reason'))
  ok('no top-level message read site remains', !runnerSrc.includes('e.message?.content'))
  const cronSrc = readFileSync(path.join(PKG, 'src/cron.ts'), 'utf8')
  ok('cron.ts documents the croner year cap (AD 3000)', cronSrc.includes('AD 3000'))
  ok('stale ~400-year sweep claim removed', !cronSrc.includes('400-year'))
}
// behavior guard: drive the real startRun settlement chain with a stub agent/session
// that emits events in the REAL dsh-session envelope shape - first gate-level coverage of the
// successful-settlement path. startRun pulls only pure functions from dsh-llm /
// dsh-sandbox-policy; no live framework service is started.
{
  const { startRun } = await import(path.join(PKG, 'lib/runner.js'))
  const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  const dir = mkdtempSync(path.join(tmpdir(), 'timer-settle-selftest-'))
  try {
    let seq = 0
    // opts: { pendingCause?, modelSpec?, defaultModel?, settingsSection?, settingsYaml?, presets? };
    // a string second arg = pendingCause (legacy call form). defaultModel / settingsSection are
    // exposed through the soft ctx.get accessor (agentDefaultModel / settings); presets is the
    // agent preset service behind the same accessor (agentPresets); settingsYaml is written
    // into a mock harness home exposed through ctx.dshHomePath (the raw-document fallback).
    const settleCase = async (events, opts = {}) => {
      const { pendingCause = null, modelSpec, defaultModel, settingsSection, settingsYaml, presets } = typeof opts === 'string' ? { pendingCause: opts } : opts
      const session = { snapshotEvents: () => events }
      const agent = {
        session,
        cancel: () => {},
        followup: () => Promise.resolve(undefined),
        whenIdle: () => Promise.resolve(undefined),
      }
      const run = {
        jobId: 'settle-probe',
        sessionId: 'sess-settle-probe',
        trigger: 'manual',
        startedAt: Date.now(),
        runId: `sp-${seq++}`,
        finishedAt: 0,
        status: 'running',
        cause: null,
        pendingCause,
        followupError: null,
        handle: null,
        maxTimer: null,
        settled: false,
      }
      let createdOpts = null
      const getStore = {}
      if (defaultModel) getStore.agentDefaultModel = defaultModel
      if (settingsSection !== undefined) getStore.settings = { section: (ns) => (ns === 'agent-default-model' ? settingsSection : undefined) }
      if (presets !== undefined) getStore.agentPresets = presets
      const ctx = {
        agents: { create: async (createOpts) => { createdOpts = createOpts; return { agent, dispose: async () => {} } } },
        timeout: () => () => {}, // probe: the create/runtimeMax deadlines never fire
        // ctx.get only exists when at least one soft-accessor service is mocked (a
        // default-model source and/or the preset service): the no-service cases exercise
        // the path where the host provides neither accessor-based service - an explicit
        // route must work even without it (a direct property read of an undeclared
        // service crashes on such hosts); a preset-less job must work even without the
        // preset service, degrading to the baseline composition.
        ...(Object.keys(getStore).length > 0 ? { get: (name) => getStore[name] } : {}),
      }
      if (settingsYaml !== undefined) {
        const home = mkdtempSync(path.join(dir, 'home-'))
        writeFileSync(path.join(home, 'settings.yaml'), settingsYaml)
        ctx.dshHomePath = (...segments) => path.join(home, ...segments)
      }
      const model = {
        id: 'settle-probe',
        spec: { run: { prompt: 'probe task', cwd: path.join(dir, 'cwd', `${run.runId}/`), ...(modelSpec ?? {}) } },
        runtimeMaxMs: null,
      }
      let outcome = null
      const res = await startRun({
        ctx, logger: quiet, model, run,
        onRunStart: () => {},
        onRunEnd: (_m, _r, o) => { outcome = o },
      })
      await new Promise((r) => setTimeout(r, 100)) // settlement IIFE (whenIdle microtasks) completes
      return { res, outcome, run, createdOpts }
    }
    const TEXT = 'settlement probe result: all done'
    const msgEvent = (turn, step, text) => ({
      type: 'assistant/message', seq: turn * 10 + step, time: 0,
      data: { turn, step, message: { content: [{ type: 'text', text }] } },
    })
    const endEvent = (turn, reason) => ({ type: 'turn/end', seq: turn * 10 + 9, time: 0, data: { turn, reason } })

    let c
    // completed turn -> finished/null + last assistant text as summary (the event-envelope regression itself)
    c = await settleCase([msgEvent(0, 0, TEXT), endEvent(0, { kind: 'completed' })])
    eq('settle: startRun ok (completed)', c.res.ok, true)
    eq('settle: completed -> finished/null', [c.outcome.status, c.outcome.cause], ['finished', null])
    eq('settle: completed summary = last assistant text', c.outcome.summary, TEXT)
    // error reason -> failed/turn_error (summary still extracted from the assistant text)
    c = await settleCase([msgEvent(0, 0, 'partial'), endEvent(0, { kind: 'error', error: { message: 'boom', code: 'E' } })])
    eq('settle: error -> failed/turn_error', [c.outcome.status, c.outcome.cause], ['failed', 'turn_error'])
    eq('settle: error turn still extracts summary', c.outcome.summary, 'partial')
    eq('settle: turn_error surfaces the framework error message', c.outcome.error, 'boom')
    // aborted without a pending cause -> failed/cancelled
    c = await settleCase([endEvent(0, { kind: 'aborted', reason: { kind: 'user' } })])
    eq('settle: aborted -> failed/cancelled', [c.outcome.status, c.outcome.cause], ['failed', 'cancelled'])
    // pendingCause priority: a recorded timeout wins over the (completed) turn/end reason
    c = await settleCase([endEvent(0, { kind: 'completed' })], { pendingCause: 'timeout' })
    eq('settle: pendingCause=timeout beats completed reason', [c.outcome.status, c.outcome.cause], ['failed', 'timeout'])
    // max-tokens -> finished/null, no assistant text -> summary ''
    c = await settleCase([endEvent(0, { kind: 'max-tokens' })])
    eq('settle: max-tokens -> finished/null', [c.outcome.status, c.outcome.cause], ['finished', null])
    eq('settle: no assistant text -> summary ""', c.outcome.summary, '')
    // the last non-empty assistant text wins
    c = await settleCase([msgEvent(0, 0, 'first'), msgEvent(0, 1, 'second'), endEvent(0, { kind: 'completed' })])
    eq('settle: last assistant text wins', c.outcome.summary, 'second')
    // summary truncated to SUMMARY_LIMIT (2000 chars)
    c = await settleCase([msgEvent(0, 0, 'x'.repeat(2500)), endEvent(0, { kind: 'completed' })])
    eq('settle: summary truncated to 2000 chars', c.outcome.summary, 'x'.repeat(2000))
    // a run session without a complete provider/model route fails at the first turn
    // (the framework rejects it), so the runner resolves the route. Explicit
    // "provider/model" splits at the first slash and never touches a host service (a
    // direct property read of an undeclared service crashes even explicit routes on hosts
    // lacking the service). A bare model id or an absent model rides the deployment's
    // default selection from readDefaultModelSelection - three soft sources in order: the
    // agent-default-model service (ctx.get), the settings service's section under the
    // default-model namespace, the raw settings.yaml document at the harness home; no
    // source -> agentOptions omitted and the turn/end error message surfaces in the run
    // record.
    c = await settleCase([endEvent(0, { kind: 'completed' })], { modelSpec: { model: 'ninfer/qwen3.8-27b' } })
    eq('settle: "provider/model" -> explicit pair, NO host source needed', c.createdOpts.agentOptions, { provider: 'ninfer', model: 'qwen3.8-27b' })
    c = await settleCase([endEvent(0, { kind: 'completed' })], { modelSpec: { model: 'p/a/b' } })
    eq('settle: "p/a/b" splits at the FIRST slash', c.createdOpts.agentOptions, { provider: 'p', model: 'a/b' })
    c = await settleCase([endEvent(0, { kind: 'completed' })], { modelSpec: { model: 'bare-model' } })
    eq('settle: bare model, no default source -> model only', c.createdOpts.agentOptions, { model: 'bare-model' })
    c = await settleCase([endEvent(0, { kind: 'completed' })], { modelSpec: { model: 'bare-model' }, defaultModel: { currentSelection: () => ({ provider: 'dep', model: 'dep-model' }) } })
    eq('settle: bare model + default service -> default provider', c.createdOpts.agentOptions, { provider: 'dep', model: 'bare-model' })
    c = await settleCase([endEvent(0, { kind: 'completed' })], { modelSpec: { model: 'bare-model' }, defaultModel: { currentSelection: () => ({ provider: 'dep', model: 'dep-model' }) }, settingsSection: { provider: 'sett', model: 'sett-model' } })
    eq('settle: service wins over the settings section', c.createdOpts.agentOptions, { provider: 'dep', model: 'bare-model' })
    c = await settleCase([endEvent(0, { kind: 'completed' })], { modelSpec: { model: 'bare-model' }, settingsSection: { provider: 'sett', model: 'sett-model' } })
    eq('settle: bare model, service absent -> settings-section provider', c.createdOpts.agentOptions, { provider: 'sett', model: 'bare-model' })
    c = await settleCase([endEvent(0, { kind: 'completed' })], { modelSpec: { model: 'bare-model' }, settingsSection: { provider: 'sett' } })
    eq('settle: malformed settings section (model missing) -> model only', c.createdOpts.agentOptions, { model: 'bare-model' })
    c = await settleCase([endEvent(0, { kind: 'completed' })], { defaultModel: { currentSelection: () => ({ provider: 'dep', model: 'dep-model' }) } })
    eq('settle: no model + default service -> default selection', c.createdOpts.agentOptions, { provider: 'dep', model: 'dep-model' })
    c = await settleCase([endEvent(0, { kind: 'completed' })], { settingsSection: { provider: 'sett', model: 'sett-model' } })
    eq('settle: no model, service absent -> settings-section selection', c.createdOpts.agentOptions, { provider: 'sett', model: 'sett-model' })
    c = await settleCase([endEvent(0, { kind: 'completed' })], { settingsYaml: 'agent-default-model:\n  provider: filedep\n  model: file-model\n' })
    eq('settle: no model, no services -> raw settings.yaml selection', c.createdOpts.agentOptions, { provider: 'filedep', model: 'file-model' })
    c = await settleCase([endEvent(0, { kind: 'completed' })], { settingsYaml: 'just a string document' })
    eq('settle: unparseable/foreign settings.yaml -> agentOptions absent', c.createdOpts.agentOptions, undefined)
    c = await settleCase([endEvent(0, { kind: 'completed' })])
    eq('settle: no model, no default source -> agentOptions absent', c.createdOpts.agentOptions, undefined)
    // error reason without a message payload -> error stays null (no spurious text)
    c = await settleCase([endEvent(0, { kind: 'error', error: { code: 'E' } })])
    eq('settle: error reason without message -> error null', c.outcome.error, null)
    // unknown (string) reason -> generic failed/turn_error, error stays null
    c = await settleCase([endEvent(0, 'mystery')])
    eq('settle: string reason -> failed/turn_error, error null', [c.outcome.status, c.outcome.cause, c.outcome.error], ['failed', 'turn_error', null])
    // agent-plane composition
    // through the host's agent preset service (structural ctx.get accessor + the create
    // call's setup hook). A job that NAMES a preset resolves strictly (resolveMountable;
    // absent service or unresolvable/broken preset -> create_failed, no session created -
    // a job file is declarative config). A job WITHOUT a preset mounts the deployment
    // default preset; an absent service or an unavailable default degrades to the
    // baseline composition (warn). Settled run sessions are still disposed by the runner
    // (plugin lifecycle unchanged); the plugin keeps no retention mechanism to patch
    // around framework defects.
    const presetMock = (defaultId, named = {}, { broken = false } = {}) => {
      const mounted = []
      const resolve = async (id) => {
        const want = id ?? defaultId
        if (want === undefined || want === null) throw new Error('agent-preset/not-found: no default preset configured')
        const known = new Set([defaultId, ...Object.keys(named)].filter(Boolean))
        if (!known.has(want)) throw new Error(`agent-preset/not-found: unknown preset "${want}"`)
        return { id: want }
      }
      const resolveMountable = async (id) => {
        const r = await resolve(id)
        if (broken) throw new Error('agent-preset/invalid: composition validation failed')
        return r
      }
      const svc = { resolve, resolveMountable, mount: async (_agentCtx, id) => { mounted.push(id); return { presetId: id } } }
      return { svc, mounted }
    }
    let pm = presetMock('qwen-standard')
    c = await settleCase([endEvent(0, { kind: 'completed' })], { modelSpec: { preset: 'qwen-standard' }, presets: pm.svc })
    eq('preset: named preset -> create ok', c.res.ok, true)
    eq('preset: named preset -> meta.agentPreset = resolved id', c.createdOpts.meta.agentPreset, 'qwen-standard')
    ok('preset: named preset -> create carries a setup hook', typeof c.createdOpts.setup === 'function')
    const namedSetupResult = await c.createdOpts.setup({})
    eq('preset: setup hook mounts the resolved preset', pm.mounted, ['qwen-standard'])
    ok('preset: setup returns void (agent loop calls ?.commit() on the result; a leaked mount record would crash create)', namedSetupResult === undefined)
    pm = presetMock('qwen-standard')
    c = await settleCase([endEvent(0, { kind: 'completed' })], { modelSpec: { preset: 'nope' }, presets: pm.svc })
    ok('preset: unknown preset -> create_failed, no session created', c.res.ok === false && c.createdOpts === null)
    ok('preset: unknown preset -> error names the preset', String(c.res.error).includes('preset "nope" is unavailable'))
    c = await settleCase([endEvent(0, { kind: 'completed' })], { modelSpec: { preset: 'qwen-standard' } })
    ok('preset: named preset + absent service -> create_failed', c.res.ok === false && String(c.res.error).includes('no agent preset service'))
    pm = presetMock('qwen-standard', {}, { broken: true })
    c = await settleCase([endEvent(0, { kind: 'completed' })], { modelSpec: { preset: 'qwen-standard' }, presets: pm.svc })
    ok('preset: broken preset (resolveMountable rejects) -> create_failed', c.res.ok === false && String(c.res.error).includes('unavailable'))
    pm = presetMock('qwen-standard')
    c = await settleCase([endEvent(0, { kind: 'completed' })], { presets: pm.svc })
    eq('default: preset-less job + service -> default preset mounted', [c.res.ok, c.createdOpts.meta.agentPreset], [true, 'qwen-standard'])
    ok('default: preset-less job -> setup hook present', typeof c.createdOpts.setup === 'function')
    const defaultSetupResult = await c.createdOpts.setup({})
    ok('default: setup returns void (leaked mount record guard)', defaultSetupResult === undefined)
    pm = presetMock(undefined)
    c = await settleCase([endEvent(0, { kind: 'completed' })], { presets: pm.svc })
    ok('default: unavailable default degrades to baseline (run ok, no setup, no agentPreset)', c.res.ok === true && c.createdOpts.setup === undefined && c.createdOpts.meta.agentPreset === undefined)
    c = await settleCase([endEvent(0, { kind: 'completed' })])
    ok('default: preset-less job + no service -> baseline composition (run ok)', c.res.ok === true && c.createdOpts.setup === undefined)
    // disposal guard: settled run sessions are disposed by the runner (plugin lifecycle
    // unchanged) - the list-removal on dispose is a framework defect, so the plugin carries
    // no retention registry that would bend its semantics to compensate.
    const runnerSrc = readFileSync(path.join(PKG, 'src/runner.ts'), 'utf8')
    const schedulerSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
    ok('runner wires the resolved preset through create\'s setup hook', runnerSrc.includes('...(setup ? { setup } : {})'))
    ok('runner setup hooks await mount and return void (the mount record must never reach the agent loop)', (runnerSrc.match(/await presets\.mount\(agentCtx, resolved\.id\)/g) ?? []).length === 2 && !runnerSrc.includes('setup = (agentCtx) => presets.mount'))
    ok('runner resolves named presets via resolveMountable (falls back to resolve)', runnerSrc.includes('presets.resolveMountable') && runnerSrc.includes('agent preset "${spec.preset}" is unavailable: ${errMsg(err)}'))
    ok('runner fails create when a named preset has no host service', runnerSrc.includes('agent preset "${spec.preset}" is set but the host provides no agent preset service'))
    ok('runner still disposes the settled run session (no retention registry in the plugin)', runnerSrc.includes('await created.dispose()') && !schedulerSrc.includes('retainRunSession') && !schedulerSrc.includes('retainedSessions'))
    const runnerSrc2 = readFileSync(path.join(PKG, 'src/runner.ts'), 'utf8')
    const indexSrc = readFileSync(path.join(PKG, 'src/index.ts'), 'utf8')
    ok('runner reads the default-model sources through the soft ctx.get accessor', runnerSrc2.includes("get('agentDefaultModel')") && runnerSrc2.includes("get('settings')"))
    ok('runner falls back to the raw settings.yaml document at the harness home', runnerSrc2.includes("dshHomePath('settings.yaml')"))
    ok('runner never reads ctx.agentDefaultModel as a direct property (without-inject on hosts lacking the service)', !runnerSrc2.includes('ctx.agentDefaultModel'))
    ok('index.ts documents the soft ctx.get read of the optional host services', indexSrc.includes('ctx.get(name)'))
    ok('index.ts no longer declares agentDefaultModel on Context (soft-read only, never a required inject)', !indexSrc.includes('agentDefaultModel'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  // the plugin's static inject declaration
  // must name every ctx service the constructor reads - agents (runner) + timer (tick) +
  // tools (tool registry) + skills (skill provider) + systemPrompt (prompt section). On
  // cordis 4.0.2 the proxy resolves undeclared reads via the fiber store lookup before the
  // inject check, so an undeclared name only surfaces as a cryptic "without inject" error on
  // a host missing the service; declaring converts it to the named required-service error.
  // Zero behavioral change on the DSH host (all five services are always present).
  const indexSrc = readFileSync(path.join(PKG, 'src/index.ts'), 'utf8')
  const toolSrc = readFileSync(path.join(PKG, 'src/tool.ts'), 'utf8')
  const skillSrc = readFileSync(path.join(PKG, 'src/skill.ts'), 'utf8')
  const declared = indexSrc.slice(indexSrc.indexOf('static readonly inject'), indexSrc.indexOf('static readonly Config'))
  ok('inject declares tools (ctx.tools.register read site in tool.ts)', declared.includes("'tools'") && toolSrc.includes('ctx.tools.register('))
  ok('inject declares skills (ctx.skills.registerProvider read site in skill.ts)', declared.includes("'skills'") && skillSrc.includes('ctx.skills.registerProvider('))
  ok('inject declares systemPrompt (ctx.systemPrompt.section read site in index.ts)', declared.includes("'systemPrompt'") && indexSrc.includes('ctx.systemPrompt.section('))
  ok('agents + timer remain declared (unchanged)', declared.includes("'agents'") && declared.includes("'timer'"))
  // dshHomePath is the framework's
  // harness-home path resolver (dsh-app-boot provides it on the root context at boot). The
  // constructor reads ctx.dshHomePath for the default jobsDir discovery fallback, so the
  // inject declaration must name it (6th service) - a declared-missing service parks the
  // plugin fiber rather than throwing, so the declaration is consistent with the read site.
  ok("inject declares dshHomePath (ctx.dshHomePath read site in index.ts)", declared.includes("'dshHomePath'") && indexSrc.includes('resolveJobsDir(config, logger, ctx.dshHomePath)'))
  ok("index.ts augments cordis Context with the optional dshHomePath service", indexSrc.includes("declare module '@deepseek-ai/cordis'") && indexSrc.includes('dshHomePath?:'))
}

{
  // discoverProfileDir finds the
  // active profile through the framework's own conventions - profiles live under
  // <dshHome>/profiles/<name> and the framework mints each profile's package.json name as
  // `dsh-profile-<name>` (dsh-app-boot). The unique candidate wins; zero or multiple is
  // ambiguity (null), and a directory renamed away from its minted name no longer matches.
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-b3-'))
  try {
    const profiles = path.join(home, 'profiles')
    const dshHomePath = (...segs) => path.join(home, ...segs)

    // node_modules shared fallback tree + hidden entries are skipped, not candidates
    mkdirSync(path.join(profiles, 'node_modules'), { recursive: true })
    mkdirSync(path.join(profiles, '.git'), { recursive: true })

    // the one real framework-minted profile -> unique candidate
    const web = path.join(profiles, 'web')
    mkdirSync(web, { recursive: true })
    writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', version: '0.0.0' }))

    // decoys that must NOT count as candidates
    mkdirSync(path.join(profiles, 'renamed'), { recursive: true })
    writeFileSync(path.join(profiles, 'renamed', 'package.json'), JSON.stringify({ name: 'dsh-profile-web' })) // suffix != dir name
    mkdirSync(path.join(profiles, 'foreign'), { recursive: true })
    writeFileSync(path.join(profiles, 'foreign', 'package.json'), JSON.stringify({ name: 'not-a-profile' })) // no dsh-profile- prefix
    mkdirSync(path.join(profiles, 'no-pkg'), { recursive: true }) // missing package.json

    eq('discoverProfileDir: unique minted profile wins', discoverProfileDir(dshHomePath), web)

    // a second valid minted profile -> multiple candidates -> ambiguity (null)
    const web2 = path.join(profiles, 'web2')
    mkdirSync(web2, { recursive: true })
    writeFileSync(path.join(web2, 'package.json'), JSON.stringify({ name: 'dsh-profile-web2', version: '0.0.0' }))
    eq('discoverProfileDir: multiple minted profiles -> null (ambiguity)', discoverProfileDir(dshHomePath), null)

    // an empty profiles root -> zero candidates -> null
    const emptyHome = mkdtempSync(path.join(tmpdir(), 'dsh-timer-b3-empty-'))
    mkdirSync(path.join(emptyHome, 'profiles'), { recursive: true })
    eq('discoverProfileDir: empty profiles root -> null', discoverProfileDir((...segs) => path.join(emptyHome, ...segs)), null)
    rmSync(emptyHome, { recursive: true, force: true })

    // a harness home without a profiles/ root -> null
    const bareHome = mkdtempSync(path.join(tmpdir(), 'dsh-timer-b3-bare-'))
    eq('discoverProfileDir: no profiles root -> null', discoverProfileDir((...segs) => path.join(bareHome, ...segs)), null)
    rmSync(bareHome, { recursive: true, force: true })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }

  {
    // resolveJobsDir candidate chain - the harness-home discovery is the third
    // fallback after the explicit candidates and the install-root walk-up. A unique
    // discovered profile yields <profileDir>/timers; ambiguity throws; a host without
    // dshHomePath (undefined) with no walk-up root also throws.
    const silentLogger = { info() { }, warn() { } }
    const throwIf = (fn) => {
      let threw = null
      try { fn() } catch (e) { threw = e }
      return threw
    }

    // unique profile via dshHomePath -> <profileDir>/timers (walk-up of PKG_DIR is null in the
    // selftest checkout, so the discovery branch is exercised)
    const home2 = mkdtempSync(path.join(tmpdir(), 'dsh-timer-b3-jobs-'))
    try {
      const profiles = path.join(home2, 'profiles')
      const web = path.join(profiles, 'web')
      mkdirSync(web, { recursive: true })
      writeFileSync(path.join(web, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', version: '0.0.0' }))
      const dshHomePath = (...segs) => path.join(home2, ...segs)
      eq('resolveJobsDir: discovered unique profile -> <profile>/timers',
        resolveJobsDir({}, silentLogger, dshHomePath), path.join(web, 'timers'))
      ok('resolveJobsDir: discovered default dir was created', (await import('node:fs')).existsSync(path.join(web, 'timers')))

      // ambiguity (two minted profiles) + no explicit value -> throw
      const web2 = path.join(profiles, 'web2')
      mkdirSync(web2, { recursive: true })
      writeFileSync(path.join(web2, 'package.json'), JSON.stringify({ name: 'dsh-profile-web2', version: '0.0.0' }))
      const amb = throwIf(() => resolveJobsDir({}, silentLogger, dshHomePath))
      ok('resolveJobsDir: ambiguous discovery -> throw', amb !== null && String(amb.message).includes('cannot determine jobsDir'))
    } finally {
      rmSync(home2, { recursive: true, force: true })
    }

    // explicit value still wins over discovery and is returned as-is
    const expDir = mkdtempSync(path.join(tmpdir(), 'dsh-timer-b3-explicit-'))
    try {
      eq('resolveJobsDir: explicit config jobsDir wins over discovery',
        resolveJobsDir({ jobsDir: expDir }, silentLogger, () => '/never'), expDir)
    } finally {
      rmSync(expDir, { recursive: true, force: true })
    }

    // no dshHomePath service (undefined) and no install-root walk-up -> throw (dev checkout)
    const noService = throwIf(() => resolveJobsDir({}, silentLogger, undefined))
    ok('resolveJobsDir: no service + no walk-up -> throw', noService !== null && String(noService.message).includes('does not provide the dshHomePath service'))
  }
}

{ // privilege checks (policy monotonicity + the run-root scope rule + approval-channel
  // escalation + the run.cwd caller-root rule): source contract pins for the wiring, then
  // behavioral cases driving the real scheduler against synthetic callers (explicit caller
  // contexts, mock approval seams; the tool handler derives these from the execution
  // context at call time).
  const { TimerScheduler } = await import(path.join(PKG, 'lib/scheduler.js'))
  const quietLg = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  const privToolSrc = readFileSync(path.join(PKG, 'src/tool.ts'), 'utf8')
  const privSrc = readFileSync(path.join(PKG, 'src/privilege.ts'), 'utf8')
  const privSchedSrc = readFileSync(path.join(PKG, 'src/scheduler.ts'), 'utf8')
  ok('tool.ts derives the caller context from the execution context', privToolSrc.includes('async execute(args, exec)') && privToolSrc.includes('deriveCallerContext(ctx, exec)'))
  ok('tool.ts reads the approval service through the non-strict ctx.get accessor', privToolSrc.includes("ctx.get('approval')") && privToolSrc.includes('.overrideOf('))
  ok('tool.ts reads the sandbox-policy service through the non-strict ctx.get accessor (an undeclared property read throws in a runtime fiber)', privToolSrc.includes("ctx.get('sandboxPolicy')") && !privToolSrc.includes('.sandboxPolicy'))
  ok('tool.ts threads the caller through the seven job-acting verbs', ['addJob(args?.id, args?.spec, caller)', 'updateJob(args?.id, args?.spec, caller)', 'manualRun(args?.id, caller)', 'deleteJob(args?.id, caller)', 'cancelJob(args?.id, caller)'].every((s) => privToolSrc.includes(s)) && privToolSrc.includes('setEnabled(args?.id, true, caller)') && privToolSrc.includes('setEnabled(args?.id, false, caller)'))
  ok('privilege.ts declares the monotone policy rank table', privSrc.includes("'read-only': 0") && privSrc.includes("'workspace-write': 1") && privSrc.includes("'danger-full-access': 2"))
  ok('privilege.ts fails closed on every non-granted approval outcome', privSrc.includes("'allowed-once'") && privSrc.includes('the user rejected the approval') && privSrc.includes('the approval request was cancelled') && privSrc.includes('no approval channel is available') && privSrc.includes('no agent context to route approval through'))
  ok('privilege.ts canonicalizes against the deepest existing prefix (symlink-proof)', privSrc.includes('realpathSync') && privSrc.includes('existsSync'))
  ok('privilege.ts exempts a full-access caller from the cwd rule', privSrc.includes(`caller.policy !== 'danger-full-access'`))
  ok('scheduler.ts runs the privilege check on the five single-verb literals', ['verb: \'add\'', 'verb: \'update\'', 'verb: \'run\'', 'verb: \'delete\'', 'verb: \'cancel\''].every((s) => privSchedSrc.includes(s)))
  ok('scheduler.ts gates enable and disable in one ternary check (both directions)', privSchedSrc.includes("verb: enabled ? 'enable' : 'disable'"))
  ok('privilege.ts exempts a full-access caller from both axes', privSrc.includes(`caller.policy === 'danger-full-access' ? { kind: 'in' }`))
  ok('scheduler.ts treats an unparseable on-disk spec as the top level (fail closed)', privSchedSrc.includes('assume the top level'))

  const seam = (outcome = 'allowed-once') => {
    const calls = []
    return { calls, request: async (req) => { calls.push(req); return outcome } }
  }
  const callerOf = (o = {}) => ({
    hasPolicyWorld: o.world !== false,
    policy: o.policy ?? 'workspace-write',
    defaultMode: o.world === false ? null : (o.defaultMode ?? 'workspace-write'),
    cwd: o.cwd ?? null,
    agent: o.agent === false ? null : { session: { header: { cwd: o.cwd ?? undefined } } },
    approval: o.approval ?? null,
  })
  const specOf = (o = {}) => {
    const { enable, prompt, ...run } = o
    const s = { onActiveSec: '1h', run: { prompt: 'priv probe', ...run } }
    if (enable !== undefined) s.enable = enable
    if (prompt !== undefined) s.run.prompt = prompt
    return s
  }
  const errOf = async (p) => { try { await p } catch (err) { return err.message } return null }

  const base = mkdtempSync(path.join(tmpdir(), 'dt-priv-'))
  try {
    const root = path.join(base, 'ws') // the synthetic caller session's cwd
    const outsideDir = path.join(base, 'outside') // a sibling of the caller root
    const jobsDir = path.join(base, 'jobs')
    mkdirSync(root, { recursive: true })
    mkdirSync(outsideDir)
    mkdirSync(jobsDir)
    const emptyWorld = { agents: undefined } // no sandbox-policy service, no approval service
    let sched = new TimerScheduler({ ctx: emptyWorld, logger: quietLg, jobsDir })
    const wsCaller = callerOf({ cwd: root })
    const faCaller = callerOf({ policy: 'danger-full-access', cwd: root })

    // B1: a policy gap with no approval channel fails closed; no file effect
    const e1 = await errOf(sched.addJob('p1', specOf({ policy: 'danger-full-access' }), wsCaller))
    ok('add: gap with no approval channel is denied', e1 !== null && e1.includes('no approval channel is available') && e1.includes(`runs at policy 'danger-full-access', above this session's policy 'workspace-write'`))
    ok('add: denied escalation leaves no job file', !existsSync(path.join(jobsDir, 'p1.json')))
    // B2: a rejected approval fails closed; no file effect
    const e2 = await errOf(sched.addJob('p2', specOf({ policy: 'danger-full-access' }), callerOf({ cwd: root, approval: seam('rejected') })))
    ok('add: a rejected approval is denied', e2 !== null && e2.includes('the user rejected the approval'))
    ok('add: a rejected approval leaves no job file', !existsSync(path.join(jobsDir, 'p2.json')))
    // B3: an approved escalation proceeds; the question names the job, both levels, and the verb
    const okSeam = seam('allowed-once')
    const r3 = await sched.addJob('p3', specOf({ policy: 'danger-full-access' }), callerOf({ cwd: root, approval: okSeam }))
    ok('add: an approved escalation creates the job', typeof r3 === 'string' && r3.startsWith('added job p3'))
    ok('add: the approval question routes through the timer tool with a human-facing reason', okSeam.calls.length === 1 && okSeam.calls[0].toolName === 'timer' && okSeam.calls[0].displayReason.en.includes('p3') && okSeam.calls[0].displayReason.en.includes('danger-full-access') && okSeam.calls[0].reason.includes('timer add'))
    // B4: an omitted policy resolves to the deployment default - the gap still counts
    const e4 = await errOf(sched.addJob('p4', specOf({}), callerOf({ policy: 'read-only', cwd: root, approval: seam('rejected') })))
    ok('add: an omitted policy (deployment default) still counts as the job level', e4 !== null && e4.includes(`above this session's policy 'read-only'`))
    // B5: an explicit run.cwd outside the caller's own cwd is denied (no gap, no escalation)
    const e5 = await errOf(sched.addJob('p5', specOf({ cwd: outsideDir }), wsCaller))
    ok('add: a run cwd outside the session root is denied', e5 !== null && e5.includes(`is outside this session's workspace root '${root}'`))
    ok('add: a denied run cwd leaves no job file', !existsSync(path.join(jobsDir, 'p5.json')))
    // B6: a run cwd at or under the caller's own cwd is accepted
    await sched.addJob('p6', specOf({ cwd: path.join(root, 'sub') }), wsCaller)
    ok('add: a run cwd under the session root is accepted', existsSync(path.join(jobsDir, 'p6.json')))
    // B7: a full-access caller is exempt from both the gap and the cwd rule
    await sched.addJob('p7', specOf({ policy: 'danger-full-access', cwd: outsideDir }), faCaller)
    ok('add: a full-access caller may set any policy and any run cwd', existsSync(path.join(jobsDir, 'p7.json')))
    // B8: a symlink under the caller's root pointing outside it does not bypass the rule
    const { symlinkSync } = await import('node:fs')
    symlinkSync(outsideDir, path.join(root, 'link'))
    const e8 = await errOf(sched.addJob('p8', specOf({ cwd: path.join(root, 'link', 'x') }), wsCaller))
    ok('add: a symlinked run cwd escaping the session root is denied', e8 !== null && e8.includes(`is outside this session's workspace root`))
    // B9: updating a higher-level job needs the approval even when the new spec is lower
    await sched.addJob('p9', specOf({ policy: 'danger-full-access' }), faCaller)
    const before9 = readFileSync(path.join(jobsDir, 'p9.json'), 'utf8')
    const e9 = await errOf(sched.updateJob('p9', specOf({ prompt: 'touched', policy: 'workspace-write' }), callerOf({ cwd: root, approval: seam('rejected') })))
    ok('update: a lower-level caller may not touch a higher-level job (rejection)', e9 !== null && e9.includes('the user rejected the approval'))
    ok('update: a denied update leaves the job file untouched', readFileSync(path.join(jobsDir, 'p9.json'), 'utf8') === before9)
    // B10: an approved update proceeds
    await sched.updateJob('p9', specOf({ prompt: 'touched' }), callerOf({ cwd: root, approval: seam('allowed-once') }))
    ok('update: an approved update replaces the spec in place', readFileSync(path.join(jobsDir, 'p9.json'), 'utf8').includes('touched'))
    // B11: disable is gated like every other job-acting verb: a job above the
    // caller's level and/or outside its run-root scope routes through the approval
    // channel (one approval clears both axes); enable of a higher-level job is
    // likewise gated
    await sched.addJob('p11', specOf({ policy: 'danger-full-access', enable: true }), faCaller)
    const before11 = readFileSync(path.join(jobsDir, 'p11.json'), 'utf8')
    const e11a = await errOf(sched.setEnabled('p11', false, callerOf({ policy: 'read-only', approval: seam('rejected') })))
    ok('disable: a higher-level job outside the caller scope routes through the approval channel', e11a !== null && e11a.includes('the user rejected the approval') && e11a.includes(`runs at policy 'danger-full-access', above this session's policy 'read-only'`) && e11a.includes('no cwd to anchor'))
    ok('disable: a denied disable leaves the job file untouched', readFileSync(path.join(jobsDir, 'p11.json'), 'utf8') === before11)
    const b11Seam = seam('allowed-once')
    const r11 = await sched.setEnabled('p11', false, callerOf({ policy: 'read-only', approval: b11Seam }))
    ok('disable: one approval clears the level gap and the scope breach together', typeof r11 === 'string' && r11.startsWith('disabled job p11') && b11Seam.calls.length === 1)
    const e11b = await errOf(sched.setEnabled('p11', true, callerOf({ policy: 'read-only', approval: seam('rejected') })))
    ok('enable: a higher-level job routes through the approval channel', e11b !== null && e11b.includes('the user rejected the approval'))
    await sched.setEnabled('p11', true, callerOf({ policy: 'read-only', approval: seam('allowed-once') }))
    ok('enable: an approved enable proceeds', existsSync(path.join(jobsDir, 'p11.json')))
    // B12: manually running a higher-level job routes through the approval channel
    await sched.addJob('p12', specOf({ policy: 'danger-full-access', cwd: path.join(root, 'runs12') }), faCaller)
    const e12 = await errOf(sched.manualRun('p12', callerOf({ policy: 'read-only', approval: seam('rejected') })))
    ok('run: a higher-level job routes through the approval channel', e12 !== null && e12.includes('the user rejected the approval'))
    // B13: an approved manual run starts the run session (full runner path, stub agent)
    const stubAgent = { session: { snapshotEvents: () => [] }, cancel: () => {}, followup: () => Promise.resolve(undefined), whenIdle: () => Promise.resolve(undefined) }
    let createdOpts = null
    const runSeam = seam('allowed-once')
    const runWorld = {
      sandboxPolicy: { defaultMode: 'workspace-write', overrideOf: () => undefined },
      get: (name) => (name === 'approval' ? runSeam : undefined),
      agents: { create: async (opts) => { createdOpts = opts; return { agent: stubAgent, dispose: async () => {} } } },
      timeout: () => () => {},
    }
    sched = new TimerScheduler({ ctx: runWorld, logger: quietLg, jobsDir })
    await sched.reload() // fresh instance: load the job files into its registries first
    const r13 = await sched.manualRun('p12', callerOf({ policy: 'read-only', approval: runSeam }))
    ok('run: an approved manual run starts at the job spec level', typeof r13 === 'string' && r13.startsWith('started run') && runSeam.calls.length === 1)
    ok('run: the started run session carries the spec cwd', createdOpts !== null && createdOpts.meta.cwd === path.join(root, 'runs12'))
    // B14: deleting a higher-level job routes through the approval channel
    await sched.addJob('p14', specOf({ policy: 'workspace-write' }), callerOf({ policy: 'danger-full-access', cwd: root }))
    const before14 = readFileSync(path.join(jobsDir, 'p14.json'), 'utf8')
    const e14 = await errOf(sched.deleteJob('p14', callerOf({ policy: 'read-only', approval: seam('rejected') })))
    ok('delete: a higher-level job routes through the approval channel', e14 !== null && e14.includes('the user rejected the approval'))
    ok('delete: a denied delete leaves the job file untouched', existsSync(path.join(jobsDir, 'p14.json')) && readFileSync(path.join(jobsDir, 'p14.json'), 'utf8') === before14)
    await sched.deleteJob('p14', callerOf({ policy: 'read-only', approval: seam('allowed-once') }))
    ok('delete: an approved delete removes config and state', !existsSync(path.join(jobsDir, 'p14.json')) && !existsSync(path.join(jobsDir, 'state', 'p14.json')))
    // B15: a host without the policy service has nothing to enforce - the checks skip
    const bareWorld = {}
    const bareCaller = callerOf({ world: false, policy: null, approval: null })
    await new TimerScheduler({ ctx: bareWorld, logger: quietLg, jobsDir }).addJob('p15', specOf({ policy: 'danger-full-access', cwd: outsideDir }), bareCaller)
    ok('add: without a policy service the checks are skipped (no sandbox world to enforce)', existsSync(path.join(jobsDir, 'p15.json')))
    // B16: an agent-less call cannot route an approval even if the service is present
    const e16 = await errOf(sched.addJob('p16', specOf({ policy: 'danger-full-access' }), callerOf({ policy: 'read-only', cwd: root, agent: false, approval: seam('allowed-once') })))
    ok('add: an agent-less caller cannot escalate (no routing target)', e16 !== null && e16.includes('no agent context to route approval through'))
    // B17: the tool handler derives the caller from a cordis-shaped context (a soft get
    // accessor only - no declared-inject service properties, the shape of a live runtime
    // fiber): the policy gap is detected and routed to the approval channel even though
    // the context object carries no sandboxPolicy property.
    const { registerTool } = await import(path.join(PKG, 'lib/tool.js'))
    const policyService = { defaultMode: 'workspace-write', overrideOf: () => undefined }
    const execOf = (cwd) => ({ agent: { session: { header: { cwd } } }, callId: 'probe', signal: undefined })
    const rejectSeam = seam('rejected')
    let toolDef = null
    registerTool({
      get: (name) => (name === 'sandboxPolicy' ? policyService : name === 'approval' ? rejectSeam : undefined),
      tools: { register: (def) => { toolDef = def; return () => {} } },
    }, sched)
    const t17 = await errOf(toolDef.execute({ verb: 'add', id: 'pt1', spec: specOf({ policy: 'danger-full-access' }) }, execOf(root)))
    ok('tool: a context with only soft get accessors still derives the caller and routes the check', t17 !== null && t17.includes('the user rejected the approval') && rejectSeam.calls.length === 1)
    ok('tool: a denied escalation through the handler leaves no job file', !existsSync(path.join(jobsDir, 'pt1.json')))
    // B18: an approved escalation through the full tool path creates the job
    const approveSeam = seam('allowed-once')
    registerTool({
      get: (name) => (name === 'sandboxPolicy' ? policyService : name === 'approval' ? approveSeam : undefined),
      tools: { register: (def) => { toolDef = def; return () => {} } },
    }, sched)
    const r18 = await toolDef.execute({ verb: 'add', id: 'pt2', spec: specOf({ policy: 'danger-full-access' }) }, execOf(root))
    ok('tool: an approved escalation through the handler creates the job', typeof r18 === 'string' && r18.startsWith('added job pt2') && approveSeam.calls.length === 1)
    // B19: a context that composes neither service degrades: the checks skip, nothing throws
    registerTool({
      get: () => undefined,
      tools: { register: (def) => { toolDef = def; return () => {} } },
    }, sched)
    const r19 = await toolDef.execute({ verb: 'add', id: 'pt3', spec: specOf({ policy: 'danger-full-access' }) }, execOf(root))
    ok('tool: a context without a policy world skips the check without crashing', typeof r19 === 'string' && r19.startsWith('added job pt3'))

    // B20-B33: the run-root scope rule - a job's effective run root is its control
    // domain: a same-level session outside that domain cannot manage the job (disable,
    // enable, cancel, run, update, delete) without the approval channel, while a job's
    // own run-root session manages itself freely and a full-access session is exempt
    // from both axes. The cases below drive the run-world instance.
    const p20File = path.join(jobsDir, 'p20.json')
    const p21File = path.join(jobsDir, 'p21.json')
    await sched.addJob('p20', specOf({ cwd: path.join(root, 'runs20') }), wsCaller)
    ok('scope: a job whose run root sits under the caller root is accepted', existsSync(p20File))
    await sched.addJob('p21', specOf({ cwd: path.join(outsideDir, 'runs21') }), callerOf({ cwd: outsideDir }))
    ok('scope: a job whose run root sits under its creating session root is accepted', existsSync(p21File))
    // B20: a same-level session outside the job's run root cannot disable it
    const e20 = await errOf(sched.setEnabled('p21', false, callerOf({ cwd: root, approval: seam('rejected') })))
    ok('disable: cross-scope routes through the approval channel', e20 !== null && e20.includes('the user rejected the approval') && e20.includes(`outside this session's workspace root`))
    ok('disable: a denied cross-scope disable leaves the job file untouched', JSON.parse(readFileSync(p21File, 'utf8')).enable !== false)
    const b20Seam = seam('allowed-once')
    const r20 = await sched.setEnabled('p21', false, callerOf({ cwd: root, approval: b20Seam }))
    ok('disable: an approved cross-scope disable proceeds', typeof r20 === 'string' && r20.startsWith('disabled job p21') && b20Seam.calls.length === 1)
    ok('disable: the file stores the disabled state', JSON.parse(readFileSync(p21File, 'utf8')).enable === false)
    ok('disable: the approval question names the job run root and the caller root', b20Seam.calls[0].displayReason.en.includes('runs21') && b20Seam.calls[0].displayReason.en.includes('workspace root'))
    // B21: a same-level session outside the run root cannot enable it either
    const e21 = await errOf(sched.setEnabled('p21', true, callerOf({ cwd: root, approval: seam('rejected') })))
    ok('enable: cross-scope routes through the approval channel', e21 !== null && e21.includes('the user rejected the approval'))
    await sched.setEnabled('p21', true, callerOf({ cwd: root, approval: seam('allowed-once') }))
    ok('enable: an approved cross-scope enable re-enables the job', JSON.parse(readFileSync(p21File, 'utf8')).enable === true)
    // B22: the cancel gate is uniform - it applies even when no run is in progress
    const e22 = await errOf(sched.cancelJob('p21', callerOf({ cwd: root, approval: seam('rejected') })))
    ok('cancel: cross-scope applies even with no in-progress runs (uniform gate)', e22 !== null && e22.includes('the user rejected the approval'))
    // B23: a same-level session outside the run root cannot manually run it
    const e23 = await errOf(sched.manualRun('p21', callerOf({ cwd: root, approval: seam('rejected') })))
    ok('run: cross-scope routes through the approval channel', e23 !== null && e23.includes('the user rejected the approval'))
    // B24: a same-level session outside the run root cannot rewrite the spec
    const before24 = readFileSync(p21File, 'utf8')
    const e24 = await errOf(sched.updateJob('p21', specOf({ prompt: 'touched24' }), callerOf({ cwd: root, approval: seam('rejected') })))
    ok('update: cross-scope routes through the approval channel', e24 !== null && e24.includes('the user rejected the approval') && readFileSync(p21File, 'utf8') === before24)
    // B25: a same-level session outside the run root cannot delete it
    const e25 = await errOf(sched.deleteJob('p21', callerOf({ cwd: root, approval: seam('rejected') })))
    ok('delete: cross-scope routes through the approval channel', e25 !== null && e25.includes('the user rejected the approval') && existsSync(p21File))
    // B26: a session whose cwd is the job's run root manages that job freely
    // (no approval, not even when no channel is available), but cannot reach a
    // sibling job's run root
    const selfCaller = callerOf({ cwd: path.join(outsideDir, 'runs21'), policy: 'workspace-write', approval: null })
    const r26 = await sched.setEnabled('p21', false, selfCaller)
    ok('scope: a job run-root session manages its own job without escalation', typeof r26 === 'string' && r26.startsWith('disabled job p21'))
    const e26b = await errOf(sched.manualRun('p20', selfCaller))
    ok('scope: the same session cannot reach a sibling job run root (fail closed)', e26b !== null && e26b.includes('no approval channel is available'))
    // B27: a caller without a known cwd cannot be verified in scope - fail closed
    const e27 = await errOf(sched.setEnabled('p20', false, callerOf({ policy: 'workspace-write', cwd: null, approval: null })))
    ok('scope: a caller with no cwd fails closed', e27 !== null && e27.includes('no approval channel is available'))
    // B28: a full-access caller is exempt from both axes (any cwd, no approval)
    const r28 = await sched.setEnabled('p20', false, callerOf({ policy: 'danger-full-access', cwd: outsideDir, approval: null }))
    ok('scope: a full-access caller is exempt from the scope axis', typeof r28 === 'string' && r28.startsWith('disabled job p20'))
    // B29: one approval covers a level gap and a scope breach together
    await sched.setEnabled('p21', true, callerOf({ policy: 'danger-full-access', cwd: outsideDir, approval: null }))
    const bothSeam = seam('rejected')
    const e29 = await errOf(sched.setEnabled('p21', false, callerOf({ policy: 'read-only', cwd: root, approval: bothSeam })))
    ok('escalation: one approval covers the level gap and the scope breach together', e29 !== null && e29.includes(`above this session's policy 'read-only'`) && e29.includes(`outside this session's workspace root`) && bothSeam.calls.length === 1)
    // B30: add carries no scope axis - an explicit run cwd outside the session root is
    // denied locally (no approval routing)
    const e30 = await errOf(sched.addJob('p30', specOf({ cwd: outsideDir }), callerOf({ cwd: root, approval: null })))
    ok('add: a run cwd outside the session root is denied locally', e30 !== null && e30.includes(`is outside this session's workspace root`) && !existsSync(path.join(jobsDir, 'p30.json')))
    // B31: an in-scope job cannot be moved outside the session root by a same-level
    // caller (the new spec's cwd rule still applies below escalation)
    const e31 = await errOf(sched.updateJob('p20', specOf({ policy: 'workspace-write', cwd: outsideDir }), callerOf({ cwd: root, approval: null })))
    ok('update: an in-scope job cannot move its run cwd outside the session root locally', e31 !== null && e31.includes(`is outside this session's workspace root`))
    // B32: an approved cross-scope update lifts the new-spec cwd rule
    await sched.updateJob('p21', specOf({ policy: 'workspace-write', cwd: outsideDir }), callerOf({ cwd: root, approval: seam('allowed-once') }))
    ok('update: an approved cross-scope update writes the new spec', readFileSync(p21File, 'utf8').includes(outsideDir))
    // B33: an unparseable on-disk spec fails closed on both axes (top level +
    // undetermined run root)
    writeFileSync(path.join(jobsDir, 'p33.json'), '{ not valid json')
    const e33 = await errOf(sched.deleteJob('p33', callerOf({ cwd: root, approval: seam('rejected') })))
    ok('delete: an unparseable on-disk spec fails closed on both axes', e33 !== null && e33.includes('the user rejected the approval') && e33.includes('undetermined run root'))
    ok('delete: a denied delete leaves the broken file untouched', existsSync(path.join(jobsDir, 'p33.json')))

    // R1..R9: run-cwd inheritance - the plugin ships no host-absolute run path: an add that
    // omits run.cwd inherits the creating session's workspace (materialized into the job
    // file), a creating session without a cwd is refused locally (set run.cwd explicitly),
    // and jobs whose run root cannot be determined fail closed on management and on run
    // start.
    // R1: an add that omits run.cwd inherits the creating session's workspace and
    // persists it into the job file (the stored spec is self-describing)
    await sched.addJob('r1', specOf({}), wsCaller)
    const vr1File = JSON.parse(readFileSync(path.join(jobsDir, 'r1.json'), 'utf8'))
    eq('add: an omitted run cwd inherits the creating session workspace itself and is persisted', vr1File.run.cwd, root)
    // R2: the creating scope manages the inherited job freely; a sibling scope cannot
    // (fail closed when no channel is available)
    const vr2 = await sched.setEnabled('r1', false, wsCaller)
    ok('scope: the creating scope manages its inherited job without escalation', typeof vr2 === 'string' && vr2.startsWith('disabled job r1'))
    const vr2b = await errOf(sched.setEnabled('r1', true, callerOf({ cwd: outsideDir, approval: null })))
    ok('scope: a sibling scope cannot manage the inherited job (fail closed)', vr2b !== null && vr2b.includes('no approval channel is available'))
    await sched.setEnabled('r1', true, wsCaller)
    // R3: a caller without a cwd - the add is refused locally with the actionable
    // remedy (no approval routing; no deployment default run root exists)
    const vr3 = await errOf(sched.addJob('r3', specOf({}), callerOf({ cwd: null, approval: null })))
    ok('add: a caller without a cwd is refused locally (set run.cwd explicitly)', vr3 !== null && vr3.includes('set run.cwd explicitly') && !existsSync(path.join(jobsDir, 'r3.json')))
    // R6: a legacy job file that omits run.cwd has an undetermined run root - both
    // axes fail closed through approval
    writeFileSync(path.join(jobsDir, 'r6.json'), JSON.stringify(specOf({ prompt: 'legacy' })))
    await sched.reload()
    const vr6 = await errOf(sched.setEnabled('r6', false, callerOf({ cwd: outsideDir, approval: seam('rejected') })))
    ok('disable: an undetermined run root fails closed through the approval channel', vr6 !== null && vr6.includes('the user rejected the approval') && vr6.includes('undetermined run root'))
    const vr6Seam = seam('allowed-once')
    await sched.setEnabled('r6', false, callerOf({ cwd: outsideDir, approval: vr6Seam }))
    ok('disable: a human-approved management of an undetermined-root job proceeds', vr6Seam.calls.length === 1)
    // R7: starting a run of a job whose run cwd cannot be determined fails the run
    // create_failed with the actionable remedy
    const vr7 = await sched.manualRun('r6', callerOf({ policy: 'danger-full-access', approval: null }))
    ok('run: an undetermined run cwd fails create_failed with the actionable remedy', typeof vr7 === 'string' && vr7.includes('create_failed') && vr7.includes('has no run cwd: set run.cwd in the job spec'))
    // R8: an update that omits run.cwd keeps the job's existing run root (materialized
    // into the stored file, mirroring the add-time inheritance)
    await sched.updateJob('r1', specOf({ prompt: 'touched-r8' }), wsCaller)
    const vr1After = JSON.parse(readFileSync(path.join(jobsDir, 'r1.json'), 'utf8'))
    eq('update: an omitted run cwd keeps the job existing run root', vr1After.run.cwd, root)
    ok('update: the rewritten file keeps the rest of the spec', readFileSync(path.join(jobsDir, 'r1.json'), 'utf8').includes('touched-r8'))
    // R9: unit shape of the shared derivation (one rule feeds runner and privilege)
    const { runRootOfSpec, inheritRunRoot } = await import(path.join(PKG, 'lib/privilege.js'))
    eq('runRootOfSpec: an explicit cwd is the run root', runRootOfSpec({ run: { prompt: 'x', cwd: '/a/b/' } }), '/a/b/')
    eq('runRootOfSpec: an omitted cwd is undetermined (legacy file) -> null', runRootOfSpec({ run: { prompt: 'x' } }), null)
    eq('inheritRunRoot: the creating session workspace itself', inheritRunRoot(root), root)
    eq('inheritRunRoot: a caller without a cwd -> null (add refused locally)', inheritRunRoot(null), null)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}
// -- session offload: the retention window parser, the retention log, the
//    sweep (round health, window semantics, the source/destination existence
//    table, the liveness gate and its rollback, the budget, compaction, the
//    trend alert) and the run-lifecycle write gate plus the unit-window view
//    (the eleven sections, from window through layout)
// ---------------------------------------------------------------------------
{
  const offload = await import(path.join(PKG, 'lib/offload.js'))
  const { OffloadSweeper, OFFLOAD_ARCHIVE_DIR, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE, OFFLOAD_STORE_ROOT, readRetentionLog, appendRetentionEntry, rewriteRetentionLog, COMPACTION_RATIO } = offload
  const { parseWindowMs, parseOffloadBatch, parseUnitDefaultWindowMs, DEFAULT_OFFLOAD_BATCH } = await import(path.join(PKG, 'lib/retention.js'))

  // A fake sessionPersistence service: locate() mirrors the framework jsonl
  // layout (the session dir is the dirname of the log path; a cwd-less
  // session lives under the _no-cwd project dir). Run sessions always carry
  // a cwd (the line is written after the runner's cwd check), so the
  // _no-cwd branch is exercised only by directly seeded log lines.
  function makeSpService(storeRoot) {
    return {
      locate: ({ id, cwd }) => ({
        kind: 'jsonl',
        path: path.join(storeRoot, cwd === undefined ? '_no-cwd' : path.basename(cwd), id, 'session.v4.jsonl.zstd'),
      }),
    }
  }

  // A fake live-session registry (the ctx.get('sessions') face; `known` is a
  // mutable Set so a case can make a session live between two reads).
  function makeRegistry(known) {
    const set = known === undefined ? new Set() : known instanceof Set ? known : new Set(known)
    return { known: set, get: (id) => (set.has(id) ? { id } : undefined) }
  }

  // A capturing ctx: ctx.get routes to the given services (soft read),
  // the logger records warn/info/error/debug lines.
  function fakeCtx(services = {}) {
    const state = { warns: [], infos: [], errors: [], debugs: [] }
    const mkLog = () => ({
      warn: (m) => state.warns.push(m),
      error: (m) => state.errors.push(m),
      info: (m) => state.infos.push(m),
      debug: (m) => state.debugs.push(m),
    })
    const ctx = {
      get: (name) => (services[name] !== undefined ? services[name] : undefined),
      logger: () => mkLog(),
    }
    return { ctx, state }
  }

  // Build an OffloadSweeper rooted at a temp harness home (`home` is the
  // harness home: the plugin home and the session store root sit under it).
  // `units` is the live jobId -> window-ms map the sweep re-derives each
  // round (0 = retain; an absent id = a vanished unit).
  function makeSweeper(home, { storeRoot, units = new Map(), inflight = new Set(), cap = DEFAULT_OFFLOAD_BATCH, services = {}, now, devOf, move } = {}) {
    const root = storeRoot ?? path.join(home, OFFLOAD_STORE_ROOT)
    const pluginHome = path.join(home, OFFLOAD_HOME_BASE)
    const { ctx, state } = fakeCtx(services)
    const sweeper = new OffloadSweeper({
      ctx,
      logger: ctx.logger(),
      home: {
        base: pluginHome,
        archive: path.join(pluginHome, OFFLOAD_ARCHIVE_DIR),
        log: path.join(pluginHome, OFFLOAD_LOG_FILE),
        storeRoot: root,
      },
      units: () => units,
      inflight,
      cap,
      ...(now !== undefined ? { now } : {}),
      ...(devOf !== undefined ? { devOf } : {}),
      ...(move !== undefined ? { move } : {}),
    })
    return { sweeper, state, storeRoot: root }
  }

  // Create a source session dir (the store side) the way the framework
  // would, and return its path.
  function makeSessionDir(storeRoot, id, cwd) {
    const dir = path.join(storeRoot, cwd === undefined ? '_no-cwd' : path.basename(cwd), id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'log')
    return dir
  }

  const T0 = 1_000_000
  // The retention log stores the dispatch time as an ISO8601 string
  // (the frozen line format); the fixtures wrap the numeric test clocks through this.
  const iso = (ms) => new Date(ms).toISOString()
  const W = 60_000 // the job retention window used across the sweep cases
  const CWD = '/ws/a' // a fake workspace; the fake persistence service keys on its basename
  const mapJob = (ms = W) => new Map([['job', ms]])
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const waitFor = async (pred, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const v = await pred()
      if (v) return v
      if (Date.now() >= deadline) return false
      await sleep(20)
    }
  }

  // One round of fixtures: setup builds the home (store dir, log lines,
  // session dirs) and returns the sweeper handles; the asserts run against
  // the sweep report; the temp home is removed afterwards.
  async function runCase(setup, fn) {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
    try {
      const ctx = {
        home,
        storeRoot: path.join(home, OFFLOAD_STORE_ROOT),
        logPath: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE),
        archiveDir: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR),
      }
      const handles = await setup(ctx)
      const report = await handles.sweeper.sweep()
      await fn({ ...ctx, report, state: handles.state })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  // -- window: the retention window parser (number = ms; string = 1-2 segments
  //        in descending unit order; the discriminating vectors rejected)
  eq('window-a: number windows are non-negative integer ms', [parseWindowMs(0).ms, parseWindowMs(900000).ms], [0, 900000])
  ok('window-a: a negative, fractional or NaN number window is invalid', !parseWindowMs(-1).ok && !parseWindowMs(1.5).ok && !parseWindowMs(Number.NaN).ok)
  eq('window-b: one-segment duration strings', [parseWindowMs('1d').ms, parseWindowMs('24h').ms, parseWindowMs('30m').ms, parseWindowMs('90s').ms, parseWindowMs('5000ms').ms], [86_400_000, 86_400_000, 1_800_000, 90_000, 5000])
  eq('window-b: two-segment durations in descending unit order', [parseWindowMs('1h30m').ms, parseWindowMs('4h30m').ms, parseWindowMs('1m30s').ms, parseWindowMs('1s500ms').ms], [5_400_000, 16_200_000, 90_000, 1500])
  ok(
    'window-c: the discriminating vectors are all invalid (strict segment grammar)',
    ['1h30m30s', '30m4h', '1w', '1h 30m', '30', '5000', 'h', '24H', '1ms2s', '1w30m', 'banana', ''].every((v) => !parseWindowMs(v).ok),
  )
  ok('window-c: the range guard rejects overflow', !parseWindowMs('900000000d').ok)

  // -- retlog: the retention log (round trip, single append write per line, the
  //        torn-tail repair, the bad-line skip, the atomic rewrite)
  {
    const dir = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
    try {
      const log = path.join(dir, 'sub', 'retention-log.jsonl')
      const r0 = await readRetentionLog(log)
      eq('retlog-a: reading a missing log is an empty, un-repaired read', [r0.entries.length, r0.repaired, r0.badLines], [0, false, 0])
      await appendRetentionEntry(log, { id: 'a', createdAt: iso(1), unit: 'u1', cwd: '/x/w' })
      await appendRetentionEntry(log, { id: 'b', createdAt: iso(2), unit: 'u2' })
      const lines = readFileSync(log, 'utf8').split('\n')
      eq('retlog-a: each append is exactly one complete line (single write per line)', lines.filter((l) => l !== '').length, 2)
      ok('retlog-a: the cwd key is present for the first line and omitted for the second', lines[0].includes('"cwd":"/x/w"') && !lines[1].includes('cwd'))
      const r1 = await readRetentionLog(log)
      eq('retlog-a: the round trip preserves the entry shape and order', JSON.stringify(r1.entries), JSON.stringify([{ id: 'a', createdAt: iso(1), unit: 'u1', cwd: '/x/w' }, { id: 'b', createdAt: iso(2), unit: 'u2' }]))
      const torn = path.join(dir, 'torn.jsonl')
      writeFileSync(torn, `{"id":"a","createdAt":"${iso(1)}","unit":"u"}\n{"id":"p","createdAt":"${iso(2)}","unit":"u"`)
      const rt = await readRetentionLog(torn)
      ok('retlog-b: a torn trailing line is repaired in place (back to the last newline)', rt.repaired === true && rt.entries.length === 1 && readFileSync(torn, 'utf8') === `{"id":"a","createdAt":"${iso(1)}","unit":"u"}\n`)
      await appendRetentionEntry(torn, { id: 'c', createdAt: iso(3), unit: 'u' })
      ok('retlog-b: an append after the repair lands on its own line', readFileSync(torn, 'utf8').endsWith(`{"id":"c","createdAt":"${iso(3)}","unit":"u"}\n`))
      const torn2 = path.join(dir, 'torn2.jsonl')
      writeFileSync(torn2, `{"id":"a","createdAt":"${iso(1)}","unit":"u"`) // no trailing newline
      await appendRetentionEntry(torn2, { id: 'c', createdAt: iso(3), unit: 'u' })
      const rt2 = await readRetentionLog(torn2)
      ok('retlog-b: an append to a torn tail closes it first (the new line stays parseable)', readFileSync(torn2, 'utf8') === `{"id":"a","createdAt":"${iso(1)}","unit":"u"\n{"id":"c","createdAt":"${iso(3)}","unit":"u"}\n` && [rt2.entries.length, rt2.badLines, rt2.repaired].join() === '1,1,false')
      const bad = path.join(dir, 'bad.jsonl')
      writeFileSync(bad, `{"id":"a","createdAt":"${iso(1)}","unit":"u"}\nnot json\n{"id":"b","createdAt":"${iso(2)}","unit":"u"}\n`)
      const rb = await readRetentionLog(bad)
      eq('retlog-c: unparseable lines are skipped and counted', [rb.entries.length, rb.badLines, rb.repaired], [2, 1, false])
      await rewriteRetentionLog(log, [r1.entries[1]])
      const r2 = await readRetentionLog(log)
      eq('retlog-d: the compaction rewrite keeps exactly the survivors, in order', r2.entries.map((e) => e.id), ['b'])
      ok('retlog-d: no temp file remains after the rewrite', !existsSync(`${log}.tmp`))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // -- knob: the offload batch knob (env TIMER_OFFLOAD_BATCH: the positive
  //        integer or the warn-and-keep degradation), the unit-default window
  //        parser (env TIMER_SESSION_RETENTION), and the windows themselves
  //        through the unit-window view (lifecycle-h explicit values, lifecycle-i the default)
  {
    eq('knob-a: an absent knob falls back to the default', parseOffloadBatch(undefined, () => {}), 50)
    eq('knob-a: a valid knob value is used', parseOffloadBatch('7', () => {}), 7)
    eq('knob-a: the default constant is 50', DEFAULT_OFFLOAD_BATCH, 50)
    const warns = []
    for (const v of ['0', '-2', 'abc', '5.5']) parseOffloadBatch(v, (m) => warns.push(m))
    eq('knob-b: each invalid knob value warns and falls back to the default', [warns.length, parseOffloadBatch('0', () => {})], [4, 50])
    ok('knob-b: the warning names the knob', warns.every((m) => m.includes('TIMER_OFFLOAD_BATCH')))
    eq('knob-c: an absent unit default is 0 (no warning)', [parseUnitDefaultWindowMs(undefined, (m) => warns.push(m)), warns.length], [0, 4])
    eq('knob-c: a duration default parses to ms', parseUnitDefaultWindowMs('24h', () => {}), 86_400_000)
    eq('knob-c: a bare ms-unit string default is valid', parseUnitDefaultWindowMs('5000ms', () => {}), 5000)
    eq('knob-c: a bare numeric string default is invalid (warn + 0)', [parseUnitDefaultWindowMs('30', (m) => warns.push(m)), warns.length], [0, 5])
    eq('knob-c: the zero string default is invalid (warn + 0)', [parseUnitDefaultWindowMs('0', (m) => warns.push(m)), warns.length], [0, 6])
    eq('knob-c: an empty default is invalid (warn + 0)', [parseUnitDefaultWindowMs('', (m) => warns.push(m)), warns.length], [0, 7])
    eq('knob-c: a garbage default warns and falls back to 0', parseUnitDefaultWindowMs('banana', (m) => warns.push(m)), 0)
    ok('knob-c: the default-window warnings name the knob and the value', warns.some((m) => m.includes('TIMER_SESSION_RETENTION=30')) && warns.some((m) => m.includes('TIMER_SESSION_RETENTION=0')) && warns.some((m) => m.includes('banana')))
  }

  // -- health: round health (the disabled branches: unreachable service, missing
  //        store root, the mount mismatch; the registry fallback)
  {
    await runCase(
      ({ home, storeRoot }) => {
        mkdirSync(storeRoot)
        return makeSweeper(home, { storeRoot, services: {} })
      },
      ({ report, state }) => {
        ok('health-a: an unreachable persistence service skips the round with a warning', report.disabled !== undefined && state.warns.some((m) => m.includes('persistence service is unreachable')))
        eq('health-a: the skipped round performs no action', [report.candidates, report.offloaded, report.balance], [0, 0, 0])
      },
    )
    await runCase(
      ({ home, storeRoot }) => {
        // The store root is never created (missing on this host).
        return makeSweeper(home, { storeRoot, services: { sessionPersistence: makeSpService(storeRoot) } })
      },
      ({ report, state }) => {
        ok('health-b: a missing store root disables the round with a warning', report.disabled !== undefined && state.warns.some((m) => m.includes('store root is missing')))
      },
    )
    await runCase(
      ({ home, storeRoot }) => {
        mkdirSync(storeRoot)
        return makeSweeper(home, {
          storeRoot,
          services: { sessionPersistence: makeSpService(storeRoot) },
          devOf: (p) => Promise.resolve(p.includes(OFFLOAD_ARCHIVE_DIR) ? 1 : 2),
        })
      },
      ({ report, state }) => {
        ok('health-c: a mount mismatch disables the round with a warning', report.disabled !== undefined && state.warns.some((m) => m.includes('different mounts')))
      },
    )
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        const handles = makeSweeper(home, {
          storeRoot,
          units: mapJob(),
          services: { sessionPersistence: makeSpService(storeRoot) },
          now: () => T0,
        })
        makeSessionDir(storeRoot, 'o4', CWD)
        await appendRetentionEntry(logPath, { id: 'o4', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        return handles
      },
      ({ report, state }) => {
        ok('health-d: an unreachable registry falls back to the in-flight set with a warning', report.offloaded === 1 && state.warns.some((m) => m.includes('registry service is unreachable')))
      },
    )
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        const inflight = new Set(['o4'])
        const handles = makeSweeper(home, {
          storeRoot,
          units: mapJob(),
          inflight,
          services: { sessionPersistence: makeSpService(storeRoot) },
          now: () => T0,
        })
        makeSessionDir(storeRoot, 'o4', CWD)
        await appendRetentionEntry(logPath, { id: 'o4', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        return handles
      },
      async ({ report, state, logPath }) => {
        ok('health-d: with the registry unreachable the in-flight set alone gates liveness', report.skippedLive === 1 && state.warns.some((m) => m.includes('registry service is unreachable')))
        eq('health-d: the live entry stays in the log', (await readRetentionLog(logPath)).entries.length, 1)
      },
    )
  }

  // -- sweep: the sweep core (window semantics, the existence table, the
  //        liveness rollback, the retry, the unit-gone rule)
  {
    // Cell 1: source present, destination absent (the normal path).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'c1', CWD)
        await appendRetentionEntry(logPath, { id: 'c1', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
      },
      async ({ report, storeRoot, archiveDir, logPath }) => {
        eq('sweep-a: the over-window settled session is offloaded', [report.offloaded, report.candidates], [1, 1])
        ok('sweep-a: the session dir left the store and entered the archive', !existsSync(path.join(storeRoot, 'a', 'c1')) && existsSync(path.join(archiveDir, 'c1')))
        eq('sweep-a: the completed line is removed by the compaction rewrite', (await readRetentionLog(logPath)).entries.length, 0)
      },
    )
    // Cell 2: neither side (the session was cleaned up externally).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        await appendRetentionEntry(logPath, { id: 'c2', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
      },
      async ({ report, logPath }) => {
        eq('sweep-b: a session found on neither side completes without action', [report.sourceGone, report.offloaded], [1, 0])
        eq('sweep-b: its line is removed by the compaction rewrite', (await readRetentionLog(logPath)).entries.length, 0)
      },
    )
    // Cell 3: destination present, source absent (an earlier round already moved it).
    await runCase(
      async ({ home, storeRoot, logPath, archiveDir }) => {
        mkdirSync(storeRoot)
        mkdirSync(path.join(archiveDir, 'c3'), { recursive: true })
        await appendRetentionEntry(logPath, { id: 'c3', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
      },
      async ({ report, logPath }) => {
        eq('sweep-c: a session already in the archive completes without action', [report.alreadyArchived, report.offloaded], [1, 0])
        eq('sweep-c: its line is removed by the compaction rewrite', (await readRetentionLog(logPath)).entries.length, 0)
      },
    )
    // Cell 4: both sides present (a deployment anomaly: neither side is touched).
    await runCase(
      async ({ home, storeRoot, logPath, archiveDir }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'c4', CWD)
        mkdirSync(path.join(archiveDir, 'c4'), { recursive: true })
        await appendRetentionEntry(logPath, { id: 'c4', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
      },
      async ({ report, storeRoot, archiveDir, logPath, state }) => {
        eq('sweep-d: a both-sides-present session is an error, both sides untouched', [report.errors, report.offloaded], [1, 0])
        ok('sweep-d: the anomaly is logged for manual resolution', state.warns.some((m) => m.includes('c4') && m.includes('manual resolution')))
        ok('sweep-d: both sides still exist and the line survives the round', existsSync(path.join(storeRoot, 'a', 'c4')) && existsSync(path.join(archiveDir, 'c4')) && (await readRetentionLog(logPath)).entries.length === 1)
      },
    )
    // A rename failure (EIO): the entry is kept and the next round retries.
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'eio', CWD)
        await appendRetentionEntry(logPath, { id: 'eio', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        const err = new Error('i/o error')
        err.code = 'EIO'
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0, move: () => Promise.reject(err) })
      },
      async ({ report, storeRoot, logPath, state }) => {
        eq('sweep-e: a failed rename keeps the entry and the source', [report.errors, report.offloaded], [1, 0])
        ok('sweep-e: the failure is logged and the retry is announced', state.warns.some((m) => m.includes('eio') && m.includes('retried next round')))
        ok('sweep-e: the source dir is intact and the line survives', existsSync(path.join(storeRoot, 'a', 'eio')) && (await readRetentionLog(logPath)).entries.length === 1)
      },
    )
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'eio', CWD)
        await appendRetentionEntry(logPath, { id: 'eio', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
      },
      ({ report, archiveDir }) => {
        eq('sweep-e: the next round (failure gone) offloads the same entry', [report.offloaded, report.errors], [1, 0])
        ok('sweep-e: the retry landed in the archive', existsSync(path.join(archiveDir, 'eio')))
      },
    )
    // A rename that reports ENOENT (the source vanished between the check and the move).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'eno', CWD)
        await appendRetentionEntry(logPath, { id: 'eno', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        const err = new Error('no such file')
        err.code = 'ENOENT'
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0, move: () => Promise.reject(err) })
      },
      async ({ report, logPath }) => {
        eq('sweep-f: a rename ENOENT converges to source-gone', [report.sourceGone, report.errors], [1, 0])
        eq('sweep-f: the entry completed and its line was removed', (await readRetentionLog(logPath)).entries.length, 0)
      },
    )
    // A rename that reports EEXIST with the source gone (an earlier round moved it).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'eex', CWD)
        await appendRetentionEntry(logPath, { id: 'eex', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        const err = new Error('file exists')
        err.code = 'EEXIST'
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0, move: async (s) => { rmSync(s, { recursive: true, force: true }); throw err } })
      },
      async ({ report, logPath }) => {
        eq('sweep-g: an EEXIST with the source gone means the offload already happened', [report.alreadyArchived, report.errors], [1, 0])
        eq('sweep-g: the entry completed', (await readRetentionLog(logPath)).entries.length, 0)
      },
    )
    // A rename that reports EEXIST with the source still present (a true conflict).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'eex', CWD)
        await appendRetentionEntry(logPath, { id: 'eex', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        const err = new Error('file exists')
        err.code = 'EEXIST'
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0, move: () => Promise.reject(err) })
      },
      async ({ report, storeRoot, logPath }) => {
        eq('sweep-g: an EEXIST with the source present is an error, both sides kept', [report.errors, report.offloaded], [1, 0])
        ok('sweep-g: the source is intact and the line survives', existsSync(path.join(storeRoot, 'a', 'eex')) && (await readRetentionLog(logPath)).entries.length === 1)
      },
    )
    // The locate call itself throws (a broken persistence backend).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        const broken = { locate: () => { throw new Error('backend down') } }
        await appendRetentionEntry(logPath, { id: 'loc', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: broken, sessions: makeRegistry() }, now: () => T0 })
      },
      async ({ report, logPath, state }) => {
        eq('sweep-h: a locate failure keeps the entry for the next round', [report.errors, report.offloaded], [1, 0])
        ok('sweep-h: the failure is logged with the session id', state.warns.some((m) => m.includes('locating session loc failed')))
        eq('sweep-h: the line survives', (await readRetentionLog(logPath)).entries.length, 1)
      },
    )
    // The liveness rollback: the session goes live between the gate and the move.
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'rb', CWD)
        await appendRetentionEntry(logPath, { id: 'rb', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        const reg = makeRegistry()
        const handles = makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: reg }, now: () => T0 })
        return {
          sweeper: new OffloadSweeper({
            ctx: { get: (name) => (name === 'sessionPersistence' ? makeSpService(handles.storeRoot) : name === 'sessions' ? reg : undefined), logger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }) },
            logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
            home: { base: path.join(home, OFFLOAD_HOME_BASE), archive: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR), log: logPath, storeRoot: handles.storeRoot },
            units: () => mapJob(),
            inflight: new Set(),
            cap: DEFAULT_OFFLOAD_BATCH,
            now: () => T0,
            move: async () => {
              reg.known.add('rb') // the session goes live in the gap
            },
          }),
          state: handles.state,
        }
      },
      async ({ report, storeRoot, archiveDir, logPath }) => {
        eq('sweep-i: a session that goes live in the gap is neither offloaded nor an error', [report.offloaded, report.errors, report.skippedLive], [0, 0, 0])
        ok('sweep-i: the rollback moved the session back to the store', existsSync(path.join(storeRoot, 'a', 'rb')) && !existsSync(path.join(archiveDir, 'rb')))
        eq('sweep-i: the entry is kept for the next round', (await readRetentionLog(logPath)).entries.length, 1)
      },
    )
    // The unit-gone rule: no age check, the liveness gate still applies.
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'ug', CWD)
        await appendRetentionEntry(logPath, { id: 'ug', createdAt: iso(T0 - 1000), unit: 'ghost', cwd: CWD })
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
      },
      ({ report, archiveDir }) => {
        eq('sweep-j: a vanished unit is offloaded immediately, regardless of age', [report.offloaded, report.candidates], [1, 1])
        ok('sweep-j: the fresh (within-window-age) session was moved', existsSync(path.join(archiveDir, 'ug')))
      },
    )
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'ugl', CWD)
        const reg = makeRegistry(['ugl'])
        await appendRetentionEntry(logPath, { id: 'ugl', createdAt: iso(T0 - 1000), unit: 'ghost', cwd: CWD })
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: reg }, now: () => T0 })
      },
      ({ report }) => {
        eq('sweep-j: the liveness gate still applies to a vanished unit', [report.skippedLive, report.offloaded], [1, 0])
      },
    )
    // The window-0 unit (retention closed): entries are kept, never candidates.
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'keep', CWD)
        await appendRetentionEntry(logPath, { id: 'keep', createdAt: iso(T0 - 10 * 365 * W), unit: 'cold', cwd: CWD })
        return makeSweeper(home, { storeRoot, units: new Map([['cold', 0]]), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
      },
      async ({ report, logPath }) => {
        eq('sweep-k: a window-0 unit keeps even ancient entries', [report.candidates, report.offloaded], [0, 0])
        eq('sweep-k: the line survives', (await readRetentionLog(logPath)).entries.length, 1)
      },
    )
    // Reopening the window re-manages the retained entries (over-window
    // offloaded, within-window kept).
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'old', CWD)
        makeSessionDir(storeRoot, 'new', CWD)
        await appendRetentionEntry(logPath, { id: 'old', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        await appendRetentionEntry(logPath, { id: 'new', createdAt: iso(T0 - 1000), unit: 'job', cwd: CWD })
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
      },
      ({ report, archiveDir, storeRoot }) => {
        eq('sweep-l: the reopened window offloads the over-window entries and keeps the fresh one', [report.offloaded, report.candidates], [1, 1])
        ok('sweep-l: the over-window session is archived, the fresh one stays in the store', existsSync(path.join(archiveDir, 'old')) && existsSync(path.join(storeRoot, 'a', 'new')))
      },
    )
    // A cwd-less entry resolves through the _no-cwd project dir.
    await runCase(
      async ({ home, storeRoot, logPath }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'nc', undefined)
        await appendRetentionEntry(logPath, { id: 'nc', createdAt: iso(T0 - 2 * W), unit: 'job' })
        return makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
      },
      ({ report, archiveDir }) => {
        eq('sweep-m: a cwd-less entry is offloaded through the no-cwd project dir', [report.offloaded, report.errors], [1, 0])
        ok('sweep-m: the archive copy is named after the session id', existsSync(path.join(archiveDir, 'nc')))
      },
    )
    // The archive dir is rebuilt after external deletion (the next round heals).
    await runCase(
      async ({ home, storeRoot, logPath, archiveDir }) => {
        mkdirSync(storeRoot)
        makeSessionDir(storeRoot, 'h1', CWD)
        makeSessionDir(storeRoot, 'h2', CWD)
        await appendRetentionEntry(logPath, { id: 'h1', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        await appendRetentionEntry(logPath, { id: 'h2', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        const handles = makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
        await handles.sweeper.sweep() // the first round: both offloaded, the archive exists
        rmSync(archiveDir, { recursive: true, force: true }) // the operator wiped it
        makeSessionDir(storeRoot, 'h3', CWD)
        await appendRetentionEntry(logPath, { id: 'h3', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        return handles
      },
      ({ report, archiveDir }) => {
        eq('sweep-n: after the archive dir was deleted externally the next round rebuilds it and continues', [report.offloaded, report.errors], [1, 0])
        ok('sweep-n: the rebuilt archive holds the new offload', existsSync(path.join(archiveDir, 'h3')))
      },
    )
  }

  // -- budget: the per-sweep budget (file order, the oldest-first identity, the
  //        knob, the compaction regimes, sweep idempotency)
  {
    // 51 candidates with the default cap of 50: the first round takes the
    // fifty oldest (file order), the second round the remainder.
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        for (let i = 0; i < 51; i++) {
          const id = `n${String(i).padStart(2, '0')}`
          makeSessionDir(storeRoot, id, CWD)
          await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        }
        const { sweeper } = makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
        const first = await sweeper.sweep()
        eq('budget-a: the first round offloads exactly the budget', [first.offloaded, first.candidates], [50, 50])
        eq('budget-a: the identity is the fifty oldest entries, in file order', JSON.stringify((await readRetentionLog(logPath)).entries.map((e) => e.id)), JSON.stringify(['n50']))
        const second = await sweeper.sweep()
        eq('budget-a: the second round offloads the single remainder', [second.offloaded, second.candidates], [1, 1])
        eq('budget-a: the log is empty after both rounds', (await readRetentionLog(logPath)).entries.length, 0)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // The knob: cap 3 over five candidates (three offloaded in file order, then two).
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        for (const id of ['k1', 'k2', 'k3', 'k4', 'k5']) {
          makeSessionDir(storeRoot, id, CWD)
          await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        }
        const { sweeper } = makeSweeper(home, { storeRoot, units: mapJob(), cap: 3, services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
        const first = await sweeper.sweep()
        eq('budget-b: a valid knob value caps the round', [first.offloaded, first.candidates], [3, 3])
        const second = await sweeper.sweep()
        eq('budget-b: the remainder drains on the next round', second.offloaded, 2)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // Compaction regime 1: the rate fits the budget (the file drains to
    // steady state, the second round is a zero-action no-op).
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        for (let i = 0; i < 30; i++) {
          const id = `s${i}`
          makeSessionDir(storeRoot, id, CWD)
          await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        }
        const { sweeper } = makeSweeper(home, { storeRoot, units: mapJob(), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
        const first = await sweeper.sweep()
        eq('budget-c: the rate within the budget drains the file in one round', [first.offloaded, first.removedLines, first.balance], [30, 30, 0])
        eq('budget-c: the compaction ratio triggered the rewrite', first.completedRatio, 1)
        const second = await sweeper.sweep()
        eq('budget-c: the next round is a zero-action no-op (sweep idempotency)', [second.candidates, second.offloaded, second.removedLines, second.balance, second.increment], [0, 0, 0, 0, 0])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // Compaction regime 2: the rate exceeds the budget (the rewrite runs
    // while the completed share stays high; the balance creeps up by the
    // overrun per round).
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        const archiveDir = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR)
        mkdirSync(storeRoot)
        const { sweeper } = makeSweeper(home, { storeRoot, units: mapJob(), cap: 3, services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
        const rounds = []
        for (let r = 0; r < 3; r++) {
          for (let i = 0; i < 5; i++) {
            const id = `r${r}${i}`
            makeSessionDir(storeRoot, id, CWD)
            await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
          }
          rounds.push(await sweeper.sweep())
        }
        eq('budget-d: the over-budget rate rewrites while the completed share stays high', JSON.stringify(rounds.map((rp) => [rp.offloaded, rp.removedLines, rp.balance])), JSON.stringify([[3, 3, 2], [3, 3, 4], [3, 3, 6]]))
        ok('budget-d: every offload landed in the archive', existsSync(path.join(archiveDir, 'r00')) && existsSync(path.join(archiveDir, 'r13')))
        eq('budget-d: the file line count equals the reported balance', readFileSync(logPath, 'utf8').trim().split('\n').length, 6)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  }

  // -- trend: the trend alert (the consecutive over-envelope increments, the
  //        healthy negatives, the out-of-regime dormant branch, the knob
  //        recovery)
  {
    // Positive: the arrivals keep exceeding the budget for K rounds in a row.
    // (The first round only re-derives the balance baseline: it never judges.)
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        const { sweeper } = makeSweeper(home, { storeRoot, units: new Map([['cold', 0]]), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
        const results = []
        for (let r = 0; r < 13; r++) {
          for (let i = 0; i < 60; i++) await appendRetentionEntry(logPath, { id: `t${r}-${i}`, createdAt: iso(T0), unit: 'cold' })
          results.push(await sweeper.sweep())
        }
        const alerts = results.map((rp) => rp.trendAlert)
        eq('trend-a: the alert fires exactly on the K-th consecutive over-envelope sweep', JSON.stringify(alerts), JSON.stringify([false, false, false, false, false, false, false, false, false, false, true, true, true]))
        eq('trend-a: the balance grows by the arrivals each round', results[12].balance, 13 * 60)
        eq('trend-a: the reported increment is the arrivals', results[12].increment, 60)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // Healthy negative: bursts shorter than K rounds reset the counter.
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        const { sweeper } = makeSweeper(home, { storeRoot, units: new Map([['cold', 0]]), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
        const results = []
        for (let r = 0; r < 8; r++) {
          const burst = r < 3 ? 60 : 0
          for (let i = 0; i < burst; i++) await appendRetentionEntry(logPath, { id: `h${r}-${i}`, createdAt: iso(T0), unit: 'cold' })
          results.push(await sweeper.sweep())
        }
        ok('trend-b: a burst shorter than K rounds never alerts', results.every((rp) => !rp.trendAlert))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // At the boundary: arrivals equal to the budget are not over it (strict).
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        const { sweeper } = makeSweeper(home, { storeRoot, units: new Map([['cold', 0]]), services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }, now: () => T0 })
        const results = []
        for (let r = 0; r < 12; r++) {
          for (let i = 0; i < 50; i++) await appendRetentionEntry(logPath, { id: `b${r}-${i}`, createdAt: iso(T0), unit: 'cold' })
          results.push(await sweeper.sweep())
        }
        ok('trend-c: arrivals at exactly the budget never alert (the comparison is strict)', results.every((rp) => !rp.trendAlert))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // Out of regime: the rate is at least four times the budget (the
    // compaction trigger stays dormant, the alert is the visible signal);
    // raising the knob recovers it and flushes the completed backlog.
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        const services = { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }
        const units = mapJob()
        const quiet = () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} })
        const mkCtx = () => ({
          get: (name) => (services[name] !== undefined ? services[name] : undefined),
          logger: () => quiet(),
        })
        let sweeper = new OffloadSweeper({
          ctx: mkCtx(),
          logger: quiet(),
          home: { base: path.join(home, OFFLOAD_HOME_BASE), archive: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR), log: logPath, storeRoot },
          units: () => units,
          inflight: new Set(),
          cap: 5,
          now: () => T0,
        })
        const results = []
        for (let r = 0; r < 12; r++) {
          for (let i = 0; i < 21; i++) {
            const id = `o${r}-${i}`
            makeSessionDir(storeRoot, id, CWD)
            await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
          }
          results.push(await sweeper.sweep())
        }
        const alerts = results.map((rp) => rp.trendAlert)
        eq('trend-d: the out-of-regime rate alerts after K consecutive rounds', JSON.stringify(alerts), JSON.stringify([false, false, false, false, false, false, false, false, false, false, true, true]))
        ok('trend-d: the compaction trigger stayed dormant through the whole burst', results.every((rp) => rp.removedLines === 0 && rp.completedRatio < COMPACTION_RATIO))
        eq('trend-d: the deadweight backlog accumulated in the log file', readFileSync(logPath, 'utf8').trim().split('\n').length, 12 * 21)
        // The operator raises the knob: a fresh instance (like a process
        // restart) re-derives the baseline and the streak starts over.
        sweeper = new OffloadSweeper({
          ctx: mkCtx(),
          logger: quiet(),
          home: { base: path.join(home, OFFLOAD_HOME_BASE), archive: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR), log: logPath, storeRoot },
          units: () => units,
          inflight: new Set(),
          cap: 25,
          now: () => T0,
        })
        const recovery = []
        for (let r = 0; r < 3; r++) {
          recovery.push(await sweeper.sweep())
        }
        eq('trend-d: the raised knob re-enables the compaction trigger and flushes the backlog', JSON.stringify(recovery.map((rp) => [rp.offloaded, rp.removedLines, rp.balance])), JSON.stringify([[25, 85, 167], [25, 0, 167], [25, 50, 117]]))
        ok('trend-d: no trend alert under the recovered budget', recovery.every((rp) => !rp.trendAlert))
        const survivors = (await readRetentionLog(logPath)).entries
        eq('trend-d: only the pending (never-offloaded) lines survived the flush', survivors.length, 117)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    // trend-e: the alert line content (growth rate = (increment - cap) per sweep
    // and the branch discriminator: dormant out-of-regime vs active in-regime).
    {
      for (const [arrivals, cap, dormant] of [[21, 5, true], [12, 10, false]]) {
        const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
        try {
          const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
          const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
          const services = { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }
          const units = mapJob()
          const warns = []
          const mkLog = () => ({ warn: (m) => warns.push(m), error: () => {}, info: () => {}, debug: () => {} })
          const sweeper = new OffloadSweeper({
            ctx: {
              get: (name) => (services[name] !== undefined ? services[name] : undefined),
              logger: () => mkLog(),
            },
            logger: mkLog(),
            home: { base: path.join(home, OFFLOAD_HOME_BASE), archive: path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR), log: logPath, storeRoot },
            units: () => units,
            inflight: new Set(),
            cap,
            now: () => T0,
          })
          for (let r = 0; r < 12; r++) {
            for (let i = 0; i < arrivals; i++) {
              const id = `x${arrivals}-${r}-${i}`
              makeSessionDir(storeRoot, id, CWD)
              await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
            }
            await sweeper.sweep()
          }
          const alert = warns.find((m) => m.includes('trend alert'))
          const want = dormant
            ? ['growth rate 16/sweep', 'permanently dormant', 'completed lines are never evicted', 'check the offload batch knob first']
            : ['growth rate 2/sweep', 'still active', 'raise the offload batch knob or lower the dispatch rate']
          ok(
            `trend-e: the alert line carries the ${dormant ? 'dormant-branch' : 'active-branch'} content`,
            alert !== undefined && want.every((f) => alert.includes(f)),
            alert,
          )
          sweeper.dispose()
        } finally {
          rmSync(home, { recursive: true, force: true })
        }
      }
    }
  }

  // -- arming: the periodic arming (the immediate first round, the disposer)
  {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
    try {
      const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
      mkdirSync(storeRoot)
      const { sweeper, state } = makeSweeper(home, { storeRoot, services: { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() } })
      sweeper.start()
      ok('arming-a: start arms an immediate first round (the no-op round logs at debug)', await waitFor(() => state.debugs.some((m) => m.includes('sweep done')), 2000))
      sweeper.start() // re-arming is a no-op
      sweeper.dispose()
      ok('arming-a: dispose stops the timer without error', true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  // -- lifecycle: the run-lifecycle integration (the write gate through the real
  //        startRun chain, the in-flight lifecycle, the end-to-end archive
  //        move, and the unit-window view over a live scheduler)
  {
    const { startRun } = await import(path.join(PKG, 'lib/runner.js'))
    let probeSeq = 0
    // Drive the real startRun with a stub agent, wired to the OffloadSweeper's
    // hook methods exactly as the plugin assembly does (onRunStarted /
    // onDispatch from the runner entry, onRunSettled from the scheduler's
    // onRunEnd, mirrored here as the onRunEnd callback). The sweeper's clock
    // is mutable so a case can age the dispatched entry past its window.
    async function probe({ windowMs, cwd, hang = false } = {}) {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
      const pluginHome = path.join(home, OFFLOAD_HOME_BASE)
      const logPath = path.join(pluginHome, OFFLOAD_LOG_FILE)
      mkdirSync(storeRoot)
      const registry = makeRegistry()
      const { ctx, state } = fakeCtx({ sessionPersistence: makeSpService(storeRoot), sessions: registry })
      const inflight = new Set()
      // startRun's hard dependencies, mirrored from the settlement probe:
      // create resolves the stub agent, the deadlines never fire.
      ctx.agents = { create: async () => ({ agent, dispose: async () => {} }) }
      ctx.timeout = () => () => {}
      const clock = { t: T0 }
      const sweeper = new OffloadSweeper({
        ctx,
        logger: ctx.logger(),
        home: { base: pluginHome, archive: path.join(pluginHome, OFFLOAD_ARCHIVE_DIR), log: logPath, storeRoot },
        units: () => (windowMs === undefined ? new Map() : new Map([['job-x', windowMs]])),
        inflight,
        cap: DEFAULT_OFFLOAD_BATCH,
        now: () => clock.t,
      })
      const sessionId = `sess-probe-${probeSeq}`
      probeSeq += 1
      const agent = {
        session: { snapshotEvents: () => [] },
        cancel: () => {},
        followup: () => Promise.resolve(undefined),
        whenIdle: () => (hang ? new Promise(() => {}) : Promise.resolve(undefined)),
      }
      const run = {
        jobId: 'job-x',
        sessionId,
        trigger: 'manual',
        startedAt: Date.now(),
        runId: `op-${sessionId}`,
        finishedAt: 0,
        status: 'running',
        cause: null,
        pendingCause: null,
        followupError: null,
        handle: null,
        maxTimer: null,
        settled: false,
      }
      const model = {
        id: 'job-x',
        spec: { run: { prompt: 'offload probe', ...(cwd !== undefined ? { cwd } : {}) } },
        runtimeMaxMs: null,
      }
      const res = await startRun({
        ctx,
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        model,
        run,
        onRunStart: () => {},
        onRunEnd: () => sweeper.onRunSettled('job-x', sessionId),
        offload: {
          onRunStarted: (j, s) => sweeper.onRunStarted(j, s),
          onDispatch: (j, s, c) => sweeper.onDispatch(j, s, c),
        },
      })
      await sleep(hang ? 50 : 250) // settlement IIFE (whenIdle microtasks) completes
      return { sweeper, inflight, storeRoot, pluginHome, logPath, sessionId, res, state, clock, registry, cwd }
    }

    // lifecycle-a: the write gate open - a dispatched settled session is logged with
    // the session id, the job unit, the dispatch time and the run cwd.
    {
      const p = await probe({ windowMs: W, cwd: path.join(tmpdir(), 'ws-a') })
      try {
        eq('lifecycle-a: the run settles normally with the hooks wired', p.res.ok, true)
        ok('lifecycle-a: the settled session leaves the in-flight set', p.inflight.size === 0)
        ok('lifecycle-a: the write gate logged exactly the dispatched session', await waitFor(async () => {
          if (!existsSync(p.logPath)) return false
          return (await readRetentionLog(p.logPath)).entries.length === 1
        }, 4000))
        const line = (await readRetentionLog(p.logPath)).entries[0]
        ok('lifecycle-a: the log line carries the session id, the job unit, the dispatch time and the run cwd', line.id === p.sessionId && line.unit === 'job-x' && line.cwd === p.cwd && Date.parse(line.createdAt) === T0)
      } finally {
        rmSync(p.storeRoot, { recursive: true, force: true })
        rmSync(p.pluginHome, { recursive: true, force: true })
      }
    }
    // lifecycle-b: the write gate closed - a zero window is not tracked.
    {
      const p = await probe({ windowMs: 0, cwd: path.join(tmpdir(), 'ws-b') })
      try {
        eq('lifecycle-b: the run settles normally with a zero window', p.res.ok, true)
        await sleep(150) // the (skipped) retention append settles
        ok('lifecycle-b: without a retention window the write gate logs nothing', existsSync(p.logPath) === false)
        eq('lifecycle-b: the settled session leaves the in-flight set', p.inflight.size, 0)
      } finally {
        rmSync(p.storeRoot, { recursive: true, force: true })
        rmSync(p.pluginHome, { recursive: true, force: true })
      }
    }
    // lifecycle-c: a vanished unit - the job no longer loads: the dispatch is untracked.
    {
      const p = await probe({ windowMs: undefined, cwd: path.join(tmpdir(), 'ws-c') })
      try {
        eq('lifecycle-c: the run settles normally for a vanished unit', p.res.ok, true)
        await sleep(150)
        ok('lifecycle-c: a vanished unit is not tracked at dispatch time', existsSync(p.logPath) === false)
      } finally {
        rmSync(p.storeRoot, { recursive: true, force: true })
        rmSync(p.pluginHome, { recursive: true, force: true })
      }
    }
    // lifecycle-d: a cwd-less run fails at create before the write point: no line,
    // the in-flight mark is still cleared at settlement.
    {
      const p = await probe({ windowMs: W })
      try {
        eq('lifecycle-d: a cwd-less run fails create_failed with the actionable remedy', [p.res.ok, p.res.error !== undefined && p.res.error.includes('no run cwd')], [false, true])
        await sleep(150)
        eq('lifecycle-d: the create-failed run clears the in-flight mark', p.inflight.size, 0)
        ok('lifecycle-d: no retention line is written for a cwd-less run', existsSync(p.logPath) === false)
      } finally {
        rmSync(p.storeRoot, { recursive: true, force: true })
        rmSync(p.pluginHome, { recursive: true, force: true })
      }
    }
    // lifecycle-e: the end-to-end chain - dispatch, settle, age past the window, sweep:
    // the session dir is moved from the store into the archive and the line
    // compacts away.
    {
      const p = await probe({ windowMs: W, cwd: path.join(tmpdir(), 'ws-e') })
      try {
        eq('lifecycle-e: the run settles with the hooks wired', p.res.ok, true)
        makeSessionDir(p.storeRoot, p.sessionId, p.cwd) // the framework store side
        p.clock.t = T0 + 30_000 // within the window
        let rep = await p.sweeper.sweep()
        eq('lifecycle-e: the within-window session is kept (not yet due)', [rep.offloaded, rep.skippedLive, rep.balance], [0, 0, 1])
        p.clock.t = T0 + W + 1_000 // over the window
        rep = await p.sweeper.sweep()
        eq('lifecycle-e: the over-window settled session is offloaded', [rep.offloaded, rep.candidates], [1, 1])
        ok('lifecycle-e: the session dir left the store and entered the archive', !existsSync(path.join(p.storeRoot, path.basename(p.cwd), p.sessionId)) && existsSync(path.join(p.pluginHome, OFFLOAD_ARCHIVE_DIR, p.sessionId)))
        eq('lifecycle-e: the completed line is removed by the compaction rewrite', (await readRetentionLog(p.logPath)).entries.length, 0)
      } finally {
        rmSync(p.storeRoot, { recursive: true, force: true })
        rmSync(p.pluginHome, { recursive: true, force: true })
      }
    }
    // lifecycle-f: the registry liveness gate - a session that went live after its
    // settlement is not archived (the line and the source dir are kept).
    {
      const p = await probe({ windowMs: W, cwd: path.join(tmpdir(), 'ws-f') })
      try {
        eq('lifecycle-f: the run settles with the hooks wired', p.res.ok, true)
        makeSessionDir(p.storeRoot, p.sessionId, p.cwd)
        p.registry.known.add(p.sessionId) // went live again after settlement
        p.clock.t = T0 + W + 1_000
        const rep = await p.sweeper.sweep()
        eq('lifecycle-f: the live session is kept out of the archive', [rep.skippedLive, rep.offloaded], [1, 0])
        ok('lifecycle-f: the source dir is intact and the line survives', existsSync(path.join(p.storeRoot, path.basename(p.cwd), p.sessionId)) && (await readRetentionLog(p.logPath)).entries.length === 1)
      } finally {
        rmSync(p.storeRoot, { recursive: true, force: true })
        rmSync(p.pluginHome, { recursive: true, force: true })
      }
    }
    // lifecycle-g: the in-flight gate - an unsettled dispatch (the turn never ends)
    // is marked in-flight until its settlement; the sweep must not archive it.
    {
      const p = await probe({ windowMs: W, cwd: path.join(tmpdir(), 'ws-g'), hang: true })
      try {
        eq('lifecycle-g: the dispatch succeeds even though the turn never settles', p.res.ok, true)
        ok('lifecycle-g: the unsettled session stays in the shared in-flight set', p.inflight.has(p.sessionId) === true)
        makeSessionDir(p.storeRoot, p.sessionId, p.cwd)
        p.clock.t = T0 + W + 1_000
        const rep = await p.sweeper.sweep()
        eq('lifecycle-g: the in-flight session is not a candidate and not an error', [rep.skippedLive, rep.offloaded, rep.errors], [1, 0, 0])
        ok('lifecycle-g: the source dir is intact and the line survives', existsSync(path.join(p.storeRoot, path.basename(p.cwd), p.sessionId)) && (await readRetentionLog(p.logPath)).entries.length === 1)
        p.sweeper.dispose()
      } finally {
        rmSync(p.storeRoot, { recursive: true, force: true })
        rmSync(p.pluginHome, { recursive: true, force: true })
      }
    }
    // lifecycle-h: the unit-window view over a live scheduler (job file values:
    // valid string / valid number / null / absent / invalid / disabled unit /
    // rejected file), the warn dedupe, and hot updates through reload.
    {
      const { TimerScheduler } = await import(path.join(PKG, 'lib/scheduler.js'))
      const base = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const jobsDir = path.join(base, 'jobs')
        mkdirSync(jobsDir)
        const spec = (extra = {}, enable) => {
          const s = { onCalendar: ['2099-01-01T00:00:00Z'], run: { prompt: 'unit probe', ...extra } }
          if (enable !== undefined) s.enable = enable
          return JSON.stringify(s)
        }
        const file = (id, s) => writeFileSync(path.join(jobsDir, `${id}.json`), s)
        file('w1', spec({ sessionRetention: '24h' }))
        file('w2', spec({ sessionRetention: 900000 }))
        file('w3', spec({ sessionRetention: null }))
        file('w4', spec({}))
        file('w5', spec({ sessionRetention: 'banana' }))
        file('w6', spec({ sessionRetention: '1h30m' }, false))
        file('w7', '{ not valid json')
        const warns = []
        const logger = { debug: () => {}, info: () => {}, warn: (m) => warns.push(m), error: () => {} }
        const sched = new TimerScheduler({ ctx: {}, logger, jobsDir })
        await sched.reload()
        const windows = sched.unitWindows()
        eq('lifecycle-h: a valid string window resolves to ms', windows.get('w1'), 86_400_000)
        eq('lifecycle-h: a numeric window is ms', windows.get('w2'), 900000)
        eq('lifecycle-h: a null window is 0 (retain)', windows.get('w3'), 0)
        eq('lifecycle-h: an absent window is 0 (retain)', windows.get('w4'), 0)
        eq('lifecycle-h: an invalid window warns and resolves to 0', windows.get('w5'), 0)
        ok('lifecycle-h: the warning names the job and the invalid value', warns.some((m) => m.includes('w5') && m.includes('banana')))
        eq('lifecycle-h: a disabled job is still a unit (its window applies)', windows.get('w6'), 5_400_000)
        ok('lifecycle-h: a rejected job file is not a unit (vanished unit)', windows.has('w7') === false)
        eq('lifecycle-h: the view carries every loaded job exactly once', windows.size, 6)
        sched.unitWindows()
        eq('lifecycle-h: the invalid-window warning is deduplicated across rounds', warns.filter((m) => m.includes('banana')).length, 1)
        file('w5', spec({ sessionRetention: '4h30m' }))
        await sched.reload()
        const windows2 = sched.unitWindows()
        eq('lifecycle-h: a hot update re-derives the window without a restart', windows2.get('w5'), 16_200_000)
        eq('lifecycle-h: a repaired value leaves no new warning', warns.filter((m) => m.includes('w5')).length, 1)
        file('w1', spec({ sessionRetention: '4h30m' }))
        file('w2', '{ broken')
        await sched.reload()
        const windows3 = sched.unitWindows()
        eq('lifecycle-h: a hot update changes a valid window', windows3.get('w1'), 16_200_000)
        ok('lifecycle-h: a file that no longer parses drops its unit (vanished unit)', windows3.has('w2') === false)
        file('w5', spec({ sessionRetention: 'h30m' }))
        await sched.reload()
        sched.unitWindows()
        // the quoted value: the warning text carries an example duration whose
        // tail overlaps the bare substring, so match the raw value as quoted.
        eq('lifecycle-h: a changed invalid value warns again (the dedupe key is the raw value)', warns.filter((m) => m.includes('"h30m"')).length, 1)
        await sched.stop()
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    }
    // lifecycle-i: the unit-default window (the TIMER_SESSION_RETENTION env, boot-fixed
    // through the scheduler option): jobs with absent/null run.sessionRetention take
    // it; explicit values (valid or invalid) always take precedence; a rejected file
    // is still not a unit.
    {
      const { TimerScheduler } = await import(path.join(PKG, 'lib/scheduler.js'))
      const base = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const jobsDir = path.join(base, 'jobs')
        mkdirSync(jobsDir)
        const spec = (extra = {}) => JSON.stringify({ onCalendar: ['2099-01-01T00:00:00Z'], run: { prompt: 'unit probe', ...extra } })
        const file = (id, s) => writeFileSync(path.join(jobsDir, `${id}.json`), s)
        file('d1', spec({ sessionRetention: '24h' }))
        file('d2', spec({ sessionRetention: 900000 }))
        file('d3', spec({ sessionRetention: null }))
        file('d4', spec({}))
        file('d5', spec({ sessionRetention: 'banana' }))
        file('d6', '{ not valid json')
        const warns = []
        const logger = { debug: () => {}, info: () => {}, warn: (m) => warns.push(m), error: () => {} }
        const sched = new TimerScheduler({ ctx: {}, logger, jobsDir, defaultRetentionMs: 3_600_000 })
        await sched.reload()
        const windows = sched.unitWindows()
        eq('lifecycle-i: an explicit string window takes precedence over the default', windows.get('d1'), 86_400_000)
        eq('lifecycle-i: an explicit numeric window takes precedence over the default', windows.get('d2'), 900000)
        eq('lifecycle-i: a null window takes the unit default', windows.get('d3'), 3_600_000)
        eq('lifecycle-i: an absent window takes the unit default', windows.get('d4'), 3_600_000)
        eq('lifecycle-i: an explicit invalid window warns and resolves to 0 (the default does not rescue it)', windows.get('d5'), 0)
        ok('lifecycle-i: the warning names the job and the invalid value', warns.some((m) => m.includes('d5') && m.includes('banana')))
        ok('lifecycle-i: a rejected job file is not a unit (vanished unit)', windows.has('d6') === false)
        eq('lifecycle-i: the view carries every loaded job exactly once', windows.size, 5)
        await sched.stop()
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    }
  }

  // -- logfault: the lost-retention-log startup warning and the
  //         append<->compaction mutex (the rewrite-window seam)
  {
    const mkSweeperCase = async (seed) => {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const archive = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot)
        const services = { sessionPersistence: makeSpService(storeRoot), sessions: makeRegistry() }
        const warns = []
        const mkLog = () => ({ warn: (m) => warns.push(m), error: () => {}, info: () => {}, debug: () => {} })
        seed(archive, home)
        const sweeper = new OffloadSweeper({
          ctx: { get: (n) => (services[n] !== undefined ? services[n] : undefined), logger: () => mkLog() },
          logger: mkLog(),
          home: { base: path.join(home, OFFLOAD_HOME_BASE), archive, log: logPath, storeRoot },
          units: () => mapJob(),
          inflight: new Set(),
          cap: 50,
          now: () => T0,
        })
        await sweeper.sweep()
        await sweeper.sweep()
        sweeper.dispose()
        return warns.filter((m) => m.includes('retention log is missing'))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
    const fresh = await mkSweeperCase(() => {})
    eq('logfault-a: a fresh install (no archive, no log) stays silent', fresh.length, 0)
    const lost = await mkSweeperCase((archive) => {
      mkdirSync(path.join(archive, 'x'), { recursive: true })
      writeFileSync(path.join(archive, 'x', 'session.v4.jsonl.zstd'), 'log')
    })
    ok('logfault-b: the lost log warns prominently on startup (exactly once across rounds)', lost.length === 1, lost)
    // logfault-c: park the compaction rewrite between its temp write and its rename,
    // append across the window, and prove the mutex serializes the append onto
    // the post-rename file (the line survives).
    {
      const home = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-'))
      try {
        const storeRoot = path.join(home, OFFLOAD_STORE_ROOT)
        const archive = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_ARCHIVE_DIR)
        const logPath = path.join(home, OFFLOAD_HOME_BASE, OFFLOAD_LOG_FILE)
        mkdirSync(storeRoot, { recursive: true })
        mkdirSync(archive, { recursive: true })
        // Four entries pre-archived (completed), one live (kept by the
        // rewrite): the round rewrites the log down to the live line.
        const liveId = 'm4'
        for (let i = 0; i < 5; i++) {
          const id = `m${i}`
          makeSessionDir(storeRoot, id, CWD)
          await appendRetentionEntry(logPath, { id, createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        }
        for (let i = 0; i < 4; i++) {
          const { renameSync } = await import('node:fs')
          renameSync(path.join(storeRoot, path.basename(CWD), `m${i}`), path.join(archive, `m${i}`))
        }
        let parked = false
        let release
        const gate = new Promise((r) => { release = r })
        offload.rewriteBarrier.fn = async () => {
          parked = true
          await gate
        }
        const quiet = () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} })
        const sweeper = new OffloadSweeper({
          ctx: {
            get: (n) =>
              n === 'sessionPersistence'
                ? makeSpService(storeRoot)
                : n === 'sessions'
                  ? makeRegistry([liveId])
                  : undefined,
            logger: () => quiet(),
          },
          logger: quiet(),
          home: { base: path.join(home, OFFLOAD_HOME_BASE), archive, log: logPath, storeRoot },
          units: () => mapJob(),
          inflight: new Set(),
          cap: 50,
          now: () => T0,
        })
        // A ref'd keep-alive handle: the parked rewrite and the queued
        // append are pure promise chains, which alone would let the event
        // loop empty and end the process mid-window.
        const keepAlive = setInterval(() => {}, 50)
        const run = sweeper.sweep()
        await waitFor(() => parked)
        // The append is created (queued behind the rewrite in the mutex) but
        // not awaited yet: awaiting it before the release would deadlock,
        // because the rewrite holds the mutex until its rename.
        const pendingAppend = appendRetentionEntry(logPath, { id: 'mnew', createdAt: iso(T0 - 2 * W), unit: 'job', cwd: CWD })
        release()
        await pendingAppend
        const rep = await run
        clearInterval(keepAlive)
        const after = (await readRetentionLog(logPath)).entries
        ok(
          'logfault-c: an append parked in the rewrite window survives the rewrite (the write mutex)',
          rep.removedLines === 4 && after.length === 2 && after.some((e) => e.id === liveId) && after.some((e) => e.id === 'mnew'),
          JSON.stringify([rep.removedLines, after.map((e) => e.id)]),
        )
        sweeper.dispose()
      } finally {
        offload.rewriteBarrier.fn = undefined
        rmSync(home, { recursive: true, force: true })
      }
    }
  }
}
{ // layout: the plugin-level layout pin. The offload-plane fixture sections
  // above validate the sweeper component under the real-world layout, but none of
  // them constructs the plugin: this section pins, at the plugin level, the single
  // layout definition the constructor delegates to (offloadLayout) - the retention
  // log and the archive under the plugin home, the store root as the FRAMEWORK
  // session store (a sibling of the plugin home, never under it).
  const offload = await import(path.join(PKG, 'lib/offload.js'))
  {
    // layout-a: the layout helper resolves the four locations relative to the harness
    // home; the store root must be its SIBLING (a direct root/<segment> join), not
    // a child of the plugin home (a phantom root there - one that nothing ever
    // creates - would disable every sweep round).
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-timer-offload-layout-'))
    try {
      const lay = offload.offloadLayout((seg) => path.join(root, seg))
      eq('layout-a: the plugin home base is $DSH_HOME/dsh-timer', lay.base, path.join(root, 'dsh-timer'))
      eq('layout-a: the archive sits under the plugin home', lay.archive, path.join(root, 'dsh-timer', 'archived-sessions'))
      eq('layout-a: the retention log sits under the plugin home', lay.log, path.join(root, 'dsh-timer', 'retention-log.jsonl'))
      eq('layout-a: the store root is the framework store, a SIBLING of the plugin home', lay.storeRoot, path.join(root, 'sessions'))
      ok('layout-a: the store root is never a child of the plugin home', !lay.storeRoot.startsWith(lay.base + path.sep))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  {
    // layout-b: the constructor delegates its wiring to the helper (a source-level pin -
    // constructing the plugin in-package needs the full cordis container); a wiring
    // that bypasses the helper or re-derives the store root under the plugin home
    // fails here before it ships.
    const indexSrc = readFileSync(path.join(PKG, 'src/index.ts'), 'utf8')
    ok('layout-b: the constructor wires the sweeper home through offloadLayout', indexSrc.includes('home: offloadLayout(resolveHome)'))
    ok('layout-b: the store root is never re-derived under the plugin home in the constructor', !indexSrc.includes('OFFLOAD_STORE_ROOT'))
  }
}
{ // shipped-tree ASCII gate: every shipped file in the package (src, test, lib,
  // skill, schemas, README, cordis.patch.yml, package.json, toolchain config)
  // is strict ASCII; a single non-ASCII character anywhere in the tree fails the
  // selftest. The compiled lib/ is scanned as well, so a non-ASCII source cannot
  // hide behind a stale build.
  const asciiSkip = new Set(['.git', 'node_modules', '.selftest-tmp'])
  const asciiWalk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (asciiSkip.has(e)) continue
      const p = path.join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) asciiWalk(p)
      else if (st.isFile()) ok(`ascii: ${path.relative(PKG, p)} is strict ASCII`, /^[\x00-\x7F]*$/.test(readFileSync(p, 'utf8')))
    }
  }
  asciiWalk(PKG)
}
{ // shipped-source hygiene guard: src/ stays self-contained and process-fact-free - a reader
  // needs only the file plus stable external authorities (systemd v262 semantics, the croner
  // API, framework API names). No CJK characters, no two-digit project version tags (a
  // three-digit external pin such as systemd v262 would not match the two-digit pattern),
  // and no calendar dates in src/. Test files are held to the same standard by the selftest
  // hygiene guard below.
  for (const f of readdirSync(path.join(PKG, 'src'))) {
    if (!f.endsWith('.ts')) continue
    const src = readFileSync(path.join(PKG, 'src', f), 'utf8')
    ok(`shipped source: src/${f} carries no CJK characters`, !/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(src))
    ok(`shipped source: src/${f} carries no version-round tags`, !/\bv\d{2}\b/.test(src))
    ok(`shipped source: src/${f} carries no calendar dates`, !/20\d{2}-\d{2}-\d{2}/.test(src))
  }
}
{ // selftest hygiene guard: the selftest itself stays self-contained - no dangling pointers
  // to non-shipped material (design-doc sections, review findings, version-round labels,
  // machine-specific paths, source line-number pointers, CJK ruling quotes). A reader needs
  // only this file plus the shipped source and stable external authorities. Test-vector dates
  // (deterministic clock inputs and their derivation notes) are data, not provenance, and are
  // exempt. This guard block is excluded from its own scan.
  const raw = readFileSync(path.join(PKG, 'test', 'selftest.mjs'), 'utf8')
  const testSrc = raw.slice(0, raw.indexOf('// selftest hygiene guard'))
  ok('selftest hygiene: no design-doc section pointers', !/design doc|design v\d|spec \u00a7|\u00a7\d/.test(testSrc))
  ok('selftest hygiene: no machine-specific paths', !/\/workspace\//.test(testSrc))
  ok('selftest hygiene: no source line-number pointers', !/L\d+[---]L?\d+/.test(testSrc))
  ok('selftest hygiene: no review-round wrappers', !/round-?\d+|review #\d/.test(testSrc))
  ok('selftest hygiene: no project version-round tags', !/\bv\d{2}\b/.test(testSrc))
  ok('selftest hygiene: no CJK characters', !/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(testSrc))
  ok('selftest hygiene: no review finding identifiers', !/R\d{1,2}-[A-Za-z]\w*/.test(testSrc))
  ok('selftest hygiene: no version-round identifiers', !/\bv\d{2}[A-Za-z_]\w*/.test(testSrc))
}
// -- results ------------------------------------------------------
console.log(`selftest: ${passed} passed, ${failures.length} failed`)
for (const f of failures) console.log(`  FAIL: ${f}`)
process.exit(failures.length > 0 ? 1 : 0)
