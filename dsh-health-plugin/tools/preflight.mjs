/**
 * Pre-restart gate: load the plugin exactly as the Harness will, through the
 * profile-installed junction, and apply it. A failure here would take the whole
 * boot down, so this runs before any restart is requested.
 *
 * Run with the Harness binary so asar resolution is available:
 *   $env:ELECTRON_RUN_AS_NODE=1; & "<install>\DeepSeek Harness.exe" tools/preflight.mjs
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const profileDir = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh'), 'profiles', process.env.DSH_PROFILE ?? 'desktop')
// The package name is read from the manifest rather than written twice, so a
// rename cannot leave this gate checking the old one.
const manifestForName = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const PACKAGE_NAME = manifestForName.name
// The route prefix is a URL, not the package name, and stays as it has always
// been: the panel resolves it at runtime and nothing user-visible depends on it.
const ROUTE_PREFIX = '/dsh-health'
// The data directory keeps its original name on purpose. Renaming it with the
// package would orphan every health record already on disk.
const linked = join(profileDir, 'node_modules', PACKAGE_NAME)

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('=== 1. the profile link resolves to this workspace ===')
let linkedReal = null
try {
  const { realpath } = await import('node:fs/promises')
  linkedReal = await realpath(linked)
  check('junction resolves', true, linkedReal)
  check('points at this package', linkedReal.toLowerCase() === packageDir.toLowerCase(), linkedReal)
} catch (error) {
  check('junction resolves', false, error.message)
}

console.log('\n=== 2. the plugin loads through the linked path ===')
let plugin = null
try {
  plugin = await import(pathToFileURL(join(linked, 'index.js')).href)
  check('import index.js', true)
  check('exports apply', typeof plugin.apply === 'function')
  check('exports inject', Array.isArray(plugin.inject), plugin.inject?.join(','))
  // Every service the plugin touches must be declared, or the context refuses
  // the property access at runtime ("cannot get property X without inject").
  // Required services only. `web` is optional by design (see apply), because an
  // absent web provider must not stop the plugin from activating.
  check('declares every required service', ['tools', 'webServer', 'systemPrompt', 'skills', 'commands']
    .every((name) => plugin.inject?.includes(name)), plugin.inject?.join(','))
  check('does not hard-require the optional web service', plugin.inject?.includes('web') !== true,
    plugin.inject?.join(','))
  check('exports name', plugin.name === PACKAGE_NAME, plugin.name)
} catch (error) {
  check('import index.js', false, `${error.code ?? ''} ${error.message}`.trim())
}

console.log('\n=== 3. apply() registers a tool, a route and a preset row ===')
if (plugin !== null) {
  const dir = await mkdtemp(join(tmpdir(), 'health-preflight-'))
  const tools = new Map()
  const routes = []
  const skills = []
  const commands = new Map()
  const promptVariables = new Map()
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => undefined } },
    webServer: { register: (route) => { routes.push(route); return () => undefined } },
    systemPrompt: {
      section: () => () => undefined,
      variable: (name, provider) => { promptVariables.set(name, provider); return () => undefined }
    },
    commands: { register: (definition) => { commands.set(definition.name, definition); return () => undefined } },
    skills: { register: (skill) => { skills.push(skill); return () => undefined } },
    get: (name) => (name === 'skills' ? ctx.skills : undefined),
    effect: (fn) => { fn(); return () => undefined },
    logger: { info: () => undefined, debug: () => undefined }
  }
  try {
    plugin.apply(ctx, { dir })
    check('tools registered', tools.size === plugin.TOOL_NAMES.length, `${tools.size} tools`)
    check('tool name list matches the registry', [...plugin.TOOL_NAMES].every((name) => tools.has(name)),
      plugin.TOOL_NAMES.join(', '))
    // Keep this in step with ROUTE_PATHS: a route added without a test is how a
    // panel action silently 404s in production.
    check('routes registered', routes.length === plugin.ROUTE_PATHS.length, `${routes.length} routes`)
    check('unique route paths', new Set(routes.map((r) => r.path)).size === routes.length)
    check('no route under /api', routes.every((route) => !route.path.startsWith('/api/')),
      'the host owns the /api prefix')
    check('insomnia protocol skill registered', skills.length === 1, skills[0]?.name ?? 'none')
    check('/health command registered', commands.has('health'))
    check('health_mode prompt variable registered', typeof promptVariables.get('health_mode') === 'function')
    // Exercise one real write through the route layer.
    const sleepRoute = routes.find((route) => route.path === '/dsh-health/sleep-log')
    const { EventEmitter } = await import('node:events')
    const request = new EventEmitter()
    request.method = 'POST'
    request.url = '/dsh-health/sleep-log'
    request.destroy = () => undefined
    let settle
    const done = new Promise((r) => { settle = r })
    const response = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(text) { this.body = text ?? ''; settle() }
    }
    sleepRoute.handler(request, response)
    setTimeout(() => {
      request.emit('data', Buffer.from(JSON.stringify({
        date: '2026-03-10', bedtime: '23:00', out_of_bed: '07:00', sleep_onset_min: 20, waso_min: 20
      }), 'utf8'))
      request.emit('end')
    }, 0)
    await done
    const payload = JSON.parse(response.body)
    check('wrote a night through HTTP', response.status === 200 && payload.ok === true, `${response.status}`)
    check('derived TST is correct', payload.record?.value?.tstMin === 440, `${payload.record?.value?.tstMin}`)
    const file = await readFile(join(dir, 'records', '2026.jsonl'), 'utf8')
    check('landed on disk', file.includes('"kind":"sleep"'))
  } catch (error) {
    check('apply()', false, error.message)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log('\n=== 4. the inject helper resolves, so /health can deliver a sentence ===')
try {
  // A command line is consumed whole, so this is the only way text typed after
  // `/health` can reach the model. Knowing it before a restart beats finding
  // out from a "please resend" message afterwards.
  const ready = await plugin.primeUserMessageFactory()
  check('createUserMessage resolves', ready === true, ready ? 'ready' : 'UNAVAILABLE — /health will ask the user to resend')
} catch (error) {
  check('createUserMessage resolves', false, error.message)
}

console.log('\n=== 5. the bundle patch parses and declares the preset ===')
try {
  const { createRequire } = await import('node:module')
  const require = createRequire(join(profileDir, 'package.json'))
  const yamlModule = require('js-yaml')
  const yaml = yamlModule.default ?? yamlModule
  const jsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: (v) => ({ __js: v }) })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsType])

  const bundleText = await readFile(join(linked, 'cordis.patch.yml'), 'utf8')
  const bundleRows = yaml.load(bundleText, { schema })
  const ids = bundleRows.flatMap((entry) => (entry.insert ?? []).map((row) => row.id))
  check('bundle patch parses', true, ids.join(', '))
  const presetRow = bundleRows.flatMap((entry) => entry.insert ?? []).find((row) => row.id === 'preset-health')
  check('declares preset-health', presetRow !== undefined)
  check('preset id is health', presetRow?.config?.id === 'health')
  check('preset has a display name', typeof presetRow?.config?.name === 'string', presetRow?.config?.name)

  const pluginNames = (presetRow?.config?.plugins ?? []).map((row) => row.name)
  // The Harness ships these packages in its own module root. In Desktop that is
  // `resources/app.asar/dsh`, so try the plausible roots rather than one guess.
  const installRoot = dirname(process.execPath)
  const dshRoots = [
    join(installRoot, 'resources', 'app.asar', 'dsh'),
    join(installRoot, 'resources', 'app.asar.unpacked', 'dsh'),
    join(installRoot, 'resources', 'dsh')
  ].filter((candidate) => existsSync(candidate))
  check('found the Harness module root', dshRoots.length > 0, dshRoots.join(' | ') || 'none')

  for (const name of pluginNames) {
    if (name === PACKAGE_NAME) {
      check(`preset plugin ${name}`, true, 'this package')
      continue
    }
    try {
      require.resolve(`${name}/package.json`, { paths: [...dshRoots, profileDir, packageDir] })
      check(`preset plugin ${name}`, true)
    } catch {
      check(`preset plugin ${name}`, false, 'not resolvable — would break the preset')
    }
  }

  const profileText = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
  const profileRows = yaml.load(profileText, { schema })
  check('profile patch parses', Array.isArray(profileRows), `${profileRows.length} entries`)
  check('profile patch keeps original ids', profileRows.some((entry) => entry.id === 'agent-default-model'))
  const insertedIds = profileRows.flatMap((entry) => entry?.insert ?? []).map((row) => row.id)
  check('profile patch inserts the host row', insertedIds.includes(PACKAGE_NAME), insertedIds.join(', '))
  check('profile patch declares the preset', insertedIds.includes('preset-health'))

  // A preset child that rejects its own config fails ACTIVATION, not boot: the
  // row stays in the roster marked broken and the user only discovers it by
  // selecting the mode. Validating each child against its package schema here
  // is the difference between finding that now and finding it after a restart.
  const childProblems = await validatePresetChildren(presetRow, { dshRoots, profileDir, require })
  check('every preset child accepts its config', childProblems.length === 0,
    childProblems.length === 0 ? `${presetRow.config.plugins.length} rows` : childProblems.join('; '))

  const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  check('bundle is selected', (manifest.dsh?.profile?.bundles ?? []).includes(PACKAGE_NAME))
  check('dependency is recorded', typeof manifest.dependencies?.[PACKAGE_NAME] === 'string')
} catch (error) {
  check('patch inspection', false, error.message)
}

console.log(`\n${failures === 0 ? 'PREFLIGHT PASSED — safe to restart' : `PREFLIGHT FAILED (${failures} problem(s)) — do NOT restart`}`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Check each preset child row's config against that package's own Config
 * schema. Returns one message per problem.
 */
async function validatePresetChildren(presetRow, { dshRoots, profileDir, require: requireFromHere }) {
  const problems = []
  const { existsSync } = await import('node:fs')
  const { pathToFileURL } = await import('node:url')
  for (const row of presetRow.config.plugins ?? []) {
    if (row.name === PACKAGE_NAME) continue
    let module
    try {
      const resolved = requireFromHere.resolve(row.name, { paths: [...dshRoots, profileDir] })
      module = await import(pathToFileURL(resolved).href)
    } catch (error) {
      problems.push(`${row.id}: cannot import (${error.message})`)
      continue
    }
    const Config = module.Config ?? module.default?.Config
    if (Config === undefined) continue
    try {
      const normalized = Config(row.config ?? {})
      const ignored = Object.keys(row.config ?? {}).filter((key) => !Object.keys(normalized ?? {}).includes(key))
      if (ignored.length > 0) problems.push(`${row.id}: schema ignores ${ignored.join(', ')}`)
    } catch (error) {
      problems.push(`${row.id}: ${error.message}`)
    }
  }
  void existsSync
  return problems
}
