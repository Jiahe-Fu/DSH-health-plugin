/**
 * Cross-metric reporting: the "changes since last time" view that makes a
 * personal health record worth keeping.
 *
 * Deliberately factual. It states what the numbers did; it does not explain
 * why or diagnose. Interpretation belongs in the agent conversation, where a
 * human can push back.
 */
import { dateWindow, formatMinutes } from './clock.js'
import { METRICS, METRIC_KINDS, describeRecord, flagRecord } from './metrics.js'

/**
 * Aggregate every metric over a window, plus the per-kind trend against the
 * preceding window of the same length.
 *
 * @param {readonly object[]} records records inside the window
 * @param {{ from: string, to: string, days: number, previous?: readonly object[] }} window
 */
export function summarize(records, window) {
  const byKind = new Map()
  for (const kind of METRIC_KINDS) byKind.set(kind, [])
  for (const record of records) {
    if (!byKind.has(record.kind)) byKind.set(record.kind, [])
    byKind.get(record.kind).push(record)
  }

  const previousByKind = new Map()
  for (const record of window.previous ?? []) {
    if (!previousByKind.has(record.kind)) previousByKind.set(record.kind, [])
    previousByKind.get(record.kind).push(record)
  }

  const kinds = {}
  for (const [kind, list] of byKind) {
    if (list.length === 0) continue
    const spec = METRICS[kind]
    const numeric = numericSeries(kind, list)
    const previous = numericSeries(kind, previousByKind.get(kind) ?? [])
    kinds[kind] = {
      label: spec?.label ?? kind,
      section: spec?.section ?? 'other',
      unit: spec?.unit,
      count: list.length,
      first: list[0]?.date,
      last: list[list.length - 1]?.date,
      series: numeric,
      mean: meanOf(numeric.map((point) => point.value)),
      previousMean: previous.length > 0 ? meanOf(previous.map((point) => point.value)) : null,
      latest: list[list.length - 1]
    }
    if (kinds[kind].mean !== null && kinds[kind].previousMean !== null) {
      kinds[kind].delta = round(kinds[kind].mean - kinds[kind].previousMean)
    }
  }

  const flagged = records
    .map((record) => ({ record, flags: flagRecord(record) }))
    .filter((entry) => entry.flags.length > 0)

  return {
    window: { from: window.from, to: window.to, days: window.days },
    totalRecords: records.length,
    kinds,
    flagged: flagged.map((entry) => ({
      date: entry.record.date,
      kind: entry.record.kind,
      summary: describeRecord(entry.record),
      flags: entry.flags
    }))
  }
}

/** Daily averages for one metric, ascending, skipping days with no data. */
export function dailySeries(records, kind) {
  const buckets = new Map()
  for (const record of records) {
    if (record.kind !== kind) continue
    if (!buckets.has(record.date)) buckets.set(record.date, [])
    buckets.get(record.date).push(record)
  }
  const out = []
  for (const [date, list] of [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const values = list.map((record) => primaryValue(kind, record)).filter((v) => v !== null)
    if (values.length === 0) continue
    out.push({ date, value: round(meanOf(values)), count: list.length })
  }
  return out
}

/**
 * A human-readable periodic report.
 *
 * @param {{ records: readonly object[], window: object, previous?: readonly object[] }} input
 */
export function buildReport(input) {
  const summary = summarize(input.records, { ...input.window, previous: input.previous })
  const sleepRecords = input.records.filter((record) => record.kind === 'sleep')
  const nights = sleepRecords.length

  const lines = []
  lines.push(`# 健康报告（${summary.window.from} ~ ${summary.window.to}，共 ${summary.window.days} 天）`)
  lines.push('')
  lines.push(`记录条数：${summary.totalRecords}`)
  lines.push('')

  lines.push('## 睡眠')
  if (nights === 0) {
    lines.push('- 本周期没有睡眠记录。睡眠是本插件的第一优先级指标，建议先连续记 7 晚。')
  } else {
    const tst = meanOf(sleepRecords.map((r) => num(r.value?.tstMin)))
    const tib = meanOf(sleepRecords.map((r) => num(r.value?.tibMin)))
    const eff = meanOf(sleepRecords.map((r) => num(r.value?.efficiency)))
    const sol = meanOf(sleepRecords.map((r) => num(r.value?.sleepOnsetMin)))
    const waso = meanOf(sleepRecords.map((r) => num(r.value?.wasoMin)))
    lines.push(`- 记录 ${nights} 晚（覆盖率 ${Math.round((nights / summary.window.days) * 100)}%）`)
    if (tst !== null) lines.push(`- 平均总睡眠时间：${(tst / 60).toFixed(1)} 小时`)
    if (tib !== null) lines.push(`- 平均卧床时间：${(tib / 60).toFixed(1)} 小时`)
    if (eff !== null) lines.push(`- 平均睡眠效率：${Math.round(eff * 100)}%`)
    if (sol !== null) lines.push(`- 平均入睡耗时：${Math.round(sol)} 分钟`)
    if (waso !== null) lines.push(`- 平均夜间觉醒：${Math.round(waso)} 分钟`)
    const prevTst = meanOf((input.previous ?? []).filter((r) => r.kind === 'sleep').map((r) => num(r.value?.tstMin)))
    if (tst !== null && prevTst !== null) {
      const delta = Math.round(tst - prevTst)
      lines.push(`- 与上一周期相比：总睡眠时间 ${delta >= 0 ? '+' : ''}${delta} 分钟/晚`)
    }
  }
  lines.push('')

  const otherSections = ['vitals', 'body', 'activity', 'intake', 'mind', 'lab', 'symptom', 'med']
  for (const section of otherSections) {
    const entries = Object.entries(summary.kinds).filter(([, value]) => value.section === section)
    if (entries.length === 0) continue
    lines.push(`## ${sectionLabel(section)}`)
    for (const [kind, value] of entries) {
      const unit = value.unit ? ` ${value.unit}` : ''
      const meanText = value.mean === null ? '' : `，均值 ${value.mean}${unit}`
      const deltaText = value.delta === undefined ? '' : `，较上周期 ${value.delta >= 0 ? '+' : ''}${value.delta}${unit}`
      lines.push(`- ${value.label}：${value.count} 条${meanText}${deltaText}`)
      lines.push(`  最近：${describeRecord(value.latest)}（${value.latest.date}）`)
    }
    lines.push('')
  }

  if (summary.flagged.length > 0) {
    lines.push('## 需要留意的读数')
    for (const entry of summary.flagged) {
      lines.push(`- ${entry.date} ${entry.kind}：${entry.summary}`)
      for (const flag of entry.flags) lines.push(`  - ${flag}`)
    }
    lines.push('')
  }

  if (nights > 0) {
    lines.push('## 睡眠中点相位')
    const midpoints = sleepRecords
      .map((r) => (typeof r.value?.midpointMin === 'number' ? r.value.midpointMin : null))
      .filter((v) => v !== null)
    if (midpoints.length >= 3) {
      const clocks = midpoints.map((m) => formatMinutes(m)).sort()
      lines.push(`- 记录中最早/最晚睡眠中点：${clocks[0]} / ${clocks[clocks.length - 1]}`)
      lines.push('- 睡眠中点漂移超过 90 分钟时，昼夜节律相位不稳定；固定起床时间优先于提前上床。')
    }
    lines.push('')
  }

  return {
    markdown: lines.join('\n'),
    summary
  }
}

/** Window for the trailing `days` ending at `end`, with the previous window loaded. */
export function windowPair(end, days) {
  const current = dateWindow(end, days)
  const previousEnd = dateWindow(current.from, 2).from
  const previous = dateWindow(previousEnd, days)
  return { current, previous }
}

function sectionLabel(section) {
  switch (section) {
    case 'vitals': return '生命体征'
    case 'body': return '身体'
    case 'activity': return '活动'
    case 'intake': return '饮食与摄入'
    case 'mind': return '情绪'
    case 'lab': return '化验'
    case 'symptom': return '症状'
    case 'med': return '用药'
    default: return section
  }
}

/** The one number that represents a record in a trend line. */
function primaryValue(kind, record) {
  const value = record?.value ?? {}
  switch (kind) {
    case 'weight': return num(value.kg)
    case 'blood_pressure': return num(value.systolic)
    case 'heart_rate': return num(value.bpm)
    case 'temperature': return num(value.celsius)
    case 'glucose': return num(value.mmol)
    case 'steps': return num(value.count)
    case 'exercise': return num(value.minutes)
    case 'sleep': return num(value.tstMin)
    case 'mood': return num(value.score)
    case 'symptom': return num(value.severity)
    default: return null
  }
}

function numericSeries(kind, records) {
  const out = []
  for (const record of records) {
    const value = primaryValue(kind, record)
    if (value !== null) out.push({ date: record.date, value: round(value) })
  }
  return out
}

function meanOf(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (usable.length === 0) return null
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length
  return Math.round(mean * 100) / 100
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function round(value) {
  return value === null ? null : Math.round(value * 100) / 100
}
