// Print a character range of one file inside an Electron asar.
// Usage: node slice-asar.mjs <app.asar> <exactPathSuffix> <start> <length>
import { readFileSync } from 'node:fs'

const [, , asarPath, suffix, startArg, lenArg] = process.argv
const start = Number(startArg)
const len = Number(lenArg)
const fd = readFileSync(asarPath)
const headerSize = fd.readUInt32LE(12)
const header = JSON.parse(fd.subarray(16, 16 + headerSize).toString('utf8'))
const baseOffset = 16 + headerSize

let found
const walk = (node, prefix) => {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (child.files) walk(child, p)
    else if (p.endsWith(suffix)) found = { path: p, size: child.size, offset: Number(child.offset) }
  }
}
walk(header, '')
if (!found) {
  console.error(`not found: ${suffix}`)
  process.exit(1)
}
const text = fd.subarray(baseOffset + found.offset, baseOffset + found.offset + found.size).toString('utf8')
console.log(`@@ ${found.path} size=${found.size} showing [${start}, ${start + len})`)
console.log(text.slice(start, start + len))
