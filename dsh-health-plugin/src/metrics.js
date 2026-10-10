/**
 * The metric catalog: one definition per record kind.
 *
 * A metric owns how raw model/user arguments become a stored value, how that
 * value is checked against physiological bounds, and what reference range to
 * show. The store and the tools both go through `buildRecord`, so there is one
 * validation path for every writer (agent tool, HTTP route, panel form).
 */
import { computeNight } from './sleep.js'
import { isDateString, today } from './clock.js'

/** @typedef {{ min?: number, max?: number, note?: string }} RefRange */

const clamp01to5 = (n) => Math.round(n * 10) / 10

/**
 * Numeric helper shared by simple scalar metrics.
 *
 * @param {string} field
 * @param {number} value
 * @param {RefRange & { hardMin?: number, hardMax?: number, unit: string }} spec
 */
function scalarValue(field, value, spec) {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new TypeError(`${field} must be a number, got ${JSON.stringify(value)}`)
  if (spec.hardMin !== undefined && n < spec.hardMin) {
    throw new TypeError(`${field} ${n} is below the plausible minimum ${spec.hardMin} ${spec.unit}`)
  }
  if (spec.hardMax !== undefined && n > spec.hardMax) {
    throw new TypeError(`${field} ${n} is above the plausible maximum ${spec.hardMax} ${spec.unit}`)
  }
  return n
}

/**
 * Who put a number into the archive.
 *
 * This is not bookkeeping: a personal health record is only trustworthy if the
 * panel can say where a value came from. A demo or synthetic entry that is
 * indistinguishable from the user's own report reads as if the assistant
 * invented a measurement, so the vocabulary is explicit and rendered in the UI.
 */
export const RECORD_SOURCES = ['user', 'agent', 'import', 'imported', 'sample', 'synthetic', 'device']

/** The source label shown in the panel; null means "do not badge this". */
export function describeSource(source) {
  switch (source) {
    case 'user': return null
    case 'agent': return null
    case 'sample':
    case 'synthetic': return '示例数据'
    case 'device':
    case 'import':
    case 'imported': return '外部导入'
    default: return typeof source === 'string' && source.length > 0 ? `来源：${source}` : null
  }
}

/** True for a record that is deliberately not the user's own report. */
export function isNonUserSource(source) {
  return source === 'sample' || source === 'synthetic'
}

/** Shared envelope fields every stored record carries. */
function envelope(args, entryDate) {
  const date = args.date ?? entryDate
  if (!isDateString(date)) throw new TypeError(`date must be YYYY-MM-DD, got ${JSON.stringify(date)}`)
  if (args.source !== undefined && !RECORD_SOURCES.includes(String(args.source))) {
    throw new TypeError(`source must be one of ${RECORD_SOURCES.join(', ')}, got ${JSON.stringify(args.source)}`)
  }
  return {
    date,
    at: args.at ?? new Date().toISOString(),
    tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
    note: typeof args.note === 'string' && args.note.length > 0 ? args.note : undefined,
    source: typeof args.source === 'string' ? args.source : 'agent',
    // Wall-clock time of a point event (a dose taken, a measurement). Distinct
    // from `at`, which is when the line was written.
    clock: typeof args.clock === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(args.clock.trim())
      ? args.clock.trim()
      : undefined
  }
}

/** Drop undefined fields so JSONL lines stay small and diffable. */
function compact(object) {
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * @typedef {object} MetricSpec
 * @property {string} kind
 * @property {string} label zh label used by the panel
 * @property {'sleep'|'vitals'|'body'|'activity'|'intake'|'mind'|'symptom'|'med'|'lab'} section
 * @property {string} [unit]
 * @property {string} summary short human line, used by reports
 * @property {(args: object, entryDate: string) => object} build
 * @property {(value: object) => string[]} [flags] clinical red flags, empty when unremarkable
 */

/** @type {Record<string, MetricSpec>} */
export const METRICS = {
  sleep: {
    kind: 'sleep',
    label: '睡眠',
    section: 'sleep',
    unit: 'h',
    summary: (r) => `${(r.value.tstMin / 60).toFixed(1)}h 睡眠 / 卧床 ${(r.value.tibMin / 60).toFixed(1)}h，效率 ${Math.round(r.value.efficiency * 100)}%`,
    build(args) {
      // Accept both spellings: snake_case is what the agent tool and raw JSON
      // send, camelCase is what the panel and internal callers use. Supporting
      // one spelling only meant diary entries silently failed to store.
      const value = computeNight({
        bedtime: pick(args, 'bedtime'),
        finalWake: pick(args, 'final_wake', 'finalWake'),
        outOfBed: pick(args, 'out_of_bed', 'outOfBed'),
        sleepOnsetMin: numOf(pick(args, 'sleep_onset_min', 'sol_min', 'sleepOnsetMin')),
        wasoMin: numOf(pick(args, 'waso_min', 'awakenings_min', 'wasoMin')),
        awakeFinalMin: numOf(pick(args, 'awake_final_min', 'awakeFinalMin'))
      })
      const quality = pick(args, 'quality')
      if (quality !== undefined) {
        value.quality = clamp01to5(scalarValue('quality', quality, { unit: '1-5', hardMin: 1, hardMax: 5 }))
      }
      const caffeine = pick(args, 'caffeine')
      if (caffeine !== undefined) value.caffeine = normalizeCaffeine(caffeine)
      const alcohol = pick(args, 'alcohol')
      if (alcohol !== undefined) value.alcohol = normalizeAlcohol(alcohol)
      const screensOff = pick(args, 'screens_off', 'screensOff')
      if (screensOff !== undefined) value.screensOff = String(screensOff)
      const naps = pick(args, 'naps')
      if (naps !== undefined) value.naps = normalizeNaps(naps)
      return value
    },
    flags: (r) => {
      const out = []
      if (r.value.tstMin < 5 * 60) out.push('总睡眠时间不足 5 小时')
      if (r.value.efficiency < 0.75) out.push('睡眠效率低于 75%')
      if (r.value.sleepOnsetMin >= 60) out.push('入睡潜伏期 ≥ 60 分钟')
      if (r.value.wasoMin >= 60) out.push('夜间觉醒 ≥ 60 分钟')
      return out
    }
  },

  weight: {
    kind: 'weight',
    label: '体重',
    section: 'body',
    unit: 'kg',
    summary: (r) => `${r.value.kg} kg`,
    build(args) {
      return { kg: scalarValue('kg', args.kg ?? args.value, { unit: 'kg', hardMin: 2, hardMax: 400 }) }
    }
  },

  blood_pressure: {
    kind: 'blood_pressure',
    label: '血压',
    section: 'vitals',
    unit: 'mmHg',
    summary: (r) => `${r.value.systolic}/${r.value.diastolic} mmHg${r.value.pulse ? `，脉搏 ${r.value.pulse}` : ''}`,
    build(args) {
      const systolic = scalarValue('systolic', args.systolic ?? args.value, { unit: 'mmHg', hardMin: 40, hardMax: 320 })
      const diastolic = scalarValue('diastolic', args.diastolic, { unit: 'mmHg', hardMin: 20, hardMax: 220 })
      if (diastolic >= systolic) throw new TypeError(`diastolic ${diastolic} must be below systolic ${systolic}`)
      const value = { systolic, diastolic }
      if (args.pulse !== undefined) {
        value.pulse = scalarValue('pulse', args.pulse, { unit: 'bpm', hardMin: 20, hardMax: 250 })
      }
      if (args.position !== undefined) value.position = String(args.position)
      return value
    },
    flags: (r) => {
      const out = []
      const { systolic, diastolic } = r.value
      if (systolic >= 180 || diastolic >= 120) out.push('血压 ≥180/120 mmHg：属高血压急症范围，需立即就医')
      else if (systolic >= 140 || diastolic >= 90) out.push('血压达到高血压范围（≥140/90）')
      else if (systolic < 90 || diastolic < 60) out.push('血压偏低（<90/60）')
      return out
    }
  },

  heart_rate: {
    kind: 'heart_rate',
    label: '静息心率',
    section: 'vitals',
    unit: 'bpm',
    summary: (r) => `${r.value.bpm} bpm`,
    build(args) {
      return { bpm: scalarValue('bpm', args.bpm ?? args.value, { unit: 'bpm', hardMin: 20, hardMax: 250 }) }
    },
    flags: (r) => {
      const out = []
      if (r.value.bpm > 100) out.push('静息心率 >100 bpm（心动过速）')
      if (r.value.bpm < 50) out.push('静息心率 <50 bpm（心动过缓）')
      return out
    }
  },

  temperature: {
    kind: 'temperature',
    label: '体温',
    section: 'vitals',
    unit: '°C',
    summary: (r) => `${r.value.celsius} °C`,
    build(args) {
      return { celsius: scalarValue('celsius', args.celsius ?? args.value, { unit: '°C', hardMin: 30, hardMax: 45 }) }
    },
    flags: (r) => {
      const out = []
      if (r.value.celsius >= 39) out.push('体温 ≥39 °C：高热，建议就医')
      else if (r.value.celsius >= 38) out.push('发热（≥38 °C）')
      if (r.value.celsius <= 35) out.push('体温 ≤35 °C：低体温，需就医')
      return out
    }
  },

  glucose: {
    kind: 'glucose',
    label: '血糖',
    section: 'lab',
    unit: 'mmol/L',
    summary: (r) => `${r.value.mmol} mmol/L（${r.value.context}）`,
    build(args) {
      const mmol = scalarValue('mmol', args.mmol ?? args.value, { unit: 'mmol/L', hardMin: 1, hardMax: 40 })
      const context = args.context === undefined ? 'unspecified' : String(args.context)
      return { mmol, context }
    },
    flags: (r) => {
      const out = []
      if (r.value.mmol >= 13.9) out.push('血糖 ≥13.9 mmol/L：需尽快就医评估')
      if (r.value.mmol < 3.9) out.push('血糖 <3.9 mmol/L：低血糖，需立即处理')
      return out
    }
  },

  exercise: {
    kind: 'exercise',
    label: '运动',
    section: 'activity',
    unit: 'min',
    summary: (r) => `${r.value.activity} ${r.value.minutes} min${r.value.intensity ? `（${r.value.intensity}）` : ''}`,
    build(args) {
      const minutes = scalarValue('minutes', args.minutes ?? args.value, { unit: 'min', hardMin: 1, hardMax: 1440 })
      const activity = args.activity === undefined ? '运动' : String(args.activity)
      const value = { activity, minutes }
      if (args.intensity !== undefined) value.intensity = String(args.intensity)
      return value
    }
  },

  steps: {
    kind: 'steps',
    label: '步数',
    section: 'activity',
    unit: '步',
    summary: (r) => `${r.value.count} 步`,
    build(args) {
      return { count: scalarValue('count', args.count ?? args.value, { unit: '步', hardMin: 0, hardMax: 200000 }) }
    }
  },

  diet: {
    kind: 'diet',
    label: '饮食',
    section: 'intake',
    summary: (r) => `${r.value.meal}：${r.value.description}`,
    build(args) {
      const description = requireText(args.description ?? args.value, 'description')
      const meal = args.meal === undefined ? '其他' : String(args.meal)
      const value = { meal, description }
      if (args.kcal !== undefined) value.kcal = scalarValue('kcal', args.kcal, { unit: 'kcal', hardMin: 0, hardMax: 20000 })
      return value
    }
  },

  mood: {
    kind: 'mood',
    label: '情绪',
    section: 'mind',
    summary: (r) => `${r.value.mood}（${r.value.score}/5）`,
    build(args) {
      return {
        mood: requireText(args.mood ?? args.value, 'mood'),
        score: clamp01to5(scalarValue('score', args.score ?? 3, { unit: '1-5', hardMin: 1, hardMax: 5 }))
      }
    },
    flags: (r) => (r.value.score <= 1 ? ['情绪评分处于最低档，若持续请考虑专业评估'] : [])
  },

  symptom: {
    kind: 'symptom',
    label: '症状',
    section: 'symptom',
    summary: (r) => `${r.value.name}（${r.value.severity}/10）${r.value.durationText ? `，${r.value.durationText}` : ''}`,
    build(args) {
      const name = requireText(args.name ?? args.symptom ?? args.value, 'name')
      const value = { name, severity: scalarValue('severity', args.severity ?? 5, { unit: '0-10', hardMin: 0, hardMax: 10 }) }
      if (args.duration !== undefined) value.durationText = String(args.duration)
      if (args.body_site !== undefined) value.bodySite = String(args.body_site)
      return value
    }
  },

  medication: {
    kind: 'medication',
    label: '用药',
    section: 'med',
    summary: (r) => `${r.value.name} ${r.value.dose ?? ''}`.trim(),
    build(args) {
      const name = requireText(args.name ?? args.value, 'name')
      const value = { name }
      if (args.dose !== undefined) value.dose = String(args.dose)
      if (args.reason !== undefined) value.reason = String(args.reason)
      if (args.adherence !== undefined) value.adherence = String(args.adherence)
      if (args.side_effects !== undefined) value.sideEffects = String(args.side_effects)
      return value
    }
  },

  menstrual: {
    kind: 'menstrual',
    label: '月经',
    section: 'body',
    summary: (r) => `${r.value.phase}${r.value.flow ? `，${r.value.flow}` : ''}`,
    build(args) {
      const phase = args.phase === undefined ? '经期' : String(args.phase)
      const value = { phase }
      if (args.flow !== undefined) value.flow = String(args.flow)
      if (args.cycle_day !== undefined) value.cycleDay = scalarValue('cycle_day', args.cycle_day, { unit: 'd', hardMin: 1, hardMax: 90 })
      return value
    }
  },

  lab: {
    kind: 'lab',
    label: '化验',
    section: 'lab',
    summary: (r) => `${r.value.item} ${r.value.value}${r.value.unit ? ` ${r.value.unit}` : ''}`,
    build(args) {
      const item = requireText(args.item ?? args.name, 'item')
      const value = { item, value: requireText(args.measure ?? args.measured ?? args.value, 'measure') }
      if (args.unit !== undefined) value.unit = String(args.unit)
      if (args.reference !== undefined) value.reference = String(args.reference)
      if (args.lab !== undefined) value.lab = String(args.lab)
      return value
    }
  }
}

/** The record kinds, in panel/report order. */
export const METRIC_KINDS = Object.keys(METRICS)

/** Sleep sits first on purpose: it is the plugin's primary lever. */
export const SECTION_ORDER = ['sleep', 'vitals', 'body', 'activity', 'intake', 'mind', 'symptom', 'med', 'lab']

/**
 * Turn one writer's arguments into a stored envelope.
 *
 * @param {string} kind
 * @param {object} args
 * @param {string} entryDate local `YYYY-MM-DD` fallback for `date`
 * @returns {object} a complete, validated record (without `id`)
 */
export function buildRecord(kind, args, entryDate = today()) {
  const spec = METRICS[kind]
  if (!spec) throw new TypeError(`unknown metric kind ${JSON.stringify(kind)}; expected one of ${METRIC_KINDS.join(', ')}`)
  if (args === null || typeof args !== 'object') throw new TypeError('arguments must be an object')
  return compact({ kind, ...envelope(args, entryDate), value: spec.build(args, entryDate) })
}

/** Human one-liner for a stored record. */
export function describeRecord(record) {
  const spec = METRICS[record.kind]
  if (!spec) return `${record.kind}: ${JSON.stringify(record.value)}`
  try {
    return spec.summary(record)
  } catch {
    return `${spec.label}: ${JSON.stringify(record.value)}`
  }
}

/** Clinical red flags for a stored record; always an array. */
export function flagRecord(record) {
  const spec = METRICS[record.kind]
  if (!spec?.flags) return []
  try {
    return spec.flags(record) ?? []
  } catch {
    return []
  }
}

/** First present alias, or undefined. */
function pick(args, ...names) {
  for (const name of names) {
    const value = args[name]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** Numeric alias lookup that leaves undefined alone. */
function numOf(value) {
  return value === undefined ? undefined : Number(value)
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} is required and must be a non-empty string`)
  }
  return value.trim()
}

function normalizeCaffeine(input) {
  const list = Array.isArray(input) ? input : [input]
  return list.map((item) => {
    if (typeof item === 'string') return { at: item }
    if (item && typeof item === 'object') {
      const out = {}
      if (item.at !== undefined) out.at = String(item.at)
      if (item.mg !== undefined) out.mg = scalarValue('caffeine.mg', item.mg, { unit: 'mg', hardMin: 0, hardMax: 2000 })
      if (item.what !== undefined) out.what = String(item.what)
      return out
    }
    throw new TypeError('caffeine entries must be a clock time string or an object with at/mg')
  })
}

function normalizeAlcohol(input) {
  const list = Array.isArray(input) ? input : [input]
  return list.map((item) => {
    if (typeof item === 'string') return { at: item }
    if (item && typeof item === 'object') {
      const out = {}
      if (item.at !== undefined) out.at = String(item.at)
      if (item.units !== undefined) out.units = scalarValue('alcohol.units', item.units, { unit: 'units', hardMin: 0, hardMax: 60 })
      if (item.what !== undefined) out.what = String(item.what)
      return out
    }
    throw new TypeError('alcohol entries must be a clock time string or an object with at/units')
  })
}

function normalizeNaps(input) {
  const list = Array.isArray(input) ? input : [input]
  return list.map((item) => {
    if (typeof item === 'number') return { minutes: item }
    if (item && typeof item === 'object') {
      const out = {}
      if (item.at !== undefined) out.at = String(item.at)
      if (item.minutes !== undefined) out.minutes = scalarValue('nap.minutes', item.minutes, { unit: 'min', hardMin: 1, hardMax: 600 })
      return out
    }
    throw new TypeError('naps entries must be a duration in minutes or an object with at/minutes')
  })
}
