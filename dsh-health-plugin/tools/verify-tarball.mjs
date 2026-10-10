// Consumer-side smoke test: unpack the tarball the way npm would install it and
// load the plugin from THAT copy.
//
// Why this and not just a file listing: the file list proves what ships, not
// that it works. The interesting failure is a missing file that only shows up
// when something imports it — which a published package cannot fix without a
// new version.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const tarball = process.argv[2]
if (tarball === undefined) {
  console.error('usage: node tools/verify-tarball.mjs <path-to.tgz>')
  process.exit(2)
}

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const workDir = await mkdtemp(join(tmpdir(), 'dsh-health-consumer-'))
try {
  // `tar` ships with Windows 10+, so no extra dependency is needed to simulate
  // an install. npm's tarballs put everything under `package/`.
  execFileSync('tar', ['-xzf', tarball, '-C', workDir], { stdio: 'inherit' })
  const installed = join(workDir, 'package')
  check('tarball extracts to package/', existsSync(installed))

  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  check('name is the published name', manifest.name === 'dsh-health-plugin', manifest.name)
  check('no private flag on a publishable package', manifest.private !== true)
  check('licence declared', manifest.license === 'MIT', manifest.license)
  check('LICENSE file shipped', existsSync(join(installed, 'LICENSE')))
  check('main entry shipped', existsSync(join(installed, manifest.main ?? './index.js')))
  check('bundle patch shipped', existsSync(join(installed, 'cordis.patch.yml')))
  check('client half shipped', existsSync(join(installed, 'client.js')))

  // 1. The Host half must import from the installed copy and expose the loader
  //    contract, exactly as the Harness will call it.
  const plugin = await import(pathToFileURL(join(installed, 'index.js')).href)
  check('host half imports', typeof plugin.apply === 'function')
  check('exports name', plugin.name === manifest.name, plugin.name)
  check('exports inject array', Array.isArray(plugin.inject), plugin.inject?.join(','))
  check('inject lists only required services', plugin.inject?.includes('web') !== true)

  // 2. Every module the bundled files import must exist inside the tarball.
  const sources = ['index.js', 'client.js']
  const { readdir } = await import('node:fs/promises')
  for (const entry of await readdir(join(installed, 'src'))) {
    if (entry.endsWith('.js')) sources.push(join('src', entry))
  }
  const missing = []
  for (const file of sources) {
    const text = await readFile(join(installed, file), 'utf8')
    for (const match of text.matchAll(/from\s+'(\.\/[^']+|\.\.\/[^']+)'/g)) {
      const target = resolve(dirname(join(installed, file)), match[1])
      if (!existsSync(target)) missing.push(`${file} -> ${match[1]}`)
    }
  }
  check('every relative import resolves inside the package', missing.length === 0, missing.join('; ') || 'all resolve')

  // 3. The client half must register under the published id, which the loader
  //    checks against the package name.
  const clientSource = await readFile(join(installed, 'client.js'), 'utf8')
  const idMatch = clientSource.match(/__ModuleLoader__\.load\(\{[\s\S]{0,200}?id:\s*'([^']+)'/)
  check('client registers under the package name', idMatch?.[1] === manifest.name, idMatch?.[1] ?? 'no id found')

  // 4. The bundle patch must name this package, or a consumer's install
  //    declares a row that cannot be resolved.
  const patchText = await readFile(join(installed, 'cordis.patch.yml'), 'utf8')
  check('bundle patch names this package', patchText.includes(`'${manifest.name}'`), )
  check('bundle patch declares the preset', patchText.includes('preset-health'))

  // 5. No development-only material leaked into the artifact.
  for (const forbidden of ['tests', 'tools']) {
    check(`no ${forbidden}/ in the tarball`, !existsSync(join(installed, forbidden)))
  }
} catch (error) {
  check('consumer verification ran', false, error.message)
} finally {
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}

console.log(`\n${failures === 0 ? 'TARBALL VERIFIED — installable as published' : `${failures} PROBLEM(S) in the published artifact`}`)
process.exit(failures === 0 ? 0 : 1)
