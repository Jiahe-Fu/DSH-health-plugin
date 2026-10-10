// Validate every preset child row's config against that package's own Config
// schema, using the schemastery the Harness itself uses.
//
// Why this exists: a preset whose child rejects its config fails *activation*,
// not boot. The row stays in the roster marked broken, so the user only finds
// out by selecting the mode and watching it not work. Catching a bad config
// before a restart is worth far more than catching it after one.
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire as createRequireHere } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const profileDir = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE, '.dsh'), 'profiles', process.env.DSH_PROFILE ?? 'desktop')

const installRoot = dirname(process.execPath)
const dshRoots = [
  join(installRoot, 'resources', 'app.asar', 'dsh'),
  join(installRoot, 'resources', 'app.asar.unpacked', 'dsh'),
  join(installRoot, 'resources', 'dsh')
].filter((candidate) => existsSync(candidate))

const requireFromHere = createRequire(import.meta.url)
const yamlModule = requireFromHere(join(profileDir, 'package.json') + '/../package.json') && (() => {
  const r = createRequire(join(profileDir, 'package.json'))
  const m = r('js-yaml')
  return m.default ?? m
})()

const jsType = new yamlModule.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: (v) => ({ __js: v }) })
const schema = yamlModule.DEFAULT_SCHEMA.extend([jsType])

const rows = yamlModule.load(readFileSync(join(packageDir, 'cordis.patch.yml'), 'utf8'), { schema })
const preset = rows.flatMap((entry) => entry.insert ?? []).find((row) => row.id === 'preset-health')
if (preset === undefined) throw new Error('preset-health not found in the bundle patch')

console.log(`preset ${preset.config.id} (${preset.config.name}) — ${preset.config.plugins.length} child rows\n`)

// Load schemastery from the installation, the same copy the packages use.
const z = await (async () => {
  const resolved = requireFromHere.resolve('@deepseek-ai/schemastery', { paths: [...dshRoots, profileDir] })
  const mod = await import(pathToFileURL(resolved).href)
  return mod.default ?? mod
})()

let failures = 0
// Read this package's own name from its manifest so a rename cannot silently
// turn "validate my row" into "try to import a package that no longer exists".
const thisPackage = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).name
for (const row of preset.config.plugins) {
  const label = `${row.id} (${row.name})`
  if (row.name === thisPackage) {
    console.log(`SKIP ${label} — this package, validated by its own tests`)
    continue
  }
  let module
  try {
    const resolved = requireFromHere.resolve(row.name, { paths: [...dshRoots, profileDir] })
    module = await import(pathToFileURL(resolved).href)
  } catch (error) {
    failures++
    console.log(`FAIL ${label} — cannot import: ${error.message}`)
    continue
  }
  const Config = module.Config ?? module.default?.Config
  if (Config === undefined) {
    console.log(`OK   ${label} — no Config schema (accepts anything)`)
    continue
  }
  try {
    const normalized = Config(row.config ?? {})
    const given = Object.keys(row.config ?? {})
    const accepted = Object.keys(normalized ?? {})
    const ignored = given.filter((key) => !accepted.includes(key))
    if (ignored.length > 0) {
      failures++
      console.log(`FAIL ${label} — schema ignores field(s): ${ignored.join(', ')}; accepts: ${accepted.join(', ') || '(none)'}`)
    } else {
      console.log(`OK   ${label} — ${given.length} field(s) accepted${normalized?.disabled === undefined ? '' : ''}`)
    }
  } catch (error) {
    failures++
    console.log(`FAIL ${label} — schema rejected the config: ${error.message}`)
  }
}

console.log(`\n${failures === 0 ? 'ALL PRESET ROWS VALIDATE' : `${failures} PRESET ROW PROBLEM(S)`}`)
process.exit(failures === 0 ? 0 : 1)
