// Stream-scan an Electron asar for a regex and print matching excerpts in context.
// Usage: node grep-asar.mjs <app.asar> <pathRegex> <contentRegex> [contextChars]
import { readFileSync } from 'node:fs'

const [, , asarPath, pathRe, contentRe, ctxArg, maxArg] = process.argv
const context = Number(ctxArg ?? 600)
const MAX = Number(maxArg ?? 12)
const fd = readFileSync(asarPath)
const headerSize = fd.readUInt32LE(12)
const header = JSON.parse(fd.subarray(16, 16 + headerSize).toString('utf8'))
const baseOffset = 16 + headerSize
const pRe = new RegExp(pathRe)
const cRe = new RegExp(contentRe, 'g')

const entries = []
const walk = (node, prefix) => {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (child.files) walk(child, p)
    else if (!child.unpacked && child.offset !== undefined) entries.push({ path: p, size: child.size, offset: Number(child.offset) })
  }
}
walk(header, '')

let hits = 0
for (const e of entries) {
  if (!pRe.test(e.path)) continue
  if (e.size > 3_000_000) continue
  const text = fd.subarray(baseOffset + e.offset, baseOffset + e.offset + e.size).toString('utf8')
  cRe.lastIndex = 0
  let m
  while ((m = cRe.exec(text)) !== null) {
    hits++
    if (hits > MAX) break
    const start = Math.max(0, m.index - context)
    const end = Math.min(text.length, m.index + m[0].length + context)
    console.log(`\n===== ${e.path} @${m.index} =====`)
    console.log(text.slice(start, end))
  }
}
if (hits === 0) console.log('no matches')
