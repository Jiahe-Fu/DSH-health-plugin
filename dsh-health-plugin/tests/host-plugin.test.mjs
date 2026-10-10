/**
 * Host-plugin smoke test.
 *
 * Loads `index.js` the way the Harness loader would (importing the real module,
 * resolving `defineTool` from the installation), then drives the registered
 * tools and HTTP routes against a throwaway data directory. This is what makes
 * "the plugin is wired correctly" a checked claim instead of a hopeful one:
 * a typo in a route path or a missing inject fails here, not in the user's UI.
 *
 * Requires the Harness binary for asar resolution:
 *   $env:ELECTRON_RUN_AS_NODE=1; & "<install>\DeepSeek Harness.exe" --test tests/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import * as plugin from '../index.js'
import { isHealthMode, setHealthMode } from '../src/health-mode.js'

const ROUTE_PREFIX = '/dsh-health'

/** Build a ctx stub that records what the plugin registered. */
function makeCtx() {
  const tools = new Map()
  const routes = []
  const dispose = []
  const promptSections = []
  const promptVariables = new Map()
  const commands = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      }
    },
    webServer: {
      register(route, label) {
        // The real server keys by path and keeps the last registration for it,
        // so mirror that here: a duplicated path must fail a test rather than
        // quietly pass with a dead route.
        const existing = routes.findIndex((entry) => entry.path === route.path)
        const record = { ...route, label }
        if (existing >= 0) routes.splice(existing, 1, record)
        else routes.push(record)
        return () => undefined
      }
    },
    systemPrompt: {
      section(section) {
        promptSections.push(section)
        return () => undefined
      },
      variable(name, provider) {
        promptVariables.set(name, provider)
        return () => promptVariables.delete(name)
      }
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      }
    },
    skills: {
      register(skill) {
        const list = (ctx.__skills ??= [])
        list.push(skill)
        return () => undefined
      }
    },
    get(name) {
      if (name === 'skills') return ctx.skills
      if (name === 'web') return ctx.__web
      return undefined
    },
    /**
     * A settable web service, mirroring `ctx.web`. Tests replace it before
     * calling a tool so the network path is exercised without a network.
     */
    __web: undefined,
    effect(fn) {
      dispose.push(fn())
      return () => undefined
    },
    logger: { info: () => undefined, debug: () => undefined }
  }
  return { ctx, tools, routes, promptSections, promptVariables, commands }
}

/** Minimal ServerResponse stand-in. */
class FakeResponse {
  constructor(onFinish) {
    this.status = 0
    this.headers = {}
    this.body = ''
    this.onFinish = onFinish
  }

  writeHead(status, headers) {
    this.status = status
    this.headers = { ...headers }
  }

  end(text) {
    this.body = text ?? ''
    this.onFinish?.()
  }

  json() {
    return JSON.parse(this.body)
  }
}

/** Start one request against a registered route and decode its response. */
async function startRoute(routes, method, path, { query = {}, body, rawBody } = {}) {
  const url = new URL(path, 'http://localhost')
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item)
    else url.searchParams.set(key, value)
  }
  const route = routes.find((entry) => entry.path === url.pathname)
  if (route === undefined) throw new Error(`no route registered for ${url.pathname}`)

  let settle
  const done = new Promise((resolvePromise) => { settle = resolvePromise })
  const response = new FakeResponse(settle)
  const request = new EventEmitter()
  // `IncomingMessage` always reports an upper-case verb; mirror that exactly so
  // the plugin's method dispatch is exercised the way the server will call it.
  request.method = method.toUpperCase()
  request.url = `${url.pathname}${url.search}`
  request.destroy = () => undefined
  route.handler(request, response)
  // `dispatch` reads the body only after an await, so the payload has to be
  // emitted on a later turn than the handler call or the reader misses it.
  setTimeout(() => {
    if (rawBody !== undefined) request.emit('data', Buffer.from(rawBody, 'utf8'))
    else if (body !== undefined) request.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    request.emit('end')
  }, 0)

  await Promise.race([
    done,
    new Promise((_, rejectPromise) => setTimeout(() => rejectPromise(new Error(`route ${url.pathname} never answered`)), 4000))
  ])
  return response
}

const callRoute = startRoute

async function withPlugin(config, run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-health-plugin-'))
  try {
    const { ctx, tools, routes, promptSections, promptVariables, commands } = makeCtx()
    const dispose = plugin.apply(ctx, { dir, ...config })
    try {
      return await run({ tools, routes, promptSections, promptVariables, commands, dir, dispose, ctx, service: ctx.__service })
    } finally {
      if (typeof dispose === 'function') await dispose()
    }
  } finally {
    // `apply` starts an asynchronous `ensureLayout`, so the data directory can
    // still be written a moment after the test body ends. Retry the teardown
    // rather than failing the test on that race.
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === 11) throw error
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
      }
    }
  }
}

// --------------------------------------------------------------- loading ----

test('plugin: exports the loader contract and resolves defineTool', () => {
  assert.equal(plugin.name, 'dsh-health-plugin')
  // `systemPrompt` and `skills` must be declared: reaching for an undeclared
  // injected service throws "cannot get property X without inject" even when
  // the service exists, which is how the prompt section silently vanished.
  // `web` is deliberately absent: it is an optional capability attached with
  // `ctx.get`, because putting it in `inject` would take the whole plugin down
  // in a composition without a web provider.
  assert.deepEqual(plugin.inject, ['tools', 'webServer', 'systemPrompt', 'skills', 'commands'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.resolveConfig, 'function')
})

test('plugin: config validation rejects typos and bad kinds', () => {
  const base = plugin.resolveConfig({})
  assert.equal(base.verbose, false)
  assert.equal(base.routes, true)
  assert.equal(base.systemPrompt, true)
  assert.equal(base.skill, true)
  assert.ok(base.enabledKinds.includes('sleep'))

  assert.throws(() => plugin.resolveConfig({ verbosee: true }), /unknown config field/)
  assert.throws(() => plugin.resolveConfig({ enabledKinds: ['sleep', 'telepathy'] }), /unknown enabledKinds/)
  assert.throws(() => plugin.resolveConfig({ enabledKinds: [] }), /cannot be empty/)
})

test('plugin: registration wires every tool, route, prompt section and skill', async () => {
  await withPlugin({}, async ({ tools, routes, promptSections, promptVariables, commands, ctx }) => {
    const expectedTools = [
      'health_record', 'health_bulk_record', 'health_query', 'health_overview',
      'sleep_log', 'sleep_analyze', 'health_report', 'health_profile', 'health_manage',
      'medication_regimen', 'drug_notes', 'medication_taken'
    ]
    for (const name of expectedTools) {
      assert.ok(tools.has(name), `${name} should be registered`)
      const definition = tools.get(name)
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 30, `${name} needs a real description`)
      assert.equal(typeof definition.execute, 'function')
      assert.equal(definition.output.schema.type, 'object')
    }
    // The exported name list must match the registry, or the journal lies.
    assert.deepEqual([...plugin.TOOL_NAMES].sort(), [...expectedTools].sort())

    const paths = routes.map((route) => route.path).sort()
    assert.deepEqual(paths, [...plugin.ROUTE_PATHS].sort())
    assert.equal(new Set(paths).size, paths.length, 'no route path may repeat')
    assert.match(routes.find((route) => route.path === `${ROUTE_PREFIX}/profile`).label, /GET\|POST/)
    // Nothing may live under /api: that prefix belongs to the host's RPC channel.
    assert.equal(paths.some((path) => path.startsWith('/api/')), false, 'routes must avoid /api')

    assert.equal(promptSections.length, 1)
    assert.match(promptSections[0].text, /health_record/)
    // The mode line is a variable so the section text stays cacheable.
    assert.match(promptSections[0].text, /\{\{health_mode\}\}/)

    // The prompt variable must answer for both states of the live flag. It is a
    // variable rather than fixed text so the section stays cacheable.
    const variable = promptVariables.get('health_mode')
    assert.equal(typeof variable, 'function')
    const agent = {}
    assert.match(variable({ agent }), /未开启/)
    setHealthMode(agent, true)
    assert.match(variable({ agent }), /已开启/)
    assert.match(variable({ agent: undefined }), /未开启/, 'no agent means no health mode')

    assert.equal(ctx.__skills.length, 1)
    assert.equal(ctx.__skills[0].name, 'health-insomnia-protocol')
    assert.equal(ctx.__skills[0].invocation.modelInvocable, true)
    assert.ok(ctx.__skills[0].content.length > 1000, 'the protocol body ships with the plugin')
    assert.match(ctx.__skills[0].content, /睡眠限制/)

    assert.equal(commands.size, 1)
    assert.ok(commands.has('health'))
    assert.equal(typeof commands.get('health').handler, 'function')
  })
})

test('plugin: the archive directory exists as soon as the plugin applies', async () => {
  await withPlugin({}, async ({ dir }) => {
    // `apply` kicks off ensureLayout; give it a few turns to land.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await readFile(join(dir, 'README.txt'), 'utf8')
        return
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
      }
    }
    throw new Error('README.txt was never created by ensureLayout')
  })
})

test('plugin: tools, routes, prompt and skill can each be turned off', async () => {
  await withPlugin({ routes: false, systemPrompt: false, skill: false }, async ({ tools, routes, promptSections, ctx }) => {
    assert.equal(routes.length, 0)
    assert.equal(promptSections.length, 0)
    assert.equal(ctx.__skills, undefined)
    assert.ok(tools.has('health_record'), 'tools stay available')
  })
})

test('skill document parsing handles frontmatter, folded scalars and rejects junk', () => {
  const good = plugin.parseSkillDocument([
    '---',
    'name: my-skill',
    'description: >-',
    '  A long description',
    '  folded onto one line.',
    '---',
    '',
    'Body text here.'
  ].join('\n'))
  assert.equal(good.name, 'my-skill')
  assert.equal(good.description, 'A long description folded onto one line.')
  assert.equal(good.content, 'Body text here.')

  assert.throws(() => plugin.parseSkillDocument(''), /empty/)
  assert.throws(() => plugin.parseSkillDocument('no frontmatter'), /missing a frontmatter/)
  assert.throws(() => plugin.parseSkillDocument('---\nname: Bad_Name\ndescription: x\n---\nbody'), /kebab-case/)
  assert.throws(() => plugin.parseSkillDocument('---\nname: ok-name\n---\nbody'), /description/)
  assert.throws(() => plugin.parseSkillDocument('---\nname: ok-name\ndescription: d\n---\n'), /empty body/)
})

// ------------------------------------------------------------ tool paths ----

test('tools: sleep_log stores a night and computes the derived numbers', async () => {
  await withPlugin({}, async ({ tools, dir }) => {
    const result = await tools.get('sleep_log').execute({
      date: '2026-03-10',
      bedtime: '23:20',
      out_of_bed: '07:05',
      sleep_onset_min: 35,
      waso_min: 25,
      quality: 3
    })
    assert.equal(result.ok, true)
    assert.equal(result.record.kind, 'sleep')
    // 23:20 -> 07:05 is 465 min in bed; 465 - 35 - 25 = 405 min asleep.
    assert.equal(result.record.value.tibMin, 465)
    assert.equal(result.record.value.tstMin, 405)
    assert.equal(Math.round(result.record.value.efficiency * 100), 87)

    const raw = await readFile(join(dir, 'records', '2026.jsonl'), 'utf8')
    assert.ok(raw.includes('"kind":"sleep"'))
  })
})

test('tools: health_record refuses an implausible value with a clear message', async () => {
  await withPlugin({}, async ({ tools }) => {
    await assert.rejects(
      async () => tools.get('health_record').execute({ kind: 'weight', value: { kg: 900 } }),
      /plausible maximum/
    )
  })
})

test('tools: dangerous readings come back as flags', async () => {
  await withPlugin({}, async ({ tools }) => {
    const result = await tools.get('health_record').execute({
      kind: 'blood_pressure',
      value: { systolic: 192, diastolic: 126 }
    })
    assert.equal(result.ok, true)
    assert.ok(result.flags.some((flag) => flag.includes('\u7acb\u5373\u5c31\u533b')))
  })
})

test('tools: health_bulk_record reports per-entry failures instead of aborting', async () => {
  await withPlugin({}, async ({ tools }) => {
    const result = await tools.get('health_bulk_record').execute({
      entries: [
        { kind: 'weight', value: { kg: 70.4 }, date: '2026-03-10' },
        { kind: 'heart_rate', value: { bpm: 9999 }, date: '2026-03-10' },
        { kind: 'mood', value: { mood: '\u5e73\u9759', score: 4 }, date: '2026-03-10' }
      ]
    })
    assert.equal(result.count, 2)
    assert.equal(result.ok, false)
    assert.equal(result.failed.length, 1)
    assert.match(result.failed[0].error, /plausible maximum/)
  })
})

test('tools: sleep_analyze withholds the plan for a contraindicated profile', async () => {
  await withPlugin({}, async ({ tools }) => {
    await tools.get('health_profile').execute({
      action: 'update',
      patch: {
        conditions: ['\u53cc\u76f8\u60c5\u611f\u969c\u788d'],
        occupation: '\u8d27\u8f66\u53f8\u673a',
        targetWake: '06:30'
      }
    })
    for (let i = 0; i < 10; i++) {
      const date = `2026-03-${String(i + 1).padStart(2, '0')}`
      await tools.get('sleep_log').execute({
        date,
        bedtime: '23:00',
        out_of_bed: '07:00',
        sleep_onset_min: 80,
        waso_min: 50
      })
    }
    const result = await tools.get('sleep_analyze').execute({ days: 14, to: '2026-03-10' })
    assert.equal(result.plan.safety.ok, false)
    assert.equal(result.plan.plan.adjustment, 'none')
    const codes = result.plan.safety.refusals.map((refusal) => refusal.code)
    assert.ok(codes.includes('contraindication:bipolar'))
    assert.ok(codes.some((code) => code.startsWith('contraindication:safety_critical')))
    assert.equal(result.analysis.nights, 10)
  })
})

test('tools: sleep_analyze prescribes a concrete window when it is safe to', async () => {
  await withPlugin({}, async ({ tools }) => {
    await tools.get('health_profile').execute({ action: 'update', patch: { targetWake: '07:00', birthYear: 1996 } })
    for (let i = 0; i < 14; i++) {
      const date = `2026-03-${String(i + 1).padStart(2, '0')}`
      await tools.get('sleep_log').execute({
        date,
        bedtime: '22:00',
        out_of_bed: '07:00',
        sleep_onset_min: 75,
        waso_min: 45
      })
    }
    const result = await tools.get('sleep_analyze').execute({ days: 14, to: '2026-03-14' })
    assert.equal(result.plan.safety.ok, true)
    assert.equal(result.plan.plan.adjustment, 'shrink')
    assert.equal(result.plan.plan.targetWake, '07:00')
    assert.match(result.plan.plan.targetBed, /^\d{2}:\d{2}$/)
    assert.ok(result.plan.plan.rules.length >= 4)
    assert.ok(result.analysis.debt.debtMin > 0)
  })
})

test('tools: health_query and health_manage round-trip an update and a delete', async () => {
  await withPlugin({}, async ({ tools }) => {
    const created = await tools.get('health_record').execute({
      kind: 'weight',
      value: { kg: 70 },
      date: '2026-03-10'
    })
    const id = created.record.id

    const queried = await tools.get('health_query').execute({ from: '2026-03-01', to: '2026-03-31' })
    assert.equal(queried.total, 1)
    assert.equal(queried.records[0].id, id)
    assert.equal(queried.records[0].summary, '70 kg')

    const updated = await tools.get('health_manage').execute({ action: 'update', id, value: { kg: 69.2 } })
    assert.equal(updated.record.value.kg, 69.2)
    assert.equal(updated.summary, '69.2 kg')

    const deleted = await tools.get('health_manage').execute({ action: 'delete', id })
    assert.equal(deleted.ok, true)
    const after = await tools.get('health_query').execute({ from: '2026-03-01', to: '2026-03-31' })
    assert.equal(after.total, 0)
  })
})

test('tools: health_profile refuses a credential-looking field', async () => {
  await withPlugin({}, async ({ tools }) => {
    await assert.rejects(
      async () => tools.get('health_profile').execute({ action: 'update', patch: { idCardNumber: '1234' } }),
      /not for credentials/
    )
    // The guard also fires on the Chinese field name a user would actually type.
    await assert.rejects(
      async () => tools.get('health_profile').execute({ action: 'update', patch: { '\u8eab\u4efd\u8bc1\u53f7': '1234' } }),
      /not for credentials/
    )
  })
})

test('tools: health_overview orients without any data present', async () => {
  await withPlugin({}, async ({ tools }) => {
    const result = await tools.get('health_overview').execute({ days: 30 })
    assert.equal(result.ok, true)
    assert.equal(result.hasProfile, false)
    assert.equal(result.sleep.nightsRecorded, 0)
    assert.equal(typeof result.today, 'string')
  })
})

// -------------------------------------------------------------- provenance ---

test('provenance: a record carries a source label the panel can show', async () => {
  await withPlugin({}, async ({ tools }) => {
    const user = await tools.get('health_record').execute({
      kind: 'weight', value: { kg: 70 }, date: '2026-03-10', source: 'user'
    })
    // The user's own report needs no badge: no label, not a sample.
    assert.equal(user.record.source, 'user')
    assert.equal(user.record.sample, false)

    const sample = await tools.get('health_record').execute({
      kind: 'weight', value: { kg: 71 }, date: '2026-03-11', source: 'sample'
    })
    assert.equal(sample.record.source, 'sample')
    assert.equal(sample.record.sample, true, 'a sample record must be identifiable as one')
  })
})

test('provenance: a bad source value is refused at the tool boundary', async () => {
  await withPlugin({}, async ({ tools }) => {
    // The parameter schema enforces the vocabulary, so the model gets a
    // pointed error instead of a silently stored nonsense provenance.
    await assert.rejects(
      async () => tools.get('health_record').execute({
        kind: 'weight', value: { kg: 70 }, date: '2026-03-10', source: 'made-up'
      }),
      /"source" must be one of/
    )
  })
})

test('provenance: the service adds the label and sample flag it promises', async () => {
  await withPlugin({}, async ({ routes }) => {
    await callRoute(routes, 'POST', `${ROUTE_PREFIX}/record`, {
      body: { kind: 'weight', value: { kg: 70 }, date: '2026-03-10', source: 'sample' }
    })
    const listed = (await callRoute(routes, 'GET', `${ROUTE_PREFIX}/records`, {
      query: { from: '2026-03-01', to: '2026-03-31' }
    })).json()
    assert.equal(listed.records[0].sourceLabel, '示例数据')
    assert.equal(listed.records[0].sample, true)
  })
})

test('provenance: sample data can be cleared in one action and real data survives', async () => {
  await withPlugin({}, async ({ tools, routes }) => {
    await tools.get('health_record').execute({ kind: 'weight', value: { kg: 70 }, date: '2026-03-10', source: 'user' })
    await tools.get('health_record').execute({ kind: 'weight', value: { kg: 71 }, date: '2026-03-11', source: 'sample' })
    await tools.get('sleep_log').execute({
      date: '2026-03-12', bedtime: '23:00', out_of_bed: '07:00', source: 'sample'
    })

    const before = await callRoute(routes, 'GET', `${ROUTE_PREFIX}/records`, {
      // An explicit window, because the default is the trailing 30 days and
      // these fixtures must not depend on when the suite runs.
      query: { from: '2026-03-01', to: '2026-03-31' }
    })
    assert.equal(before.status, 200, `records failed: ${before.body}`)
    const beforePayload = before.json()
    assert.equal(beforePayload.total, 3, `unexpected payload: ${before.body.slice(0, 300)}`)
    assert.equal(beforePayload.records.filter((record) => record.sample).length, 2)

    // No body: the route takes no input, and sending `{}` would be rejected by
    // the same `body.kind is required` guard a malformed write hits.
    const cleared = (await callRoute(routes, 'POST', `${ROUTE_PREFIX}/clear-samples`)).json()
    assert.equal(cleared.ok, true)
    assert.equal(cleared.removed, 2)

    const after = (await callRoute(routes, 'GET', `${ROUTE_PREFIX}/records`, {
      query: { from: '2026-03-01', to: '2026-03-31' }
    })).json()
    assert.equal(after.total, 1, 'the real record must survive')
    assert.equal(after.records[0].source, 'user')
  })
})

// -------------------------------------------------------------- /health ----

test('/health: a bare command toggles the mode and reports the new state', async () => {
  await withPlugin({}, async ({ commands }) => {
    const health = commands.get('health')
    const agent = {}

    assert.equal(isHealthMode(agent), false, 'mode starts off')

    const on = await health.handler({ agent, rawInput: '' })
    assert.equal(on.kind, 'success')
    assert.match(on.text, /已开启/)
    assert.equal(isHealthMode(agent), true)

    const off = await health.handler({ agent, rawInput: '' })
    assert.match(off.text, /已关闭/)
    assert.equal(isHealthMode(agent), false)
  })
})

test('/health: on, off and status are accepted', async () => {
  await withPlugin({}, async ({ commands }) => {
    const health = commands.get('health')
    const agent = {}

    assert.match((await health.handler({ agent, rawInput: 'on' })).text, /已开启/)
    assert.equal(isHealthMode(agent), true)
    assert.match((await health.handler({ agent, rawInput: 'on' })).text, /已开启/, 'on is idempotent')
    assert.match((await health.handler({ agent, rawInput: 'status' })).text, /已开启/, 'status does not change state')
    assert.equal(isHealthMode(agent), true)
    assert.match((await health.handler({ agent, rawInput: 'off' })).text, /已关闭/)
    assert.equal(isHealthMode(agent), false)
  })
})

test('/health: an unrecognized word is the user\'s message, not an error', async () => {
  // The first version returned `无法识别` and the sentence never reached the
  // model, because a command line is consumed whole. This is that regression.
  await withPlugin({}, async ({ commands }) => {
    const health = commands.get('health')
    const injected = []
    const agent = { inject: (message) => injected.push(message) }
    plugin.setUserMessageFactoryForTest((text) => ({ role: 'user', content: [{ type: 'text', text }] }))

    try {
      const result = await health.handler({ agent, rawInput: '我昨天睡眠很差，十二点上床，三点多睡着' })
      assert.equal(result.kind, 'success')
      assert.match(result.text, /已开启/)
      assert.deepEqual(injected, [{
        role: 'user',
        content: [{ type: 'text', text: '我昨天睡眠很差，十二点上床，三点多睡着' }]
      }], 'inject must receive a message object, not a bare string')
      assert.equal(isHealthMode(agent), true, 'asking the assistant switches the mode on')
    } finally {
      plugin.setUserMessageFactoryForTest(undefined)
    }
  })
})

test('/health: a subcommand with trailing text sends the text and applies the action', async () => {
  await withPlugin({}, async ({ commands }) => {
    const health = commands.get('health')
    const injected = []
    const agent = { inject: (message) => injected.push(message.content[0].text) }
    plugin.setUserMessageFactoryForTest((text) => ({ role: 'user', content: [{ type: 'text', text }] }))

    try {
      await health.handler({ agent, rawInput: 'on 帮我看看昨晚的数据' })
      assert.deepEqual(injected, ['帮我看看昨晚的数据'])
      assert.equal(isHealthMode(agent), true)

      await health.handler({ agent, rawInput: 'off 先不聊了' })
      assert.deepEqual(injected, ['帮我看看昨晚的数据', '先不聊了'])
      assert.equal(isHealthMode(agent), false)
    } finally {
      plugin.setUserMessageFactoryForTest(undefined)
    }
  })
})

test('/health: when injection is unavailable the user is told to resend', async () => {
  await withPlugin({}, async ({ commands }) => {
    const health = commands.get('health')
    plugin.setUserMessageFactoryForTest(null)
    try {
      const result = await health.handler({ agent: {}, rawInput: '你好' })
      assert.equal(result.kind, 'success')
      assert.match(result.text, /没有被交给助手/)
      assert.match(result.text, /再发一次/)
      assert.equal(isHealthMode({}), false, 'the probe agent is untouched by another agent\'s call')
    } finally {
      plugin.setUserMessageFactoryForTest(undefined)
    }
  })
})

test('/health: parseHealthInput maps every shape', () => {
  assert.deepEqual(plugin.parseHealthInput(''), { action: 'toggle' })
  assert.deepEqual(plugin.parseHealthInput('on'), { action: 'on' })
  assert.deepEqual(plugin.parseHealthInput('OFF'), { action: 'off' })
  assert.deepEqual(plugin.parseHealthInput('status'), { action: 'status' })
  assert.deepEqual(plugin.parseHealthInput('我睡得很差'), { action: 'on', message: '我睡得很差' })
  assert.deepEqual(plugin.parseHealthInput('on 看看'), { action: 'on', message: '看看' })
  assert.deepEqual(plugin.parseHealthInput('off 先不聊了'), { action: 'off', message: '先不聊了' })
  assert.deepEqual(plugin.parseHealthInput('status 现在几点'), { action: 'status', message: '现在几点' })
  assert.deepEqual(plugin.parseHealthInput('stat'), { action: 'on', message: 'stat' },
    'an unknown word is a message, not a failed subcommand')
  // The first token after on/off must not be mistaken for the command itself:
  // "on" here belongs to the sentence.
  assert.deepEqual(plugin.parseHealthInput('on on 我昨天没睡好'),
    { action: 'on', message: 'on 我昨天没睡好' })
})

test('/health: the mode is per agent, not global', async () => {
  await withPlugin({}, async ({ commands }) => {
    const health = commands.get('health')
    const mine = {}
    const theirs = {}
    await health.handler({ agent: mine, rawInput: 'on' })
    assert.equal(isHealthMode(mine), true)
    assert.equal(isHealthMode(theirs), false)
  })
})

// ------------------------------------------------------------ medications ---

test('medications: registering a regimen attaches the written drug notes', async () => {
  await withPlugin({}, async ({ tools }) => {
    const saved = await tools.get('medication_regimen').execute({
      action: 'save',
      name: '异维A酸',
      dose: '10mg',
      units_per_dose: 2,
      formulation: 'softgel',
      frequency: 'twice_daily',
      times: ['08:00', '20:00'],
      with_food: 'must',
      start_date: '2026-10-01'
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.medication.frequency, 'twice_daily')
    assert.deepEqual(saved.medication.times, ['08:00', '20:00'])
    assert.equal(saved.medication.unitsPerDose, 2)
    assert.equal(saved.medication.id, '异维a酸')

    // The notes are the sanctioned source for restrictions, so they must arrive
    // with the registration rather than being recalled later.
    assert.equal(saved.notes.known, true)
    const drug = saved.notes.drugs[0]
    assert.equal(drug.name, '异维A酸')
    assert.ok(drug.restrictions.some((entry) => entry.id === 'alcohol'))
    assert.ok(drug.restrictions.some((entry) => entry.id === 'pregnancy'))
    assert.ok(drug.supportiveCare.some((entry) => entry.id === 'hydrate'))
    assert.ok(drug.monitoring.some((entry) => entry.id === 'lipids'))
    assert.ok(drug.redFlags.some((entry) => entry.id === 'mood'))

    // The reminder preview must repeat the essentials, with the food rule first.
    assert.ok(saved.essentials.some((line) => line.includes('随餐')))
    assert.ok(saved.essentials.some((line) => line.includes('不喝酒')))
    assert.ok(saved.essentials.some((line) => line.includes('补水')))
  })
})

test('medications: registering returns a ready-to-use reminder plan', async () => {
  // A regimen without a reminder is a plan that never fires, and the schedule
  // service only exists in a health-mode session, so the plan is returned here.
  await withPlugin({}, async ({ tools }) => {
    const saved = await tools.get('medication_regimen').execute({
      action: 'save',
      name: '异维A酸',
      dose: '10mg',
      units_per_dose: 1,
      frequency: 'twice_daily',
      times: ['08:00', '20:00'],
      with_food: 'must'
    })
    assert.equal(saved.reminders.needed, true)
    assert.equal(saved.reminders.rule, 'daily')
    assert.equal(saved.reminders.entries.length, 2)
    assert.deepEqual(saved.reminders.entries.map((entry) => entry.time), ['08:00', '20:00'])
    // The instructions must tell the caller not to guess the time zone.
    assert.match(saved.reminders.instructions, /time-context/)

    const morning = saved.reminders.entries[0]
    assert.match(morning.title, /08:00/)
    assert.match(morning.title, /异维A酸/)
    assert.match(morning.prompt, /随餐/)
    assert.match(morning.prompt, /不喝酒/)
    // A skipped dose must not turn into pressure to double up.
    assert.match(morning.prompt, /不要催促/)

    // And the same plan is visible when the list is read back.
    const listed = await tools.get('medication_regimen').execute({ action: 'list' })
    assert.equal(listed.medications[0].reminders.entries.length, 2)
  })
})

test('medications: a regimen without times reports that no reminder is possible', async () => {
  await withPlugin({}, async ({ tools }) => {
    const saved = await tools.get('medication_regimen').execute({
      action: 'save', name: '维生素D', frequency: 'as_needed'
    })
    assert.equal(saved.reminders.needed, false)
    assert.match(saved.reminders.reason, /没有登记服药时间/)
  })
})

test('medications: a daily frequency without times is refused', async () => {
  await withPlugin({}, async ({ tools }) => {
    // Without times no reminder can be scheduled, so silently accepting this
    // would produce a regimen that never fires.
    await assert.rejects(
      async () => tools.get('medication_regimen').execute({
        action: 'save', name: '异维A酸', frequency: 'twice_daily'
      }),
      /needs times/
    )
    await assert.rejects(
      async () => tools.get('medication_regimen').execute({
        action: 'save', name: '异维A酸', frequency: 'twice_daily', times: ['08:00']
      }),
      /expects 2 time/
    )
    await assert.rejects(
      async () => tools.get('medication_regimen').execute({
        action: 'save', name: '异维A酸', frequency: 'twice_daily', times: ['8am', '8pm']
      }),
      /HH:MM/
    )
  })
})

test('medications: the regimen list and removal round-trip through disk', async () => {
  await withPlugin({}, async ({ tools, dir }) => {
    await tools.get('medication_regimen').execute({
      action: 'save', name: '异维A酸', frequency: 'twice_daily', times: ['08:00', '20:00'], with_food: 'must'
    })
    await tools.get('medication_regimen').execute({
      action: 'save', name: '多西环素', frequency: 'once_daily', times: ['09:00']
    })

    const listed = await tools.get('medication_regimen').execute({ action: 'list' })
    assert.equal(listed.count, 2)
    assert.equal(listed.activeCount, 2)
    assert.ok(listed.medications.every((entry) => entry.essentials.length > 0))

    // It is a plain file the user can read.
    const raw = await readFile(join(dir, 'medications.json'), 'utf8')
    assert.match(raw, /异维A酸/)

    const removed = await tools.get('medication_regimen').execute({ action: 'remove', id: '异维a酸' })
    assert.equal(removed.ok, true)
    const after = await tools.get('medication_regimen').execute({ action: 'list' })
    assert.equal(after.count, 1)
    assert.equal(after.medications[0].name, '多西环素')
  })
})

test('drug_notes: a curated drug answers from the notes and never needs the web', async () => {
  await withPlugin({}, async ({ tools }) => {
    const known = await tools.get('drug_notes').execute({ name: 'isotretinoin 20mg' })
    assert.equal(known.known, true, 'the English name must match the same entry')
    assert.equal(known.drugs[0].name, '异维A酸')
    // auto mode with a covered drug must not spend a network round trip.
    assert.equal(known.web, undefined, 'a curated drug must not trigger a lookup')
  })
})

test('drug_notes: an uncovered drug is looked up on the web, quoted and cited', async () => {
  // The point of the web path: the plugin cannot enumerate every drug, so an
  // unknown name must produce cited passages rather than "I do not know".
  const searched = []
  const fetched = []
  const web = {
    async search(request) {
      searched.push(request.query)
      return {
        sources: [
          { url: 'https://www.drugs.com/npp/melatonin.html', title: 'Melatonin', snippet: 'timing and dose' },
          { url: 'https://pubmed.ncbi.nlm.nih.gov/12345/', title: 'Melatonin meta-analysis' }
        ],
        truncated: false
      }
    },
    async fetch(request) {
      fetched.push(request.url)
      return {
        url: request.url,
        statusCode: 200,
        truncated: false,
        body: {
          kind: 'html',
          content: '<p>Melatonin is usually taken 30 to 60 minutes before bedtime. '
            + 'Alcohol and caffeine may affect melatonin clearance and should be avoided in the evening.</p>'
            + '<p>Melatonin may interact with fluvoxamine, which raises melatonin levels substantially.</p>'
        }
      }
    }
  }

  await withPlugin({}, async ({ tools, service }) => {
    // The stub is installed through the service the tools hold, because the
    // plugin resolves ctx.web at apply time.
    service.web = web
    // A drug the curated notes genuinely do not cover. Using a covered one here
    // would silently stop exercising the web path the moment it was added.
    const result = await tools.get('drug_notes').execute({ name: '曲唑酮' })
    assert.equal(result.known, false, 'the curated notes do not cover this drug')
    assert.ok(result.web, 'a web section must be present')
    assert.equal(result.web.performed, true)
    assert.ok(searched.length > 0, 'at least one query must run')
    assert.ok(searched.some((query) => query.includes('曲唑酮')), `queries: ${searched.join(' | ')}`)
    assert.ok(fetched.length > 0, 'at least one page must be read')
    assert.ok(result.web.sources.length > 0)
    assert.ok(result.web.passages.length > 0, 'passages must come back')
    assert.equal(result.web.useful, true)
    for (const passage of result.web.passages) {
      assert.equal(typeof passage.url, 'string', 'every passage must carry its source')
      assert.ok(passage.text.length > 20)
    }
    assert.match(result.web.note, /原文摘录/)
    assert.match(result.web.note, /说明书/)
  })
})

test('drug_notes: a curated drug answers locally even when a web service exists', async () => {
  // Melatonin now has written notes, so the web path must not run for it: a
  // curated answer is reviewed, and spending a network round trip would be a
  // downgrade.
  let searched = 0
  const web = {
    async search() { searched++; return { sources: [], truncated: false } },
    async fetch() { searched++; throw new Error('should not be reached') }
  }
  await withPlugin({}, async ({ tools, service }) => {
    service.web = web
    const result = await tools.get('drug_notes').execute({ name: '褪黑素' })
    assert.equal(result.known, true)
    assert.equal(result.drugs[0].name, '褪黑素')
    assert.equal(result.web, undefined, 'curated notes must answer without a lookup')
    assert.equal(searched, 0)
    // The curated entry must carry the fields the panel renders.
    const drug = result.drugs[0]
    assert.ok(drug.restrictions.some((entry) => entry.id === 'depression'))
    assert.ok(drug.restrictions.some((entry) => entry.id === 'warfarin'))
    assert.ok(drug.sideEffects.length > 0)
    assert.ok(drug.monitoring.length > 0)
    assert.ok(drug.redFlags.length > 0)
    assert.ok(Array.isArray(drug.references) && drug.references.length > 0,
      'a curated entry must link to where its facts come from')
  })
})

test('drug_notes: focus narrows the query, and source=notes skips the web', async () => {
  const searched = []
  const web = {
    async search(request) {
      searched.push(request.query)
      return { sources: [], truncated: false }
    },
    async fetch() { throw new Error('nothing to fetch') }
  }
  await withPlugin({}, async ({ tools, service }) => {
    service.web = web
    await tools.get('drug_notes').execute({ name: '曲唑酮', focus: 'timing' })
    assert.ok(searched.some((query) => /timing|睡前|时机|服用时间|before/i.test(query)),
      `a focused query should mention the facet: ${searched.join(' | ')}`)

    const notesOnly = await tools.get('drug_notes').execute({ name: '曲唑酮', source: 'notes' })
    assert.equal(notesOnly.web, undefined, 'source=notes must not touch the network')
  })
})

test('drug_notes: a failed search is reported instead of silently pretending', async () => {
  const web = {
    async search() { throw new Error('provider offline') },
    async fetch() { throw new Error('unreachable') }
  }
  await withPlugin({}, async ({ tools, service }) => {
    service.web = web
    const result = await tools.get('drug_notes').execute({ name: '曲唑酮' })
    assert.equal(result.web.failed, true)
    assert.match(result.web.reason, /provider offline/)
    assert.match(result.web.note, /检索失败/)
  })
})

test('drug_notes: sources but no extractable passage hands over links, not a dead end', async () => {
  const web = {
    async search() {
      return {
        sources: [{ url: 'https://www.ema.europa.eu/en/documents/x_en.pdf', title: 'EMA PDF' }],
        truncated: false
      }
    },
    // A PDF arriving as binary junk: reachable, unreadable.
    async fetch(request) {
      return { url: request.url, statusCode: 200, truncated: false, body: { kind: 'text', content: '%PDF-1.7 …' } }
    }
  }
  await withPlugin({}, async ({ tools, service }) => {
    service.web = web
    const result = await tools.get('drug_notes').execute({ name: '曲唑酮' })
    assert.equal(result.web.useful, false)
    assert.ok(result.web.sources.length > 0, 'the links must survive')
    assert.match(result.web.note, /没有提取到可引用的原文段落/)
    assert.match(result.web.note, /自行打开核对/)
  })
})

test('drug_notes: without a web service the reply says so and points at the label', async () => {
  await withPlugin({}, async ({ tools }) => {
    const result = await tools.get('drug_notes').execute({ name: '曲唑酮' })
    assert.equal(result.known, false)
    assert.equal(result.webUnavailable, true)
    assert.match(result.webNote, /说明书/)
  })
})

test('medication_taken: adherence and side effects are recorded against the user', async () => {
  await withPlugin({}, async ({ tools }) => {
    const taken = await tools.get('medication_taken').execute({
      name: '异维A酸', dose: '10mg', date: '2026-10-05', at: '08:10', side_effects: '嘴唇干裂'
    })
    assert.equal(taken.ok, true)
    assert.equal(taken.record.kind, 'medication')
    assert.equal(taken.record.value.adherence, 'taken')
    assert.equal(taken.record.value.sideEffects, '嘴唇干裂')
    assert.equal(taken.record.clock, '08:10')
    assert.equal(taken.record.source, 'user')

    const skipped = await tools.get('medication_taken').execute({
      name: '异维A酸', date: '2026-10-06', skipped: true
    })
    assert.equal(skipped.record.value.adherence, 'skipped')

    const queried = await tools.get('health_query').execute({
      kinds: ['medication'], from: '2026-10-01', to: '2026-10-31'
    })
    assert.equal(queried.total, 2)
    assert.ok(queried.records.some((record) => record.summary.includes('skipped')
      || record.summary.includes('异维A酸')))
  })
})

test('routes: the medication routes serve the panel', async () => {
  await withPlugin({}, async ({ routes }) => {
    const saved = (await callRoute(routes, 'POST', `${ROUTE_PREFIX}/medication`, {
      body: { name: '异维A酸', frequency: 'twice_daily', times: ['08:00', '20:00'], withFood: 'must' }
    })).json()
    assert.equal(saved.ok, true)

    const listed = (await callRoute(routes, 'GET', `${ROUTE_PREFIX}/medications`)).json()
    assert.equal(listed.count, 1)

    const notes = (await callRoute(routes, 'GET', `${ROUTE_PREFIX}/drug`, { query: { name: '异维A酸' } })).json()
    assert.equal(notes.known, true)

    const catalog = (await callRoute(routes, 'GET', `${ROUTE_PREFIX}/drug-catalog`)).json()
    assert.ok(catalog.drugs.some((entry) => entry.id === 'isotretinoin'))
    assert.ok(catalog.frequencies.includes('twice_daily'))

    const removed = (await callRoute(routes, 'POST', `${ROUTE_PREFIX}/medication/delete`, {
      body: { id: saved.medication.id }
    })).json()
    assert.equal(removed.ok, true)
  })
})

test('routes: an invalid regimen answers 400 with the reason', async () => {
  await withPlugin({}, async ({ routes }) => {
    const response = await callRoute(routes, 'POST', `${ROUTE_PREFIX}/medication`, {
      body: { name: '异维A酸', frequency: 'twice_daily' }
    })
    assert.equal(response.status, 400)
    assert.match(response.json().error, /needs times/)
  })
})

// ----------------------------------------------------------- route paths ----

test('routes: status reports the layout before anything is written', async () => {
  await withPlugin({}, async ({ routes, dir }) => {
    const response = await callRoute(routes, 'GET', `${ROUTE_PREFIX}/status`)
    assert.equal(response.status, 200)
    const payload = response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.hasProfile, false)
    assert.equal(payload.paths.root, dir)
    assert.equal(payload.recordsThisYear, 0)
  })
})

test('routes: record then dashboard reflects the new night', async () => {
  await withPlugin({}, async ({ routes }) => {
    const created = await callRoute(routes, 'POST', `${ROUTE_PREFIX}/sleep-log`, {
      body: { date: '2026-03-10', bedtime: '23:00', out_of_bed: '07:00', sleep_onset_min: 20, waso_min: 20 }
    })
    assert.equal(created.status, 200)
    assert.equal(created.json().ok, true)

    const dashboard = await callRoute(routes, 'GET', `${ROUTE_PREFIX}/dashboard`, {
      query: { days: 7, to: '2026-03-10' }
    })
    const payload = dashboard.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.today, '2026-03-10')
    // 23:00 -> 07:00 in bed (480) minus 20 latency and 20 WASO.
    assert.equal(payload.lastNight.tstMin, 440)
    assert.equal(payload.todayRecords.length, 1)
  })
})

test('routes: the dashboard answers with and without a query string', async () => {
  await withPlugin({}, async ({ routes }) => {
    // The panel calls `/dsh-health/dashboard?days=30`; this proves the exact
    // route matches whether or not a query string is present.
    const withQuery = await callRoute(routes, 'GET', `${ROUTE_PREFIX}/dashboard`, { query: { days: 30 } })
    assert.equal(withQuery.status, 200)
    assert.equal(withQuery.json().ok, true)
    const without = await callRoute(routes, 'GET', `${ROUTE_PREFIX}/dashboard`)
    assert.equal(without.status, 200)
    assert.equal(without.json().ok, true)
  })
})

test('routes: a rejected value answers 400 with the reason, not a 500', async () => {
  await withPlugin({}, async ({ routes }) => {
    const response = await callRoute(routes, 'POST', `${ROUTE_PREFIX}/record`, {
      body: { kind: 'heart_rate', value: { bpm: 9999 } }
    })
    assert.equal(response.status, 400)
    const payload = response.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.code, 'HEALTH_INVALID_RECORD')
    assert.match(payload.error, /plausible maximum/)
  })
})

test('routes: the value envelope and flat fields both store a record', async () => {
  await withPlugin({}, async ({ routes }) => {
    const nested = await callRoute(routes, 'POST', `${ROUTE_PREFIX}/record`, {
      body: { kind: 'steps', value: { count: 9123 }, date: '2026-03-10' }
    })
    assert.equal(nested.json().record.value.count, 9123)

    const flat = await callRoute(routes, 'POST', `${ROUTE_PREFIX}/record`, {
      body: { kind: 'steps', count: 4500, date: '2026-03-11' }
    })
    assert.equal(flat.json().record.value.count, 4500)
  })
})

test('routes: an unknown metric kind is a 400 with the catalog in the message', async () => {
  await withPlugin({}, async ({ routes }) => {
    const response = await callRoute(routes, 'GET', `${ROUTE_PREFIX}/records`, { query: { kinds: 'telepathy' } })
    assert.equal(response.status, 400)
    assert.match(response.json().error, /unknown metric kind/)
  })
})

test('routes: malformed JSON is refused rather than crashing the host', async () => {
  await withPlugin({}, async ({ routes }) => {
    const bad = await startRoute(routes, 'POST', `${ROUTE_PREFIX}/record`, { rawBody: '{ nope' })
    assert.equal(bad.status, 400)
    assert.match(bad.json().error, /not valid JSON/)
  })
})

test('routes: a wrong method answers 405 with an allow header', async () => {
  await withPlugin({}, async ({ routes }) => {
    const response = await callRoute(routes, 'GET', `${ROUTE_PREFIX}/status`)
    assert.equal(response.status, 200)
    const wrong = await callRoute(routes, 'POST', `${ROUTE_PREFIX}/status`, { body: {} })
    assert.equal(wrong.status, 405)
    assert.equal(wrong.headers.allow, 'GET')
  })
})

test('routes: export returns the whole archive for backup', async () => {
  await withPlugin({}, async ({ routes }) => {
    await callRoute(routes, 'POST', `${ROUTE_PREFIX}/record`, {
      body: { kind: 'steps', value: { count: 9123 }, date: '2026-03-10' }
    })
    const response = await callRoute(routes, 'GET', `${ROUTE_PREFIX}/export`)
    const payload = response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.records.length, 1)
    assert.equal(payload.records[0].value.count, 9123)
    assert.ok(payload.exportedAt)
  })
})

test('routes: trends returns a point per day including empty days', async () => {
  await withPlugin({}, async ({ routes }) => {
    await callRoute(routes, 'POST', `${ROUTE_PREFIX}/sleep-log`, {
      body: { date: '2026-03-08', bedtime: '23:00', out_of_bed: '07:00', sleep_onset_min: 10, waso_min: 10 }
    })
    const response = await callRoute(routes, 'GET', `${ROUTE_PREFIX}/trends`, {
      query: { days: 3, to: '2026-03-10' }
    })
    const payload = response.json()
    assert.equal(payload.days.length, 3)
    assert.deepEqual(payload.days.map((day) => day.date), ['2026-03-08', '2026-03-09', '2026-03-10'])
    // 23:00 -> 07:00 in bed (480) minus 10 latency and 10 WASO.
    assert.equal(payload.days[0].sleepTstMin, 460)
    assert.equal(payload.days[1].sleepTstMin, null)
    assert.equal(payload.days[1].count, 0)
  })
})

test('routes: report renders markdown through HTTP', async () => {
  await withPlugin({}, async ({ routes }) => {
    await callRoute(routes, 'POST', `${ROUTE_PREFIX}/sleep-log`, {
      body: { date: '2026-03-08', bedtime: '23:00', out_of_bed: '07:00', sleep_onset_min: 10, waso_min: 10 }
    })
    const response = await callRoute(routes, 'GET', `${ROUTE_PREFIX}/report`, {
      query: { days: 7, to: '2026-03-10' }
    })
    const payload = response.json()
    assert.equal(payload.ok, true)
    assert.match(payload.markdown, /# \u5065\u5eb7\u62a5\u544a/)
    assert.match(payload.markdown, /## \u7761\u7720/)
  })
})

test('routes: the catalog lists every supported kind', async () => {
  await withPlugin({}, async ({ routes }) => {
    const payload = (await callRoute(routes, 'GET', `${ROUTE_PREFIX}/catalog`)).json()
    assert.equal(payload.ok, true)
    assert.ok(payload.kinds.includes('sleep'))
    assert.equal(payload.metrics.sleep.label, '\u7761\u7720')
    assert.equal(payload.metrics.sleep.section, 'sleep')
  })
})

test('routes: profile read and update share one path with two verbs', async () => {
  await withPlugin({}, async ({ routes }) => {
    const before = (await callRoute(routes, 'GET', `${ROUTE_PREFIX}/profile`)).json()
    assert.equal(before.profile, null)

    const updated = (await callRoute(routes, 'POST', `${ROUTE_PREFIX}/profile`, {
      body: { birthYear: 1996, heightCm: 175, targetWake: '06:40' }
    })).json()
    assert.equal(updated.ok, true)
    assert.equal(updated.profile.targetWake, '06:40')

    const after = (await callRoute(routes, 'GET', `${ROUTE_PREFIX}/profile`)).json()
    assert.equal(after.profile.heightCm, 175)
    assert.equal(after.age, new Date().getFullYear() - 1996)
  })
})

test('routes: deleting through the panel removes the row from disk', async () => {
  await withPlugin({}, async ({ routes, dir }) => {
    const created = (await callRoute(routes, 'POST', `${ROUTE_PREFIX}/record`, {
      body: { kind: 'mood', value: { mood: '\u5e73\u9759', score: 4 }, date: '2026-03-10' }
    })).json()
    const id = created.record.id
    const removed = (await callRoute(routes, 'POST', `${ROUTE_PREFIX}/delete`, { body: { id } })).json()
    assert.equal(removed.ok, true)
    const raw = await readFile(join(dir, 'records', '2026.jsonl'), 'utf8')
    assert.equal(raw.trim(), '')
  })
})
