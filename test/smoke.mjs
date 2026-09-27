// dsh-timer smoke: framework-path checks the zero-framework selftest cannot cover.
// Requires the peer packages (dsh-tools, dsh-skill) to be installed; run: node test/smoke.mjs
// All green = exit code 0.
// the framework validates tool arguments against the declared
// parameter schema before execute; this smoke runs that exact validation against the real
// registered tool schema, so a schema that rejects values its own descriptions and
// job.schema.json promise is caught by the gates instead of only at runtime.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { registerTool } = await import(path.join(PKG, 'lib/tool.js'))
const { registerSkill } = await import(path.join(PKG, 'lib/skill.js'))

// ── tool schema: the framework pre-execution validation gate ─────────────
let captured = null
const toolCtx = { tools: { register: (tool) => { captured = tool; return () => {} } } }
registerTool(toolCtx, {})
assert.ok(captured, 'registerTool registered a tool definition')
assert.equal(captured.name, 'timer')
const params = captured.parameters
const specProps = params.properties.spec.properties
const runProps = specProps.run.properties

// The seven null-tolerant fields must compile to oneOf unions carrying a null branch,
// mirroring the type unions of job.schema.json (the null branches must be reachable
// on the tool path, not only on the file path).
const jobSchema = JSON.parse(await import('node:fs').then((fs) => fs.promises.readFile(path.join(PKG, 'schemas', 'job.schema.json'))))
for (const f of ['onCalendar', 'onActiveSec', 'onStartupSec', 'runtimeMaxSec']) {
  assert.ok(Array.isArray(specProps[f].oneOf), `tool schema ${f} compiles to oneOf`)
  assert.ok(specProps[f].oneOf.some((b) => b.type === 'null'), `tool schema ${f} has a null branch`)
  assert.ok(Array.isArray(jobSchema.properties[f].type) && jobSchema.properties[f].type.includes('null'), `job schema ${f} is null-tolerant`)
}
for (const f of ['cwd', 'preset', 'model', 'policy']) {
  assert.ok(Array.isArray(runProps[f].oneOf), `tool schema run.${f} compiles to oneOf`)
  assert.ok(runProps[f].oneOf.some((b) => b.type === 'null'), `tool schema run.${f} has a null branch`)
  assert.ok(Array.isArray(jobSchema.properties.run.properties[f].type) && jobSchema.properties.run.properties[f].type.includes('null'), `job schema run.${f} is null-tolerant`)
}

// Positive: the null contract the descriptions and job.schema.json promise is accepted
// by the framework validation (before the fix these args were rejected pre-execute).
assert.deepEqual(
  validateJsonSchemaValue(params, { verb: 'add', spec: { onCalendar: null, onActiveSec: null, onStartupSec: '30s', run: { prompt: 'p', cwd: null, preset: null, model: null, policy: null } } }, ''),
  [],
  'null triggers and null run fields pass the framework schema',
)
assert.deepEqual(
  validateJsonSchemaValue(params, { verb: 'add', spec: { onCalendar: ['0 9 * * *'], runtimeMaxSec: null, run: { prompt: 'p' } } }, ''),
  [],
  'runtimeMaxSec null passes the framework schema (no limit)',
)
assert.deepEqual(
  validateJsonSchemaValue(params, { verb: 'add', id: 'x', spec: { onCalendar: ['0 9 * * *'], run: { prompt: 'p', policy: 'workspace-write' } } }, ''),
  [],
  'valid non-null args pass the framework schema',
)

// Negative: type/enum/required violations are rejected with path-qualified messages.
function firstViolation(args, needle) {
  const violations = validateJsonSchemaValue(params, args, '')
  assert.ok(violations.length > 0, `expected a violation for ${JSON.stringify(args)}`)
  assert.ok(violations.some((v) => v.includes(needle)), `expected a violation containing ${needle}, got: ${violations.join('; ')}`)
}
firstViolation({ verb: 'add', spec: { onCalendar: 'x', run: { prompt: 'p' } } }, 'onCalendar')
firstViolation({ verb: 'add', spec: { onActiveSec: 42, run: { prompt: 'p' } } }, 'onActiveSec')
firstViolation({ verb: 'add', spec: { onCalendar: 42, run: { prompt: 'p' } } }, 'onCalendar')
firstViolation({ verb: 'add', spec: { onCalendar: ['0 9 * * *'], runtimeMaxSec: 42, run: { prompt: 'p' } } }, 'runtimeMaxSec')
firstViolation({ verb: 'add', spec: { onCalendar: ['0 9 * * *'], run: { prompt: 'p', policy: 'all' } } }, 'policy')
firstViolation({ verb: 'add', spec: { onCalendar: ['0 9 * * *'], run: { prompt: 'p', cwd: 42 } } }, 'cwd')
firstViolation({ spec: { onCalendar: ['0 9 * * *'], run: { prompt: 'p' } } }, 'verb')
firstViolation({ verb: 'explode' }, 'verb')

// ── skill provider: shape, frontmatter strip, schema pointer ─────────────
let skillFactory = null
const skillCtx = { skills: { registerProvider: (factory) => { skillFactory = factory; return () => {} } } }
registerSkill(skillCtx)
assert.ok(skillFactory, 'registerSkill registered a provider factory')
const provider = skillFactory()
assert.equal(provider.name, 'dsh-timer')
const candidates = await provider.list()
assert.equal(candidates.length, 1)
assert.equal(candidates[0].name, 'dsh-timer')
assert.ok(candidates[0].description.length > 0)
const content = (await provider.get(candidates[0])).content
assert.ok(!content.startsWith('---'), 'get() returns the body with the frontmatter stripped')
assert.ok(!content.includes('whenToUse'), 'frontmatter fields do not leak into the body')
assert.ok(content.includes('../../schemas/job.schema.json'), 'body points at the job schema')
assert.equal(await provider.get({ name: 'other' }), undefined, 'foreign candidates resolve to undefined')

console.log('smoke: all checks passed')
