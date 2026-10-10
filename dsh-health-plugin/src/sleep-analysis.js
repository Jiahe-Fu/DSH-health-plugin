/**
 * Sleep analysis and CBT-I planning.
 *
 * This module is the reason the plugin exists. Everything a generic assistant
 * gets wrong about insomnia lives here:
 *
 * 1. Sleep hygiene alone does not treat chronic insomnia. The active
 *    ingredients are sleep restriction and stimulus control, so the plan we
 *    emit changes the sleep *window*, not just the advice.
 * 2. The anchor is the fixed **wake** time. People intuitively try to fix
 *    bedtime; that is backwards.
 * 3. Sleep efficiency (TST / TIB) drives the weekly adjustment, and the window
 *    is never compressed below a hard floor.
 * 4. Behavioural sleep restriction is contraindicated in a specific set of
 *    conditions, so the plan refuses instead of guessing.
 */
import { daysBetween, formatMinutes } from './clock.js'
import { circularClockDiff, mean, percentile, sleepDebt, sleepNeedMinutes } from './sleep.js'

/** Shortest-path clock difference, tolerant of null input. */
function circularClockDiffSafe(a, b) {
  if (a === null || b === null) return null
  return Math.abs(circularClockDiff(a, b))
}

/** Minimal time in bed we will ever prescribe. */
export const MIN_PRESCRIBED_TIB_MIN = 5 * 60
/** Largest single-step compression, to keep sleep pressure humane. */
export const MAX_COMPRESSION_STEP_MIN = 30
/** Above this efficiency the window may grow. */
export const GROW_THRESHOLD = 0.90
/** Below this efficiency the window must shrink. */
export const SHRINK_THRESHOLD = 0.85

export const CONTRAINDICATIONS = [
  { id: 'bipolar', match: /双相|躁狂|bipolar|mania/i, label: '双相情感障碍' },
  { id: 'epilepsy', match: /癫痫|惊厥|epilep|seizure/i, label: '癫痫或惊厥性疾病' },
  { id: 'pregnancy', match: /妊娠|怀孕|孕|pregnan/i, label: '妊娠期' },
  { id: 'safety_critical', match: /司机|驾驶|飞行|高空|机械|吊装|driv|pilot|operat/i, label: '需要高度警觉的职业' },
  { id: 'narcolepsy', match: /发作性睡病|猝倒|narcolep|cataplex/i, label: '发作性睡病样症状' },
  { id: 'severe_mood', match: /自杀|自伤|重度抑郁|suicid|self-harm/i, label: '严重情绪问题或自杀意念' }
]

/** Red-flag finding that must stop the coaching flow and route to care. */
export const SLEEP_RED_FLAGS = [
  { id: 'apnea', match: /打鼾|呼吸暂停|憋醒|窒息|apnea|snor|gasp/i, label: '疑似睡眠呼吸暂停（打鼾伴呼吸暂停/憋醒），需要睡眠监测而非行为干预' },
  { id: 'restless_legs', match: /不宁腿|腿难受|想动腿|restless leg|urge to move/i, label: '疑似不宁腿综合征，需要医学评估' },
  { id: 'suicidal', match: /自杀|不想活|自伤|suicid|self-harm/i, label: '存在自伤/自杀风险：请立即联系信任的人、精神科急诊或拨打 12356/120' },
  { id: 'psychosis', match: /幻觉|妄想|精神错乱|hallucinat|delusion/i, label: '疑似精神症状，需要精神科评估' },
  { id: 'cataplexy', match: /猝倒|笑软|突然瘫|cataplex/i, label: '猝倒提示发作性睡病可能，需要睡眠专科评估' }
]

/**
 * Normalize one sleep record into the flat night shape the analyzer uses.
 * Records written by an older version, or partly filled by hand, still count.
 *
 * @param {object} record a stored `sleep` record
 */
export function nightFromRecord(record) {
  const value = record?.value ?? {}
  const tibMin = numberOr(value.tibMin, null)
  const tstMin = numberOr(value.tstMin, null)
  const efficiency = numberOr(value.efficiency, null)
    ?? (tibMin && tstMin !== null ? tstMin / tibMin : null)
  return {
    id: record?.id,
    date: record?.date,
    bedtime: value.bedClock ?? value.bedtime,
    outOfBed: value.outOfBedClock ?? value.outOfBed,
    bedMin: numberOr(value.bedMin, null),
    outOfBedMin: numberOr(value.outOfBedMin, null),
    sleepOnsetMin: numberOr(value.sleepOnsetMin, null),
    wasoMin: numberOr(value.wasoMin, null),
    awakeFinalMin: numberOr(value.awakeFinalMin, null),
    tibMin,
    tstMin,
    efficiency,
    midpointMin: numberOr(value.midpointMin, null),
    quality: numberOr(value.quality, null),
    caffeine: value.caffeine ?? null,
    alcohol: value.alcohol ?? null,
    screensOff: value.screensOff ?? null,
    naps: value.naps ?? null,
    note: record?.note
  }
}

/**
 * Summarize a set of nights.
 *
 * @param {readonly object[]} nights output of `nightFromRecord`
 * @param {{ age?: number }} [options]
 */
export function analyzeNights(nights, options = {}) {
  const dated = nights
    .filter((night) => typeof night.date === 'string')
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
  const needMin = sleepNeedMinutes(options.age)

  const solMean = mean(dated.map((n) => n.sleepOnsetMin))
  const wasoMean = mean(dated.map((n) => n.wasoMin))
  const tstMean = mean(dated.map((n) => n.tstMin))
  const tibMean = mean(dated.map((n) => n.tibMin))
  const effMean = mean(dated.map((n) => n.efficiency))
  const qualityMean = mean(dated.map((n) => n.quality))
  const midpointMean = mean(dated.map((n) => n.midpointMin))

  const debt = sleepDebt(dated, needMin)

  // Phase drift: the spread of sleep midpoints is what a late/irregular
  // schedule looks like numerically. 20-40 min of spread is unremarkable;
  // beyond that the circadian anchor is moving, not just varying.
  const midpoints = dated.map((n) => n.midpointMin).filter((v) => v !== null)
  const p10 = percentile(midpoints, 10)
  const p90 = percentile(midpoints, 90)
  const spreadMin = p10 !== null && p90 !== null ? circularClockDiffSafe(p10, p90) : null

  const onsetVsCaffeine = correlate(dated, (n) => caffeineLateMinutes(n), (n) => n.sleepOnsetMin)
  const onsetVsAlcohol = correlate(dated, (n) => alcoholLateMinutes(n), (n) => n.sleepOnsetMin)
  const onsetVsScreens = correlate(dated, (n) => screensLeadMinutes(n), (n) => n.sleepOnsetMin)
  const tstVsQuality = correlate(dated, (n) => n.tstMin, (n) => n.quality)

  const insomniaScreen = screenInsomnia(dated)

  return {
    nights: dated.length,
    from: dated[0]?.date ?? null,
    to: dated[dated.length - 1]?.date ?? null,
    needMin,
    debt,
    mean: {
      solMin: round(solMean),
      wasoMin: round(wasoMean),
      tstMin: round(tstMean),
      tibMin: round(tibMean),
      efficiency: effMean === null ? null : Math.round(effMean * 1000) / 1000,
      quality: qualityMean === null ? null : Math.round(qualityMean * 10) / 10,
      midnightSleep: midpointMean === null ? null : formatMinutes(midpointMean)
    },
    phase: {
      midpointMeanClock: midpointMean === null ? null : formatMinutes(midpointMean),
      spreadMin,
      irregular: spreadMin !== null && spreadMin > 90
    },
    correlations: {
      caffeineToOnset: onsetVsCaffeine,
      alcoholToOnset: onsetVsAlcohol,
      screensToOnset: onsetVsScreens,
      tstToQuality: tstVsQuality
    },
    insomniaScreen,
    warnings: buildWarnings({ dated, solMean, wasoMean, tstMean, needMin, spreadMin, insomniaScreen })
  }
}

/**
 * A conservative screen for the insomnia pattern, deliberately not a diagnosis.
 * Uses the ICSD-style shape: trouble falling/staying asleep, >=3 nights a week,
 * >=3 months, with daytime consequences.
 */
export function screenInsomnia(nights) {
  const withEfficiency = nights.filter((n) => typeof n.efficiency === 'number')
  const withOnset = nights.filter((n) => typeof n.sleepOnsetMin === 'number')
  const poor = withEfficiency.filter((n) => n.efficiency < 0.85)
  const slowOnset = withOnset.filter((n) => n.sleepOnsetMin >= 30)
  const shortOrBroken = nights.filter((n) => (n.tstMin ?? Infinity) < 6.5 * 60 || (n.wasoMin ?? 0) >= 30)

  const spanDays = nights.length >= 2
    ? daysBetween(nights[0].date, nights[nights.length - 1].date) + 1
    : nights.length
  const affectedNights = new Set([...poor, ...slowOnset, ...shortOrBroken].map((n) => n.date)).size
  const perWeek = spanDays > 0 ? (affectedNights / spanDays) * 7 : 0

  const frequencyMet = perWeek >= 3
  const durationMet = spanDays >= 90
  const patternMet = affectedNights >= 3

  let label = 'insufficient-data'
  if (nights.length < 3) label = 'insufficient-data'
  else if (frequencyMet && durationMet) label = 'chronic-pattern'
  else if (frequencyMet) label = 'subacute-pattern'
  else if (patternMet) label = 'mild-pattern'
  else label = 'no-clear-pattern'

  return {
    label,
    affectedNights,
    spanDays,
    nightsPerWeek: Math.round(perWeek * 10) / 10,
    frequencyMet,
    durationMet,
    note: durationMet
      ? '记录跨度已达 3 个月，可讨论慢性失眠的 CBT-I 方案。'
      : `记录跨度 ${spanDays} 天；慢性失眠需要至少 3 个月、每周 ≥3 次的模式，暂不能判定。`
  }
}

/**
 * Build the CBT-I style plan.
 *
 * `sleepWindow` is what the user actually changes: a fixed rising time plus a
 * bedtime derived from the prescribed time in bed.
 *
 * @param {{ nights: readonly object[], profile?: object, today?: string }} input
 */
export function planSleepWindow(input) {
  const nights = (input.nights ?? []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const profile = input.profile ?? {}
  const contraindications = detectContraindications(profile)
  const redFlags = detectRedFlags([
    ...nights.map((n) => n.note ?? ''),
    ...Object.values(profile.conditions ?? {}).flatMap((v) => (Array.isArray(v) ? v : [v])),
    profile.occupation ?? '',
    profile.goals ?? ''
  ].join(' '))

  // Anchor: an explicit target wake wins; otherwise infer the modal rising time.
  const explicitWake = typeof profile.targetWake === 'string' ? profile.targetWake : null
  const observedWake = modeClock(nights.map((n) => n.outOfBedMin))
  const targetWakeMin = explicitWake !== null
    ? clockOf(explicitWake)
    : (observedWake ?? 7 * 60)

  const recent = nights.slice(-14).filter((n) => typeof n.efficiency === 'number' && typeof n.tibMin === 'number')
  const recentEfficiency = mean(recent.map((n) => n.efficiency))
  const recentTib = mean(recent.map((n) => n.tibMin))

  const refusals = []
  for (const flag of redFlags) refusals.push({ code: `red-flag:${flag.id}`, message: flag.label })
  for (const item of contraindications) {
    refusals.push({ code: `contraindication:${item.id}`, message: `${item.label}：睡眠限制疗法不适用，请由医生评估` })
  }

  const dataQuality = nights.length >= 7 ? 'sufficient' : nights.length >= 3 ? 'thin' : 'insufficient'
  if (dataQuality !== 'sufficient') {
    refusals.push({
      code: 'data:insufficient',
      message: dataQuality === 'insufficient'
        ? '睡眠日记不足 3 晚：先连续记录至少 7 晚（含周末），再调整卧床时间。'
        : '睡眠日记不足 7 晚：本次只给固定起床时间与记录要求，暂不压缩卧床窗口。'
    })
  }

  const currentTib = recentTib !== null ? Math.round(recentTib) : Math.max(MIN_PRESCRIBED_TIB_MIN, sleepNeedMinutes(ageOf(profile)) + 30)
  let prescribedTib = currentTib
  let adjustment = 'none'
  let reason

  const canAdjustWindow = dataQuality === 'sufficient' && refusals.every((r) => !r.code.startsWith('red-flag') && !r.code.startsWith('contraindication'))

  if (canAdjustWindow) {
    if (recentEfficiency !== null && recentEfficiency >= GROW_THRESHOLD) {
      prescribedTib = Math.min(currentTib + 20, currentTib + MAX_COMPRESSION_STEP_MIN)
      adjustment = 'grow'
      reason = `近 14 晚睡眠效率 ${pct(recentEfficiency)} ≥ 90%，可以每 3–5 天把卧床时间前移 15–30 分钟。`
    } else if (recentEfficiency !== null && recentEfficiency < SHRINK_THRESHOLD) {
      prescribedTib = Math.max(MIN_PRESCRIBED_TIB_MIN, currentTib - MAX_COMPRESSION_STEP_MIN)
      adjustment = prescribedTib < currentTib ? 'shrink' : 'hold'
      reason = prescribedTib < currentTib
        ? `近 14 晚睡眠效率 ${pct(recentEfficiency)} < 85%，本周把卧床时间减少 30 分钟（不低于 5 小时）以重建睡眠压力。`
        : `睡眠效率偏低，但卧床时间已到 5 小时下限，不再压缩；改为严格固定起床时间并复查。`
    } else {
      reason = `近 14 晚睡眠效率 ${recentEfficiency === null ? '未知' : pct(recentEfficiency)} 落在 85%–90%，本周维持现有窗口不变。`
    }
  } else {
    reason = '本周不调整卧床窗口：先满足安全前提与记录要求。'
  }

  // Bedtime is derived so that the window length equals the prescribed TIB.
  const bedMin = (targetWakeMin - prescribedTib + 1440) % 1440

  return {
    ok: refusals.length === 0 || canAdjustWindow,
    safety: {
      ok: refusals.length === 0,
      refusals,
      redFlags,
      contraindications
    },
    dataQuality,
    nightsUsed: nights.length,
    current: {
      tibMin: currentTib,
      tibClock: formatMinutes(currentTib),
      efficiency: recentEfficiency === null ? null : Math.round(recentEfficiency * 1000) / 1000,
      wakeClock: formatMinutes(targetWakeMin)
    },
    plan: {
      adjustment,
      reason,
      targetWake: formatMinutes(targetWakeMin),
      targetBed: formatMinutes(bedMin),
      prescribedTibMin: prescribedTib,
      prescribedTibClock: formatMinutes(prescribedTib),
      reviewInDays: 7,
      rules: [
        '起床时间固定，包括周末，误差不超过 30 分钟。',
        '到点没睡着（约 20 分钟）就离开床，做安静的事，有困意再回床。床只用于睡觉。',
        '白天不补觉；若必须小睡，不超过 20 分钟且不晚于 15:00。',
        '记录每晚卧床、入睡耗时、夜醒时长与起床时间，一周后按睡眠效率再调。'
      ]
    },
    safetyNotice: '睡眠限制疗法有禁忌人群，且调整期间白天嗜睡会加重。若职业需要驾驶或操作机械，调整期间不要上岗。'
  }
}

/** Pull a plausible age out of a profile's `birthYear`. */
export function ageOf(profile, now = new Date()) {
  const birthYear = Number(profile?.birthYear)
  if (!Number.isFinite(birthYear) || birthYear < 1900) return undefined
  return Math.max(0, now.getFullYear() - birthYear)
}

/** Contraindications found in a profile's free-text fields. */
export function detectContraindications(profile) {
  const haystack = [
    ...(Array.isArray(profile?.conditions) ? profile.conditions : []),
    ...(Array.isArray(profile?.medications) ? profile.medications : []),
    profile?.occupation ?? '',
    profile?.notes ?? '',
    profile?.shiftWork === true ? '轮班' : '',
    profile?.safetyCritical === true ? '驾驶 机械操作' : ''
  ].join(' ')
  const found = []
  for (const item of CONTRAINDICATIONS) {
    if (item.match.test(haystack)) found.push(item)
  }
  if (profile?.safetyCritical === true && !found.some((f) => f.id === 'safety_critical')) {
    found.push(CONTRAINDICATIONS.find((c) => c.id === 'safety_critical'))
  }
  return found
}

/** Red-flag findings anywhere in the supplied text. */
export function detectRedFlags(text) {
  const found = []
  for (const item of SLEEP_RED_FLAGS) {
    if (item.match.test(text)) found.push(item)
  }
  return found
}

function buildWarnings({ dated, solMean, wasoMean, tstMean, needMin, spreadMin, insomniaScreen }) {
  const out = []
  if (dated.length < 7) out.push(`只有 ${dated.length} 晚记录，趋势结论不可靠；先凑够连续 7 晚。`)
  if (tstMean !== null && tstMean < needMin - 60) {
    out.push(`平均睡眠 ${(tstMean / 60).toFixed(1)} 小时，低于同龄参考需求 ${(needMin / 60).toFixed(1)} 小时约 ${Math.round((needMin - tstMean))} 分钟。`)
  }
  if (solMean !== null && solMean >= 30 && wasoMean !== null && wasoMean >= 30) {
    out.push('入睡困难与夜间觉醒同时存在：这是典型的"入睡与维持"双相问题，CBT-I 对你更可能有效。')
  } else if (solMean !== null && solMean >= 30) {
    out.push('以入睡困难为主：优先刺激控制（床只用于睡觉）与固定起床时间。')
  } else if (wasoMean !== null && wasoMean >= 30) {
    out.push('以夜间觉醒为主：需要先排除呼吸暂停、不宁腿、夜尿与疼痛等继发原因。')
  }
  if (spreadMin !== null && spreadMin > 90) {
    out.push(`睡眠中点波动约 ${spreadMin} 分钟，昼夜节律相位不稳定；固定起床时间比提前上床更重要。`)
  }
  if (insomniaScreen.label === 'chronic-pattern') {
    out.push('记录符合慢性失眠的时间与频率要求，应把 CBT-I 作为一线方案，而不是先考虑安眠药。')
  }
  return out
}

/** Correlation helper that keeps its sample size visible to the reader. */
function correlate(nights, ofX, ofY) {
  const xs = []
  const ys = []
  for (const night of nights) {
    const x = ofX(night)
    const y = ofY(night)
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
      xs.push(x)
      ys.push(y)
    }
  }
  if (xs.length < 4) return { r: null, n: xs.length, note: '样本不足 4 晚，不做相关性判断' }
  const r = pearsonLocal(xs, ys)
  if (r === null) return { r: null, n: xs.length, note: '数据无变化，无法计算相关性' }
  return {
    r: Math.round(r * 100) / 100,
    n: xs.length,
    note: Math.abs(r) < 0.3 ? '相关性弱，不足以下结论' : (r > 0 ? '呈正相关' : '呈负相关')
  }
}

function pearsonLocal(xs, ys) {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const ax = xs[i] - mx
    const ay = ys[i] - my
    num += ax * ay
    dx += ax * ax
    dy += ay * ay
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}

/** Minutes from the last caffeinated drink to bedtime; null when unrecorded. */
function caffeineLateMinutes(night) {
  const list = toList(night.caffeine)
  if (list.length === 0) return null
  let last = null
  for (const item of list) {
    const at = item?.at
    if (typeof at !== 'string') continue
    const minutes = clockOf(at)
    if (minutes === null || night.bedMin === null) continue
    const before = (night.bedMin - minutes + 1440) % 1440
    // Only count intake in the 12 h before bed.
    if (before <= 720 && (last === null || before < last)) last = before
  }
  return last
}

function alcoholLateMinutes(night) {
  const list = toList(night.alcohol)
  if (list.length === 0) return null
  let last = null
  for (const item of list) {
    const at = item?.at
    if (typeof at !== 'string') continue
    const minutes = clockOf(at)
    if (minutes === null || night.bedMin === null) continue
    const before = (night.bedMin - minutes + 1440) % 1440
    if (before <= 720 && (last === null || before < last)) last = before
  }
  return last
}

/** Minutes between turning screens off and getting into bed. */
function screensLeadMinutes(night) {
  if (typeof night.screensOff !== 'string' || night.bedMin === null) return null
  const minutes = clockOf(night.screensOff)
  if (minutes === null) return null
  const lead = (night.bedMin - minutes + 1440) % 1440
  return lead <= 720 ? lead : null
}

function toList(value) {
  if (value === null || value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

/** The most common clock time in a list, rounded to the nearest 10 minutes. */
function modeClock(minutes) {
  const usable = minutes.filter((m) => typeof m === 'number' && Number.isFinite(m))
  if (usable.length === 0) return null
  const buckets = new Map()
  for (const m of usable) {
    const bucket = Math.round(m / 10) * 10
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  let best = null
  let bestCount = -1
  for (const [bucket, count] of buckets) {
    if (count > bestCount) {
      best = bucket
      bestCount = count
    }
  }
  return best
}

function clockOf(value) {
  if (typeof value !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function round(value) {
  return value === null ? null : Math.round(value)
}

function pct(value) {
  return `${Math.round(value * 100)}%`
}
