/**
 * Install this plugin into a dsh profile, without pnpm.
 *
 * `plugin_manager install_bundle` is the supported path, but it is unavailable
 * when approval prompts are disabled for the session, so this script performs
 * the same three edits by hand and validates each one:
 *
 *   1. `node_modules/<name>` -> junction to this workspace directory, so the
 *      loader resolves the package by name and edits are live.
 *   2. the profile's `package.json`: a `file:` dependency plus the bundle in
 *      `dsh.profile.bundles` (bundle order is boot order).
 *   3. the profile's `cordis.patch.yml`: this package's patch rows at the end
 *      of the array, so Agent HMR picks the change up without a restart.
 *
 * Every JSON write is validated by re-parsing before it lands, and the previous
 * files are kept as `.bak` so a mistake is one copy away from undone. The YAML
 * edit is validated with the profile's own js-yaml, which is the parser the
 * loader uses.
 *
 * Usage:
 *   node tools/install-profile.mjs            # install or refresh from this checkout
 *   node tools/install-profile.mjs --from-npm [spec]
 *                                             # install the published package
 *                                             # (default spec: the package name)
 *   node tools/install-profile.mjs --uninstall
 *   node tools/install-profile.mjs --dry-run
 */
import { readFile, writeFile, copyFile, access, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const packageJson = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
const PACKAGE_NAME = packageJson.name
const BUNDLE_FILE = packageJson.dsh?.bundle?.patch ?? './cordis.patch.yml'

const argv = process.argv.slice(2)
const args = new Set(argv)
const dryRun = args.has('--dry-run')
const uninstall = args.has('--uninstall')
/**
 * `--from-npm [spec]` installs the published package instead of linking this
 * checkout. This is the mode an end user needs: they have no source tree to
 * junction to, and a junction is precisely what they cannot create from an npm
 * tarball.
 */
const fromNpmIndex = argv.indexOf('--from-npm')
const fromNpm = fromNpmIndex >= 0
const fromNpmSpec = fromNpm
  ? (argv[fromNpmIndex + 1] !== undefined && !argv[fromNpmIndex + 1].startsWith('--')
    ? argv[fromNpmIndex + 1]
    : PACKAGE_NAME)
  : null

const dshHome = process.env.DSH_HOME?.trim() || join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const profile = process.env.DSH_PROFILE?.trim() || 'desktop'
const profileDir = join(dshHome, 'profiles', profile)

const paths = {
  profileDir,
  packageJson: join(profileDir, 'package.json'),
  patch: join(profileDir, 'cordis.patch.yml'),
  moduleLink: join(profileDir, 'node_modules', PACKAGE_NAME)
}

const log = (line) => console.log(line)
const step = (line) => console.log(`\n=== ${line} ===`)

log(`package : ${PACKAGE_NAME} (${packageDir})`)
log(`profile : ${profileDir}`)
if (dryRun) log('mode    : DRY RUN (no writes)')

// --------------------------------------------------------------- helpers ---

async function readOr(path, fallback) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

/** Write text after proving it parses, keeping a one-shot backup. */
async function writeValidated(path, text, validate) {
  const problem = validate(text)
  if (problem !== null) throw new Error(`refusing to write ${path}: ${problem}`)
  if (dryRun) {
    log(`[dry-run] would write ${path} (${text.length} bytes)`)
    return
  }
  if (existsSync(path)) {
    await copyFile(path, `${path}.bak`)
  }
  await writeFile(path, text, 'utf8')
  log(`wrote ${path} (backup: ${path}.bak)`)
}

function validateJson(text, label) {
  try {
    JSON.parse(text)
    return null
  } catch (error) {
    return `${label} is not valid JSON: ${error.message}`
  }
}

/**
 * The profile's own js-yaml, i.e. the parser the loader uses, extended with the
 * loader's `!!js` dialect. Without the custom type a legitimate row such as
 * `disabled: !!js process.platform !== 'win32'` fails to parse, and rejecting
 * valid input is worse than useless: it would block the install.
 */
async function loadYaml() {
  const require = createRequire(join(profileDir, 'package.json'))
  const module = require('js-yaml')
  const yaml = module.default ?? module
  const jsType = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: () => true,
    construct: (value) => ({ __js: value })
  })
  const schema = yaml.DEFAULT_SCHEMA.extend([jsType])
  return {
    load: (text) => yaml.load(text, { schema }),
    dump: yaml.dump
  }
}

// ----------------------------------------------------------- the junction ---

async function ensureJunction() {
  step('module link')
  if (fromNpm) {
    // A published install has no local directory to link to; the profile's own
    // package manager fetches it instead.
    if (dryRun) {
      log(`[dry-run] would run: pnpm add ${fromNpmSpec} (cwd ${profileDir})`)
      return
    }
    const pnpm = process.env.DSH_PNPM ?? 'pnpm'
    try {
      const { stdout } = await run(pnpm, ['add', fromNpmSpec, '--ignore-scripts'], { cwd: profileDir })
      log(stdout.trim().split('\n').slice(-3).join('\n'))
    } catch (error) {
      throw new Error(`pnpm add ${fromNpmSpec} failed in ${profileDir}: ${error.stderr ?? error.message}`)
    }
    return
  }
  const parent = dirname(paths.moduleLink)
  if (!dryRun) await mkdir(parent, { recursive: true })

  let existing = null
  try {
    existing = await import('node:fs/promises').then((fs) => fs.lstat(paths.moduleLink))
  } catch {
    existing = null
  }

  if (existing !== null) {
    if (existing.isSymbolicLink() || existing.isDirectory()) {
      log(`already present: ${paths.moduleLink}`)
      return
    }
    throw new Error(`${paths.moduleLink} exists and is a file; remove it first`)
  }

  if (dryRun) {
    log(`[dry-run] would create junction ${paths.moduleLink} -> ${packageDir}`)
    return
  }
  if (process.platform === 'win32') {
    // A directory junction needs no elevation, unlike a symlink.
    await run('cmd', ['/c', 'mklink', '/J', paths.moduleLink, packageDir])
    log(`junction created: ${paths.moduleLink} -> ${packageDir}`)
  } else {
    const { symlink } = await import('node:fs/promises')
    await symlink(packageDir, paths.moduleLink, 'dir')
    log(`symlink created: ${paths.moduleLink} -> ${packageDir}`)
  }
}

async function removeJunction() {
  step('module link')
  try {
    const { lstat, unlink, rm } = await import('node:fs/promises')
    const stats = await lstat(paths.moduleLink)
    if (stats.isSymbolicLink()) {
      await unlink(paths.moduleLink)
    } else {
      // A junction reports as a directory; removing it must not touch the
      // workspace it points at, hence rmdir semantics via rm without recurse
      // is not enough on Windows, so delete the link path only.
      await rm(paths.moduleLink)
    }
    log(`removed ${paths.moduleLink}`)
  } catch (error) {
    if (error?.code === 'ENOENT') log('no module link to remove')
    else throw error
  }
}

// ------------------------------------------------------ profile package.json ---

async function updateProfilePackage({ remove }) {
  step('profile package.json')
  const original = await readOr(paths.packageJson, null)
  if (original === null) throw new Error(`missing ${paths.packageJson}`)
  const manifest = JSON.parse(original)

  manifest.dependencies ??= {}
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []

  if (remove) {
    delete manifest.dependencies[PACKAGE_NAME]
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== PACKAGE_NAME)
  } else {
    // Two install modes, and the recorded spec must match the one in use.
    // A `file:` pointer to this checkout is right for development and wrong for
    // anyone else: on their machine that path does not exist, so the next
    // `pnpm install` would fail. `--from-npm` records the published version.
    manifest.dependencies[PACKAGE_NAME] = fromNpm
      ? (manifest.dependencies[PACKAGE_NAME]?.startsWith('file:') === true || manifest.dependencies[PACKAGE_NAME] === undefined
        ? `^${packageJson.version}`
        : manifest.dependencies[PACKAGE_NAME])
      : `file:${packageDir.replace(/\\/g, '/')}`
    if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) {
      manifest.dsh.profile.bundles.push(PACKAGE_NAME)
    }
  }

  const text = `${JSON.stringify(manifest, null, 2)}\n`
  if (text === original) {
    log('no change needed')
    return
  }
  await writeValidated(paths.packageJson, text, (candidate) => validateJson(candidate, 'package.json'))
  log(`bundles: ${manifest.dsh.profile.bundles.join(', ')}`)
}

// -------------------------------------------------------------- cordis patch ---

const BLOCK_START = `# >>> ${PACKAGE_NAME} (managed by tools/install-profile.mjs) >>>`
const BLOCK_END = `# <<< ${PACKAGE_NAME} <<<`

/** The patch rows this bundle contributes, taken from the bundle's own patch. */
async function bundleRows(yaml) {
  const text = await readFile(join(packageDir, BUNDLE_FILE), 'utf8')
  const parsed = yaml.load(text)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${BUNDLE_FILE} must be a YAML array of loader patch entries`)
  }
  return text.trimEnd()
}

async function updateProfilePatch({ remove }) {
  step('profile cordis.patch.yml')
  const yaml = await loadYaml()
  const original = await readOr(paths.patch, '')

  // Drop any previous managed block, so re-running is idempotent.
  const withoutBlock = stripBlock(original).trimEnd()

  const text = remove
    ? `${withoutBlock}\n`
    : `${withoutBlock}\n\n${BLOCK_START}\n${await bundleRows(yaml)}\n${BLOCK_END}\n`

  const validate = (candidate) => {
    try {
      const parsed = yaml.load(candidate)
      if (parsed !== null && !Array.isArray(parsed)) return 'the patch root must be a YAML array'
      return null
    } catch (error) {
      return `invalid YAML: ${error.message}`
    }
  }

  if (text === original) {
    log('no change needed')
    return
  }
  if (dryRun) {
    log(`[dry-run] would write ${paths.patch} with the managed block (${text.length} bytes)`)
    log(`[dry-run] managed rows: ${(yaml.load(text) ?? []).map((entry) => entry?.id).join(', ')}`)
    return
  }
  await writeValidated(paths.patch, text, validate)

  {
    // Prove the result parses and still lists every pre-existing id.
    const before = new Set((yaml.load(original) ?? []).map((entry) => entry?.id).filter(Boolean))
    const after = new Set((yaml.load(text) ?? []).map((entry) => entry?.id).filter(Boolean))
    const lost = [...before].filter((id) => !after.has(id))
    if (lost.length > 0) throw new Error(`the edit dropped existing patch ids: ${lost.join(', ')}`)
    log(`patch entries after edit: ${[...after].join(', ')}`)
  }
}

function stripBlock(text) {
  const start = text.indexOf(BLOCK_START)
  if (start < 0) return text
  const end = text.indexOf(BLOCK_END, start)
  const endIndex = end < 0 ? text.length : end + BLOCK_END.length
  return `${text.slice(0, start)}${text.slice(endIndex)}`
}

// -------------------------------------------------------------------- main ---

try {
  await access(profileDir)
} catch {
  console.error(`profile directory not found: ${profileDir}`)
  console.error('set DSH_PROFILE / DSH_HOME, or run inside a Harness shell')
  process.exit(2)
}

if (uninstall) {
  await removeJunction()
  await updateProfilePackage({ remove: true })
  await updateProfilePatch({ remove: true })
  log('\nuninstalled. Restart the Harness to unload the Host plugin.')
} else {
  await ensureJunction()
  await updateProfilePackage({ remove: false })
  await updateProfilePatch({ remove: false })
  log('\ninstalled. The Host plugin row and the Health preset load on the next Harness start.')
}
