/**
 * Resolve a DSH-bundled package from wherever this plugin happens to live.
 *
 * A profile plugin is installed under `$DSH_PROFILE_DIR/node_modules/<name>`,
 * which is a junction to the developer's workspace. Walking up from there
 * reaches the user's home directory, never the Harness installation, so a bare
 * `import '@deepseek-ai/dsh-tools'` fails with ERR_MODULE_NOT_FOUND and the
 * whole plugin refuses to load.
 *
 * The Harness itself ships those packages inside its own module root (in
 * Desktop, `resources/app.asar/dsh/node_modules`). The Host process can read
 * that archive — it is the same Electron binary — so we resolve explicitly
 * against the candidate roots, in order from most to least specific.
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromHere = createRequire(import.meta.url)

/** Module roots to try, in priority order. */
export function candidateModuleRoots() {
  const roots = []
  const seen = new Set()
  const push = (value) => {
    if (typeof value !== 'string' || value.trim().length === 0) return
    const clean = value.replace(/[\\/]+$/, '')
    if (seen.has(clean)) return
    seen.add(clean)
    roots.push(clean)
  }

  // 1. The environment the Harness exposes to plugin shells.
  push(process.env.DSH_RUNTIME_DIR)
  push(process.env.DSH_INSTALL_DIR)

  // 2. Everything above this file (works in a source checkout).
  push(join(here, '..', 'node_modules'))
  push(here)

  // 3. The running Electron/Node executable's own layout, when it is a Harness
  //    install: <root>/resources/app.asar/dsh  and  <root>/resources/dsh.
  const resources = resourcesDirFromExecPath(process.execPath)
  if (resources !== null) {
    push(join(resources, 'app.asar', 'dsh', 'node_modules'))
    push(join(resources, 'app.asar.unpacked', 'dsh', 'node_modules'))
    push(join(resources, 'dsh', 'node_modules'))
  }

  // 4. Same layout, but discovered from this file's own path in case the plugin
  //    was installed outside the profile.
  const fromHere = resourcesDirFromPath(here)
  if (fromHere !== null) {
    push(join(fromHere, 'app.asar', 'dsh', 'node_modules'))
  }

  return roots
}

/**
 * Load one DSH-bundled package.
 *
 * @param {string} specifier bare package name, e.g. `@deepseek-ai/dsh-tools`
 * @returns {Promise<any>} the module namespace
 */
export async function loadDshPackage(specifier) {
  const attempts = []

  // Normal resolution first: correct and fastest when it works.
  const direct = tryRequire(specifier)
  if (direct.ok) return normalize(await direct.value)
  attempts.push(`bare:${direct.code}`)

  for (const root of candidateModuleRoots()) {
    const resolved = tryResolve(specifier, root)
    if (!resolved.ok) {
      attempts.push(`${root}:${resolved.code}`)
      continue
    }
    if (/\.cjs$/.test(resolved.value) || resolved.value.includes(`${sep}node_modules${sep}`)) {
      const loaded = tryRequire(resolved.value)
      if (loaded.ok) return normalize(await loaded.value)
      attempts.push(`require(${resolved.value}):${loaded.code}`)
    }
    try {
      return normalize(await import(pathToFileURL(resolved.value).href))
    } catch (error) {
      attempts.push(`import(${resolved.value}):${error?.code ?? error?.message}`)
    }
  }

  throw new Error(
    `dsh-health: cannot resolve ${specifier}. The Harness installation could not be located. Tried: ${attempts.join(' | ')}`
  )
}

function tryResolve(specifier, root) {
  try {
    return { ok: true, value: requireFromHere.resolve(specifier, { paths: [root] }) }
  } catch (error) {
    return { ok: false, code: error?.code ?? String(error) }
  }
}

function tryRequire(target) {
  try {
    return { ok: true, value: Promise.resolve(requireFromHere(target)) }
  } catch (error) {
    return { ok: false, code: error?.code ?? String(error) }
  }
}

/** ESM namespaces are frozen; callers only read, so hand back a plain object. */
function normalize(module) {
  if (module !== null && typeof module === 'object' && module.__esModule === true) {
    return { ...module }
  }
  return module
}

/** `<install>/resources` for an executable path such as `.../DeepSeek Harness.exe`. */
function resourcesDirFromExecPath(execPath) {
  if (typeof execPath !== 'string') return null
  const dir = dirname(execPath)
  const resources = join(dir, 'resources')
  if (existsSync(resources)) return resources
  return null
}

/** Walk up from a path looking for a `resources` directory containing app.asar. */
function resourcesDirFromPath(start) {
  let current = start
  for (let depth = 0; depth < 8; depth++) {
    const resources = join(current, 'resources')
    if (existsSync(join(resources, 'app.asar'))) return resources
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}
