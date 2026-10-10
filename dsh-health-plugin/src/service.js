/**
 * The health service: the single implementation behind every caller.
 *
 * The agent tools, the HTTP routes the panel talks to, and any future
 * automation all go through these methods. Keeping one path matters more here
 * than usual: the validation, the clinical flags, and the safety refusals must
 * not be reimplemented (or skipped) on one side of the UI/tool divide.
 */
import { addDays, dateWindow, today } from './clock.js'
import { METRICS, METRIC_KINDS, buildRecord, describeRecord, describeSource, flagRecord, isNonUserSource } from './metrics.js'
import {
  DRUG_NOTES,
  FORMULATIONS,
  REGIMEN_FREQUENCIES,
  lookupDrug,
  normalizeRegimen,
  regimenId,
  reminderEssentials
} from './medication.js'
import { DRUG_ASPECTS, lookupDrugOnWeb } from './drug-web.js'
import { HealthStore } from './store.js'
import { analyzeNights, nightFromRecord, planSleepWindow } from './sleep-analysis.js'
import { buildReport, summarize, windowPair } from './report.js'

/** Raised for caller mistakes so the tool/route layer can return a clean message. */
export class HealthError extends Error {
  constructor(message, code = 'HEALTH_INVALID') {
    super(message)
    this.name = 'HealthError'
    this.code = code
  }
}

export class HealthService {
  /**
   * @param {{ dir: string, age?: number, log?: (line: string) => void }} options
   */
  constructor(options) {
    if (!options?.dir) throw new TypeError('HealthService needs a data directory')
    this.store = new HealthStore({ dir: options.dir })
    this.age = options.age
    this.log = options.log ?? (() => undefined)
    /**
     * The Host's web access service, when the composition has one. Used only
     * for drug lookups the written notes do not cover; undefined means the web
     * path is unavailable and the tool says so instead of guessing.
     *
     * Writable so tests can substitute a stub and exercise the whole lookup
     * path without a network.
     */
    this.web = options.web
  }

  /** Paths and counters for the panel's data section. */
  async status() {
    await this.store.ensureLayout()
    const profile = await this.store.readProfile()
    const year = Number(today().slice(0, 4))
    const thisYear = await this.store.query({ from: `${year}-01-01`, to: `${year}-12-31` })
    const skipped = this.store.skippedLines()
    return {
      ok: true,
      paths: this.store.paths(),
      kinds: METRIC_KINDS,
      hasProfile: profile !== null && profile.corrupt !== true,
      profileCorrupt: profile?.corrupt === true,
      recordsThisYear: thisYear.length,
      skippedLines: skipped,
      today: today(),
      age: this.ageOf(profile)
    }
  }

  ageOf(profile) {
    if (typeof this.age === 'number') return this.age
    const birthYear = Number(profile?.birthYear)
    if (!Number.isFinite(birthYear) || birthYear < 1900) return undefined
    return new Date().getFullYear() - birthYear
  }

  /** @param {string} kind @param {object} args */
  async record(kind, args) {
    let record
    try {
      record = buildRecord(kind, args, today())
    } catch (error) {
      throw new HealthError(`${error.message}`, 'HEALTH_INVALID_RECORD')
    }
    const stored = await this.store.append(record)
    this.log(`health: recorded ${kind} on ${stored.date}`)
    // Same presentation shape as every read path, so a writer cannot tell the
    // difference between "just written" and "read back".
    const view = withFlags(stored)
    return {
      ok: true,
      record: view,
      summary: view.summary,
      flags: view.flags,
      warnings: stored.value?.warnings ?? []
    }
  }

  /** Records matching a query, newest first for display. */
  async query(input = {}) {
    const to = input.to ?? today()
    const days = clampDays(input.days)
    const from = input.from ?? (days !== null ? addDays(to, -(days - 1)) : addDays(to, -30))
    if (from > to) throw new HealthError(`from (${from}) is after to (${to})`, 'HEALTH_INVALID_RANGE')
    const kinds = normalizeKinds(input.kinds)
    const records = await this.store.query({ from, to, kinds })
    const limit = clampLimit(input.limit)
    const newestFirst = records.slice().reverse()
    return {
      ok: true,
      window: { from, to, days: days ?? undefined },
      total: records.length,
      returned: Math.min(limit, newestFirst.length),
      records: newestFirst.slice(0, limit).map(withFlags)
    }
  }

  /** Latest record per kind, for the panel's "today" cards. */
  async latest(kinds) {
    const wanted = kinds && kinds.length > 0 ? kinds : METRIC_KINDS
    const out = {}
    for (const kind of wanted) {
      const found = await this.store.latest(kind)
      out[kind] = found === null ? null : withFlags(found)
    }
    return { ok: true, kinds: wanted, latest: out }
  }

  /** Everything recorded on one date. */
  async day(date) {
    const target = date ?? today()
    const records = await this.store.query({ from: target, to: target })
    return { ok: true, date: target, count: records.length, records: records.map(withFlags) }
  }

  /** Core sleep numbers plus the CBT-I plan. */
  async sleepAnalysis(input = {}) {
    const days = clampDays(input.days) ?? 14
    const to = input.to ?? today()
    const from = addDays(to, -(days - 1))
    const records = await this.store.query({ from, to, kinds: ['sleep'] })
    const nights = records.map(nightFromRecord)
    const profile = await this.store.readProfile()
    const age = this.ageOf(profile)
    const analysis = analyzeNights(nights, { age })
    const plan = planSleepWindow({ nights, profile: profile ?? {}, today: to })
    return {
      ok: true,
      window: { from, to, days },
      analysis,
      plan,
      diary: nights,
      unmapped: records.filter((record) => typeof record.value?.tibMin !== 'number').map((record) => record.id)
    }
  }

  /** Periodic report plus its structured summary. */
  async report(input = {}) {
    const days = clampDays(input.days) ?? 7
    const to = input.to ?? today()
    const pair = windowPair(to, days)
    const records = await this.store.query({ from: pair.current.from, to: pair.current.to })
    const previous = await this.store.query({ from: pair.previous.from, to: pair.previous.to })
    const report = buildReport({ records, window: pair.current, previous })
    return { ok: true, markdown: report.markdown, summary: report.summary }
  }

  /** Dashboard payload: today, latest values, sleep trend, and the window summary. */
  async dashboard(input = {}) {
    const to = input.to ?? today()
    const days = clampDays(input.days) ?? 30
    const from = addDays(to, -(days - 1))
    const profile = await this.store.readProfile()
    const records = await this.store.query({ from, to })
    const sleepRecords = records.filter((record) => record.kind === 'sleep')
    const nights = sleepRecords.map(nightFromRecord)
    const age = this.ageOf(profile)
    const analysis = analyzeNights(nights, { age })
    const plan = planSleepWindow({ nights, profile: profile ?? {}, today: to })
    const todayRecords = records.filter((record) => record.date === to)
    const summary = summarize(records, { ...dateWindow(to, days), previous: [] })

    return {
      ok: true,
      today: to,
      profile: profile === null ? null : (profile.corrupt === true ? { corrupt: true } : redactProfile(profile)),
      window: { from, to, days },
      lastNight: nights.length > 0 ? nights[nights.length - 1] : null,
      sleep: {
        analysis,
        plan,
        series: sleepSeries(sleepRecords, days, from, to)
      },
      todayRecords: todayRecords.map(withFlags),
      summary,
      skippedLines: this.store.skippedLines()
    }
  }

  /** `HH:MM` frequency for the trend chart. */
  async trends(input = {}) {
    const days = clampDays(input.days) ?? 30
    const to = input.to ?? today()
    const from = addDays(to, -(days - 1))
    const kinds = normalizeKinds(input.kinds) ?? METRIC_KINDS
    const records = await this.store.query({ from, to, kinds })
    const buckets = new Map()
    for (const record of records) {
      if (!buckets.has(record.date)) buckets.set(record.date, {})
      const day = buckets.get(record.date)
      if (!day[record.kind]) day[record.kind] = []
      day[record.kind].push(record)
    }
    const out = []
    for (let offset = 0; offset < days; offset++) {
      const date = addDays(from, offset)
      const day = buckets.get(date) ?? {}
      out.push({
        date,
        sleepTstMin: meanOf((day.sleep ?? []).map((r) => r.value?.tstMin)),
        sleepEfficiency: meanOf((day.sleep ?? []).map((r) => r.value?.efficiency)),
        sleepOnsetMin: meanOf((day.sleep ?? []).map((r) => r.value?.sleepOnsetMin)),
        weightKg: meanOf((day.weight ?? []).map((r) => r.value?.kg)),
        systolic: meanOf((day.blood_pressure ?? []).map((r) => r.value?.systolic)),
        diastolic: meanOf((day.blood_pressure ?? []).map((r) => r.value?.diastolic)),
        restingBpm: meanOf((day.heart_rate ?? []).map((r) => r.value?.bpm)),
        steps: meanOf((day.steps ?? []).map((r) => r.value?.count)),
        exerciseMin: meanOf((day.exercise ?? []).map((r) => r.value?.minutes)),
        moodScore: meanOf((day.mood ?? []).map((r) => r.value?.score)),
        count: Object.values(day).reduce((total, list) => total + list.length, 0)
      })
    }
    return { ok: true, window: { from, to, days }, days: out }
  }

  /** Update a stored record. `patch` is merged, then re-validated. */
  async update(id, patch) {
    if (typeof id !== 'string' || id.length === 0) throw new HealthError('id is required', 'HEALTH_INVALID_ID')
    const existing = await this.store.get(id)
    if (existing === null) throw new HealthError(`no record with id ${id}`, 'HEALTH_NOT_FOUND')

    let rebuilt
    try {
      // Build from the patch itself, falling back to the stored value per field.
      // Merging into the stored envelope first would carry derived sleep fields
      // (tstMin, efficiency, ...) straight back into the builder.
      const stored = argsFromRecord(existing)
      const incoming = { ...(patch ?? {}) }
      if (incoming.value !== undefined) {
        if (incoming.value === null || typeof incoming.value !== 'object' || Array.isArray(incoming.value)) {
          throw new TypeError('value must be an object when updating a record')
        }
        Object.assign(incoming, incoming.value)
        delete incoming.value
      }
      rebuilt = buildRecord(existing.kind, { ...stored, ...incoming }, existing.date)
    } catch (error) {
      throw new HealthError(messageOf(error), 'HEALTH_INVALID_RECORD')
    }
    const next = await this.store.update(id, {
      value: rebuilt.value,
      date: rebuilt.date,
      note: rebuilt.note,
      tags: rebuilt.tags
    })
    if (next === null) throw new HealthError(`no record with id ${id}`, 'HEALTH_NOT_FOUND')
    return { ok: true, record: withFlags(next), summary: describeRecord(next), flags: flagRecord(next) }
  }

  /** Remove one record. */
  async remove(id) {
    if (typeof id !== 'string' || id.length === 0) throw new HealthError('id is required', 'HEALTH_INVALID_ID')
    const removed = await this.store.remove(id)
    if (!removed) throw new HealthError(`no record with id ${id}`, 'HEALTH_NOT_FOUND')
    return { ok: true, id }
  }

  /** Read the profile. */
  async readProfile() {
    const profile = await this.store.readProfile()
    return { ok: true, profile: profile === null ? null : profile, age: this.ageOf(profile) }
  }

  /** Merge a profile patch. */
  async updateProfile(patch) {
    try {
      const next = await this.store.updateProfile(sanitizeProfilePatch(patch))
      return { ok: true, profile: next }
    } catch (error) {
      throw new HealthError(error.message, 'HEALTH_INVALID_PROFILE')
    }
  }

  /**
   * Delete every record that is deliberately not the user's own data.
   *
   * Sample records are useful for a first look at the panel and dangerous if
   * they are mistaken for real measurements, so removing them has to be one
   * action rather than an id-by-id hunt.
   */
  async removeSampleRecords() {
    const all = await this.store.query({ from: '1970-01-01', to: addDays(today(), 1) })
    const doomed = all.filter((record) => isNonUserSource(record.source))
    for (const record of doomed) {
      await this.store.remove(record.id)
    }
    return { ok: true, removed: doomed.length, ids: doomed.map((record) => record.id) }
  }

  // ---------------------------------------------------- standing medications ---

  /**
   * Register or update one standing medication and return it with the written
   * notes for that drug.
   *
   * The regimen is what the *prescriber* said; the notes are reference text.
   * Both come back so the caller never has to invent either.
   *
   * @param {object} input
   */
  async saveMedication(input) {
    let regimen
    try {
      regimen = normalizeRegimen(input, today())
    } catch (error) {
      throw new HealthError(error.message, 'HEALTH_INVALID_MEDICATION')
    }
    const id = regimenId(regimen)
    const stored = await this.store.saveMedication({ ...regimen, id })
    const notes = lookupDrug(stored.name)
    const essentials = reminderEssentials(stored, notes)
    this.log(`health: medication ${stored.name} registered (${stored.frequency})`)
    return {
      ok: true,
      medication: stored,
      notes,
      essentials,
      // Registration is only half the job: a regimen without a reminder is a
      // plan that never fires. Hand the caller everything needed to schedule
      // one, so it does not have to invent the wording or the times.
      reminders: this.buildReminderPlan(stored, essentials, notes)
    }
  }

  /**
   * The reminder each intake time should get.
   *
   * The schedule service is scoped to the health-mode composition, so reminders
   * are returned rather than created here: the agent in a health-mode session
   * calls `schedule_create` with these values.
   */
  buildReminderPlan(regimen, essentials, notes) {
    const times = Array.isArray(regimen.times) ? regimen.times : []
    if (regimen.remind === false || times.length === 0) {
      return {
        needed: false,
        reason: regimen.remind === false ? '用户关闭了提醒' : '没有登记服药时间，无法排提醒'
      }
    }
    const drugName = notes?.known === true && Array.isArray(notes.drugs) && notes.drugs.length > 0
      ? notes.drugs[0].name
      : regimen.name
    return {
      needed: true,
      rule: 'daily',
      instructions: '用 schedule_create 的 daily 规则逐条创建；time_zone 必须取 time-context 报出的时区，不要猜。',
      entries: times.map((time) => ({
        time,
        time_zone: '<取 time-context>',
        title: `${time} 服用${drugName}`,
        prompt: `该服用${drugName}了。${essentials.join('；')}。`
          + '提醒用户按处方服用，并在服用后用 medication_taken 记录；'
          + '若用户说没吃，用 medication_taken 记 skipped=true，不要催促、不要建议补服或加量。'
      }))
    }
  }

  /** Every standing medication, with a reminder preview for each. */
  async listMedications() {
    const current = await this.store.readMedications()
    const medications = (current?.medications ?? []).map((regimen) => {
      const notes = lookupDrug(regimen.name)
      const essentials = reminderEssentials(regimen, notes)
      return {
        ...regimen,
        notesKnown: notes.known,
        essentials,
        reminders: this.buildReminderPlan(regimen, essentials, notes)
      }
    })
    return {
      ok: true,
      corrupt: current?.corrupt === true,
      count: medications.length,
      activeCount: medications.filter((entry) => entry.active !== false).length,
      medications
    }
  }

  /** Remove one standing medication. */
  async removeMedication(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new HealthError('id is required', 'HEALTH_INVALID_ID')
    }
    const removed = await this.store.removeMedication(id)
    if (!removed) throw new HealthError(`no standing medication with id ${id}`, 'HEALTH_NOT_FOUND')
    return { ok: true, id }
  }

  /**
   * Written notes for a drug the user named, with a web fallback.
   *
   * Local notes come first because they are curated and reviewed. When they do
   * not cover the drug — and only then, or when the caller explicitly asks —
   * the same question goes to the web, and what comes back is **quoted with its
   * source** rather than summarised from memory. A drug fact recalled from
   * training is the exact failure mode the local notes exist to prevent, so the
   * web path must never become that by another route.
   *
   * @param {string} name drug name as the user wrote it
   * @param {{ focus?: string, source?: 'auto'|'notes'|'web', signal?: AbortSignal }} [options]
   */
  async drugNotes(name, options = {}) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new HealthError('name is required (the drug name to look up)', 'HEALTH_INVALID_DRUG')
    }
    const mode = options.source ?? 'auto'
    if (!['auto', 'notes', 'web'].includes(mode)) {
      throw new HealthError(`source must be auto, notes, or web, got ${JSON.stringify(options.source)}`, 'HEALTH_INVALID_DRUG')
    }
    if (options.focus !== undefined && DRUG_ASPECTS[options.focus] === undefined) {
      throw new HealthError(
        `focus must be one of ${Object.keys(DRUG_ASPECTS).join(', ')}, got ${JSON.stringify(options.focus)}`,
        'HEALTH_INVALID_DRUG'
      )
    }

    const local = lookupDrug(name)
    const wantsWeb = mode === 'web' || (mode === 'auto' && (local.known !== true || options.focus !== undefined))
    if (!wantsWeb) return { ok: true, ...local }
    if (this.web === undefined) {
      return {
        ok: true,
        ...local,
        webUnavailable: true,
        webNote: '当前的配置里没有联网检索服务，所以无法替你查网。'
          + '请查看药品说明书或咨询药师；提醒功能不依赖这些说明。'
      }
    }

    const web = await lookupDrugOnWeb({ web: this.web, name, focus: options.focus, signal: options.signal })
    const useful = Array.isArray(web.passages) && web.passages.length > 0
    const notes = [
      '以下是网页检索到的**原文摘录**，每段都带来源链接。它们不是本插件的成文说明，'
        + '可能不含最新信息；请以药品说明书、药师或医生的意见为准。'
    ]
    if (web.failed === true) {
      notes.push('本次检索失败，请自行查说明书。')
    } else if (!useful) {
      // Extraction failed but the links may still be good: hand them over
      // rather than dead-ending the user with "go read the label".
      notes.push('**没有提取到可引用的原文段落**（常见原因：命中的是外文或 PDF 页面）。'
        + '下面的来源链接请自行打开核对；若其中没有权威来源，请以说明书为准。')
    } else if (web.trustedFound !== true) {
      notes.push('未命中药品监管或权威医学数据库，请谨慎对待下列来源。')
    }
    return {
      ok: true,
      ...local,
      web: { ...web, useful, note: notes.join(' ') }
    }
  }

  /** The written drug vocabulary, for the panel and for tests. */
  drugCatalog() {
    return {
      ok: true,
      drugs: Object.entries(DRUG_NOTES).map(([id, entry]) => ({
        id,
        name: entry.name,
        aliases: entry.aliases ?? [],
        drugClass: entry.drugClass,
        usedFor: entry.usedFor
      })),
      formulations: Object.entries(FORMULATIONS).map(([id, entry]) => ({ id, ...entry })),
      frequencies: REGIMEN_FREQUENCIES
    }
  }

  /** Metric catalog for the panel's forms. */
  catalog() {
    return {      ok: true,
      kinds: METRIC_KINDS,
      metrics: Object.fromEntries(Object.entries(METRICS).map(([kind, spec]) => [kind, {
        kind,
        label: spec.label,
        section: spec.section,
        unit: spec.unit ?? null
      }]))
    }
  }

  /** Everything, as one JSON document, for backup. */
  async exportAll() {
    const records = await this.store.query({ from: '1970-01-01', to: addDays(today(), 1) })
    const profile = await this.store.readProfile()
    return {
      ok: true,
      exportedAt: new Date().toISOString(),
      profile,
      records,
      paths: this.store.paths()
    }
  }
}

/**
 * Attach everything the presentation layer needs to one record: a human
 * summary, the clinical flags, the source label, and whether the record is
 * deliberately non-user data that should be badged as such.
 */
export function withFlags(record) {
  return {
    ...record,
    summary: describeRecord(record),
    flags: flagRecord(record),
    sourceLabel: describeSource(record.source),
    sample: isNonUserSource(record.source)
  }
}

/** Rebuild argument shape from a stored record so updates validate identically. */
function argsFromRecord(record) {
  const value = record.value ?? {}
  const base = { date: record.date, note: record.note, tags: record.tags }
  switch (record.kind) {
    case 'sleep':
      return {
        ...base,
        bedtime: value.bedClock,
        out_of_bed: value.outOfBedClock,
        sleep_onset_min: value.sleepOnsetMin,
        waso_min: value.wasoMin,
        awake_final_min: value.awakeFinalMin,
        quality: value.quality,
        caffeine: value.caffeine,
        alcohol: value.alcohol,
        screens_off: value.screensOff,
        naps: value.naps
      }
    case 'weight': return { ...base, kg: value.kg }
    case 'blood_pressure': return { ...base, systolic: value.systolic, diastolic: value.diastolic, pulse: value.pulse, position: value.position }
    case 'heart_rate': return { ...base, bpm: value.bpm }
    case 'temperature': return { ...base, celsius: value.celsius }
    case 'glucose': return { ...base, mmol: value.mmol, context: value.context }
    case 'exercise': return { ...base, activity: value.activity, minutes: value.minutes, intensity: value.intensity }
    case 'steps': return { ...base, count: value.count }
    case 'diet': return { ...base, meal: value.meal, description: value.description, kcal: value.kcal }
    case 'mood': return { ...base, mood: value.mood, score: value.score }
    case 'symptom': return { ...base, name: value.name, severity: value.severity, duration: value.durationText, body_site: value.bodySite }
    case 'medication': return { ...base, name: value.name, dose: value.dose, reason: value.reason, adherence: value.adherence, side_effects: value.sideEffects }
    case 'menstrual': return { ...base, phase: value.phase, flow: value.flow, cycle_day: value.cycleDay }
    case 'lab': return { ...base, item: value.item, measure: value.value, unit: value.unit, reference: value.reference, lab: value.lab }
    default: return base
  }
}

/** Sleep points for the chart, one entry per day, gaps preserved. */
function sleepSeries(records, days, from, to) {
  const byDate = new Map()
  for (const record of records) {
    if (!byDate.has(record.date)) byDate.set(record.date, [])
    byDate.get(record.date).push(record)
  }
  const out = []
  for (let offset = 0; offset < days; offset++) {
    const date = addDays(from, offset)
    const list = byDate.get(date) ?? []
    out.push({
      date,
      tstMin: meanOf(list.map((r) => r.value?.tstMin)),
      tibMin: meanOf(list.map((r) => r.value?.tibMin)),
      efficiency: meanOf(list.map((r) => r.value?.efficiency)),
      solMin: meanOf(list.map((r) => r.value?.sleepOnsetMin)),
      wasoMin: meanOf(list.map((r) => r.value?.wasoMin)),
      midpointMin: meanOf(list.map((r) => r.value?.midpointMin)),
      quality: meanOf(list.map((r) => r.value?.quality))
    })
  }
  return out
}

/**
 * Field names that must never enter the plaintext profile.
 *
 * An ID number belongs here as much as a password does: it is the single most
 * useful field for identity theft, it has no clinical value, and this file is
 * unencrypted by design. Both the English and the Chinese names a user would
 * actually type are matched.
 */
const PROFILE_SECRET_HINT = /(身份证|护照|银行卡|社保卡|医保卡|密码|口令|密钥|password|passwd|secret|token|api[_-]?key|id[_-]?card|passport|bank[_-]?card|social[_-]?security)/i

/** Refuse patches that look like an attempt to store credentials. */
function sanitizeProfilePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('profile patch must be an object')
  }
  for (const key of Object.keys(patch)) {
    if (PROFILE_SECRET_HINT.test(key)) {
      throw new TypeError(`refusing to store ${key}: the health profile is plaintext and is not for credentials`)
    }
  }
  const out = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/** Hide nothing today, but keep one place that could. */
function redactProfile(profile) {
  return profile
}

function normalizeKinds(kinds) {
  if (kinds === undefined || kinds === null) return null
  const list = (Array.isArray(kinds) ? kinds : [kinds])
    .flatMap((kind) => String(kind).split(','))
    .map((kind) => kind.trim())
    .filter((kind) => kind.length > 0)
  if (list.length === 0) return null
  const unknown = list.filter((kind) => !(kind in METRICS))
  if (unknown.length > 0) {
    throw new HealthError(`unknown metric kind(s): ${unknown.join(', ')}; expected one of ${METRIC_KINDS.join(', ')}`, 'HEALTH_INVALID_KIND')
  }
  return list
}

function clampDays(value) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) throw new HealthError(`days must be a number, got ${JSON.stringify(value)}`, 'HEALTH_INVALID_RANGE')
  return Math.min(3660, Math.max(1, Math.floor(n)))
}

function clampLimit(value) {
  if (value === undefined || value === null || value === '') return 200
  const n = Number(value)
  if (!Number.isFinite(n)) return 200
  return Math.min(5000, Math.max(1, Math.floor(n)))
}

function meanOf(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (usable.length === 0) return null
  return Math.round((usable.reduce((a, b) => a + b, 0) / usable.length) * 1000) / 1000
}
