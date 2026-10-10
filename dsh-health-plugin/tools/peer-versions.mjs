// Read the installed versions of the DSH packages this plugin links against, so
// peerDependencies can state a range that actually matches the running Harness.
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const installRoot = dirname(process.execPath)
const roots = [
  join(installRoot, 'resources', 'app.asar', 'dsh', 'node_modules'),
  join(installRoot, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules')
]

const names = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-agent-preset',
  '@deepseek-ai/dsh-persona',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-skills',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-schedule',
  '@deepseek-ai/dsh-time-context',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-web-server'
]

for (const name of names) {
  let found = null
  for (const root of roots) {
    const candidate = join(root, name, 'package.json')
    if (!existsSync(candidate)) continue
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
      found = `${manifest.name}@${manifest.version}`
      break
    } catch (error) {
      found = `${name} (unreadable: ${error.message})`
    }
  }
  console.log(found ?? `${name} — not found`)
}
