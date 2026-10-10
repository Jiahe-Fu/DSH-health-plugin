/**
 * Plain-file health store.
 *
 * Design decisions worth stating once:
 *
 * - **Files, not a database.** The user asked for data they can open, read,
 *   grep, back up, and delete. One JSON profile plus one append-only JSONL file
 *   per calendar year. No index, no migration tool, no lock file.
 * - **Append for writes, rewrite for edits.** Adding a record appends one line.
 *   Updating or deleting rewrites that year's file atomically (temp + rename),
 *   so a crash never leaves a half-written line.
 * - **Tolerant reads.** A corrupt or partial line is skipped and reported
 *   rather than thrown: one bad line must not cost the user their history.
 * - **The envelope carries a version.** `v` on the profile and on each record
 *   lets a future reader tell what wrote the line.
 */
import { mkdir, readFile, rename, writeFile, unlink, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { addDays, today } from './clock.js'

export const PROFILE_SCHEMA_VERSION = 1
export const RECORD_SCHEMA_VERSION = 1
export const MEDICATIONS_SCHEMA_VERSION = 1

/** Fields a profile may carry. Unknown fields are preserved on update. */
export const PROFILE_FIELDS = [
  'displayName', 'birthYear', 'sex', 'heightCm', 'timezone', 'locale',
  'goals', 'conditions', 'allergies', 'medications', 'caffeineHabit',
  'alcoholHabit', 'screenHabit', 'occupation', 'shiftWork', 'safetyCritical',
  'targetWake', 'createdAt', 'updatedAt'
]

/** @typedef {{ dir: string, profileFile?: string, recordsDir?: string }} StoreOptions */

export class HealthStore {
  /** @param {StoreOptions} options */
  constructor(options) {
    if (!options?.dir) throw new TypeError('HealthStore needs a data directory')
    this.dir = options.dir
    this.profilePath = options.profileFile ?? join(this.dir, 'profile.json')
    this.medicationsPath = options.medicationsFile ?? join(this.dir, 'medications.json')
    this.recordsDir = options.recordsDir ?? join(this.dir, 'records')
    this.readmePath = join(this.dir, 'README.txt')
    /** @type {Map<number, object[]>} year -> records, loaded lazily */
    this._cache = new Map()
    /** @type {Map<number, string[]>} year -> skipped-line diagnostics */
    this._skipped = new Map()
    /** Serializes file mutations inside the Host process. */
    this._tail = Promise.resolve()
  }

  /** Absolute paths, for the panel's "open folder" hint. */
  paths() {
    return {
      root: this.dir,
      profile: this.profilePath,
      medications: this.medicationsPath,
      records: this.recordsDir,
      readme: this.readmePath
    }
  }

  /** Create the layout and a human-readable README on first use. */
  async ensureLayout() {
    await mkdir(this.recordsDir, { recursive: true })
    try {
      await stat(this.readmePath)
    } catch {
      await writeFile(this.readmePath, README_TEXT, 'utf8')
    }
  }

  /** Run one mutation with exclusive access to the files. */
  _serialize(operation) {
    const run = this._tail.then(operation, operation)
    // Keep the chain alive even when an operation rejects.
    this._tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Read the profile, or null when the user has not set one up.
   * @returns {Promise<object|null>}
   */
  async readProfile() {
    try {
      const raw = await readFile(this.profilePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { corrupt: true, raw: raw.slice(0, 2000), v: PROFILE_SCHEMA_VERSION }
      }
      return parsed
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      if (error instanceof SyntaxError) {
        const raw = await readFile(this.profilePath, 'utf8').catch(() => '')
        return { corrupt: true, raw: raw.slice(0, 2000), v: PROFILE_SCHEMA_VERSION }
      }
      throw error
    }
  }

  /**
   * Merge a patch into the profile and persist it atomically.
   * @param {object} patch
   */
  async updateProfile(patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('profile patch must be an object')
    }
    return this._serialize(async () => {
      await this.ensureLayout()
      const current = await this.readProfile()
      const base = current && !current.corrupt ? current : {}
      const now = new Date().toISOString()
      const next = { ...base, ...patch, v: PROFILE_SCHEMA_VERSION, updatedAt: now }
      if (base.createdAt === undefined) next.createdAt = now
      await this._writeJsonAtomic(this.profilePath, next)
      return next
    })
  }

  // ---------------------------------------------------- standing medications ---

  /**
   * Read the standing medication list.
   *
   * Kept as one JSON document rather than JSONL because a regimen is edited in
   * place (a dose changes, a course ends) rather than appended to, and a user
   * who opens this file should see their current list, not its history.
   *
   * @returns {Promise<{ v: number, medications: object[], updatedAt?: string } | null>}
   */
  async readMedications() {
    try {
      const raw = await readFile(this.medicationsPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { v: MEDICATIONS_SCHEMA_VERSION, medications: [], corrupt: true }
      }
      return {
        v: parsed.v ?? MEDICATIONS_SCHEMA_VERSION,
        medications: Array.isArray(parsed.medications) ? parsed.medications : [],
        updatedAt: parsed.updatedAt
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      if (error instanceof SyntaxError) {
        return { v: MEDICATIONS_SCHEMA_VERSION, medications: [], corrupt: true }
      }
      throw error
    }
  }

  /**
   * Insert or replace one regimen, keyed by `regimenId`.
   *
   * @param {object} regimen normalized regimen, already carrying `id`
   */
  async saveMedication(regimen) {
    return this._serialize(async () => {
      await this.ensureLayout()
      const current = await this.readMedications()
      const list = (current?.medications ?? []).filter((entry) => entry.id !== regimen.id)
      const now = new Date().toISOString()
      const next = { ...regimen, updatedAt: now }
      if (next.createdAt === undefined) next.createdAt = now
      list.push(next)
      list.sort((a, b) => String(a.name).localeCompare(String(b.name)))
      await this._writeJsonAtomic(this.medicationsPath, {
        v: MEDICATIONS_SCHEMA_VERSION,
        updatedAt: now,
        medications: list
      })
      return next
    })
  }

  /** Remove one regimen by id. Returns whether anything was removed. */
  async removeMedication(id) {
    return this._serialize(async () => {
      const current = await this.readMedications()
      const list = current?.medications ?? []
      const next = list.filter((entry) => entry.id !== id)
      if (next.length === list.length) return false
      await this._writeJsonAtomic(this.medicationsPath, {
        v: MEDICATIONS_SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
        medications: next
      })
      return true
    })
  }

  /** One regimen by id, or null. */
  async getMedication(id) {
    const current = await this.readMedications()
    return (current?.medications ?? []).find((entry) => entry.id === id) ?? null
  }

  /**
   * Append one validated record and return it with its assigned id.
   *
   * @param {object} record result of `buildRecord`
   */
  async append(record) {
    return this._serialize(async () => {
      await this.ensureLayout()
      const stored = {
        v: RECORD_SCHEMA_VERSION,
        id: randomUUID(),
        recordedAt: new Date().toISOString(),
        ...record
      }
      const year = yearOf(stored.date)
      const list = await this._loadYear(year)
      list.push(stored)
      await this._appendLine(this._yearPath(year), JSON.stringify(stored))
      return stored
    })
  }

  /**
   * Update one record by id. Returns the updated record, or null when the id is
   * unknown. `patch` is merged into the record then re-validated by the caller.
   *
   * @param {string} id
   * @param {object} patch
   * @param {(record: object) => object} [validate] re-validation hook
   */
  async update(id, patch, validate) {
    return this._serialize(async () => {
      const found = await this._find(id)
      if (found === null) return null
      const merged = { ...found.record, ...patch, id: found.record.id, v: RECORD_SCHEMA_VERSION }
      const validated = validate ? validate(merged) : merged
      const next = { ...merged, ...validated, updatedAt: new Date().toISOString() }
      found.list[found.index] = next
      this._cache.set(found.year, found.list)
      await this._writeJsonlAtomic(this._yearPath(found.year), found.list)
      return next
    })
  }

  /** Delete one record by id. Returns true when something was removed. */
  async remove(id) {
    return this._serialize(async () => {
      const found = await this._find(id)
      if (found === null) return false
      found.list.splice(found.index, 1)
      this._cache.set(found.year, found.list)
      await this._writeJsonlAtomic(this._yearPath(found.year), found.list)
      return true
    })
  }

  /**
   * Records in `[from, to]` (inclusive), ascending by date then recordedAt.
   *
   * @param {{ from: string, to: string, kinds?: readonly string[] }} query
   */
  async query(query) {
    const { from, to } = query
    const kinds = query.kinds && query.kinds.length > 0 ? new Set(query.kinds) : null
    const years = yearsBetween(from, to)
    const out = []
    for (const year of years) {
      for (const record of await this._loadYear(year)) {
        if (record.date < from || record.date > to) continue
        if (kinds !== null && !kinds.has(record.kind)) continue
        out.push(record)
      }
    }
    out.sort((a, b) => (a.date === b.date
      ? String(a.recordedAt ?? '').localeCompare(String(b.recordedAt ?? ''))
      : a.date.localeCompare(b.date)))
    return out
  }

  /** The most recent record of one kind, or null. */
  async latest(kind) {
    const all = await this.query({ from: '1970-01-01', to: addDays(today(), 1), kinds: [kind] })
    return all.length > 0 ? all[all.length - 1] : null
  }

  /** One record by id, or null. Cheaper than scanning a date range. */
  async get(id) {
    if (typeof id !== 'string' || id.length === 0) return null
    const found = await this._find(id)
    return found === null ? null : found.record
  }

  /**
   * Diagnostics for lines that could not be parsed. Surfaced in the panel so a
   * damaged file is visible instead of silently losing history.
   */
  skippedLines() {
    const out = []
    for (const [year, lines] of this._skipped) {
      for (const line of lines) out.push({ year, line })
    }
    return out
  }

  /** Drop every cached year so the next read hits disk. */
  invalidate() {
    this._cache.clear()
    this._skipped.clear()
  }

  /** @param {number} year */
  _yearPath(year) {
    return join(this.recordsDir, `${year}.jsonl`)
  }

  async _loadYear(year) {
    const cached = this._cache.get(year)
    if (cached !== undefined) return cached
    const path = this._yearPath(year)
    let text
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this._cache.set(year, [])
        return this._cache.get(year)
      }
      throw error
    }
    const records = []
    const skipped = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string' && typeof parsed.kind === 'string') {
          records.push(parsed)
        } else {
          skipped.push(trimmed.slice(0, 200))
        }
      } catch {
        skipped.push(trimmed.slice(0, 200))
      }
    }
    this._cache.set(year, records)
    if (skipped.length > 0) this._skipped.set(year, skipped)
    return records
  }

  /** Locate one record across the loaded years (current and previous only). */
  async _find(id) {
    const nowYear = new Date().getFullYear()
    const candidates = [nowYear, nowYear - 1, nowYear + 1]
    for (const year of candidates) {
      const list = await this._loadYear(year)
      const index = list.findIndex((record) => record.id === id)
      if (index >= 0) return { year, list, index, record: list[index] }
    }
    return null
  }

  /**
   * Append one line, preserving the invariant that the file is always complete.
   * The read-then-atomic-rewrite costs a full-file copy per write, which is the
   * right trade at diary scale (a year is a few hundred short lines) and buys
   * immunity to a crash mid-write.
   */
  async _appendLine(path, line) {
    await mkdir(dirname(path), { recursive: true })
    const existing = await readFile(path, 'utf8').catch(() => '')
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing
    await this._writeTextAtomic(path, `${prefix}${line}\n`)
  }

  async _writeJsonlAtomic(path, records) {
    const body = records.map((record) => JSON.stringify(record)).join('\n')
    await this._writeTextAtomic(path, body.length > 0 ? `${body}\n` : '')
  }

  async _writeJsonAtomic(path, value) {
    await this._writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
  }

  async _writeTextAtomic(path, text) {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, text, 'utf8')
    try {
      await renameWithRetry(temp, path)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
  }
}

/** Errors a rename can hit when something transiently holds the destination. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'])

/**
 * Rename with a short retry, because on Windows an atomic replace of a file
 * that is momentarily open (a concurrent read, a scanner, the search indexer)
 * fails with EPERM/EACCES rather than succeeding or failing permanently.
 *
 * Without this the store's crash-safe write becomes its own failure mode: a
 * delete or an edit would occasionally fail outright. The delay is short and
 * bounded, and a genuinely unwritable path still surfaces the original error.
 */
async function renameWithRetry(from, to) {
  const delays = [0, 10, 25, 60, 120]
  let lastError
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delay))
    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      if (!TRANSIENT_RENAME_CODES.has(error?.code)) throw error
    }
  }
  throw lastError
}

/** Calendar year taken from a `YYYY-MM-DD` date. */
export function yearOf(date) {
  const year = Number(String(date).slice(0, 4))
  if (!Number.isSafeInteger(year)) throw new TypeError(`cannot read a year from ${JSON.stringify(date)}`)
  return year
}

/** Every year touched by an inclusive date range, ascending. */
export function yearsBetween(from, to) {
  const first = yearOf(from)
  const last = yearOf(to)
  const out = []
  for (let year = first; year <= last; year++) out.push(year)
  return out
}

const README_TEXT = `DSH 健康档案（dsh-health-plugin）
=================================

这个目录里是你的全部健康数据。全部是纯文本，没有加密，没有上传到任何服务器。

文件说明
--------
profile.json          你的健康档案：身高、出生年、长期用药、过敏史、目标、习惯等。
records/<年份>.jsonl  健康记录流水，一行一条 JSON。追加写入，可直接用文本编辑器查看。
README.txt            本文件。

隐私边界（重要）
---------------
1. 落盘是纯文本：任何能读你用户目录的程序都能读到它。加密不在本版本范围内。
2. **本地存储不等于隐私**：当你在 DSH 对话里讨论这些数据时，相关内容会作为提示词
   发送给模型提供商。想避免这一点，就只记录、不提问；或提问时只描述不引用具体数值。
3. 没有任何数据会自动离开这台机器——本插件不发网络请求。

如何删除
--------
删除整个目录即可，插件会在下次使用时重建空档案：
    Remove-Item -Recurse -Force "$env:USERPROFILE\\.dsh\\health"

如何备份
--------
复制整个目录。JSONL 是纯文本，可以直接用 git 管理（若你不介意明文）。

数据格式版本
------------
profile.json 的 v 字段、每条记录的 v 字段记录写入时的 schema 版本。
读入时容忍未知字段，老版本记录在新版本里依然可读。
`
