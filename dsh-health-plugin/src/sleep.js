/**
 * Sleep arithmetic: the derived numbers a sleep diary exists to produce.
 *
 * These are computed here rather than asked of the model because every CBT-I
 * decision downstream depends on them, and a model that does date arithmetic
 * in its head will eventually get sleep efficiency wrong.
 *
 * Units: durations are minutes, clocks are minutes after local midnight on the
 * **wake** date unless documented otherwise.
 */
import { formatMinutes, parseClock } from './clock.js'

/** A night is implausible below this; above it we assume a data-entry slip. */
export const MIN_PLAUSIBLE_TIB = 60
export const MAX_PLAUSIBLE_TIB = 24 * 60

/**
 * Time in bed in minutes, treating `bedtime` on the wake date and rolling a
 * bedtime that lands after the wake clock back to the previous evening.
 *
 * @param {number} bedMin minute-of-day for getting into bed
 * @param {number} outOfBedMin minute-of-day for getting out of bed
 */
export function timeInBedMinutes(bedMin, outOfBedMin) {
  let span = outOfBedMin - bedMin
  if (span <= 0) span += 1440
  return span
}

/**
 * Normalize one night's raw diary entry.
 *
 * @param {object} input
 * @param {string} input.bedtime `HH:MM`
 * @param {string} [input.finalWake] `HH:MM`
 * @param {string} [input.outOfBed] `HH:MM`
 * @param {number} [input.sleepOnsetMin] sleep latency (SOL)
 * @param {number} [input.wasoMin] wake after sleep onset
 * @param {number} [input.awakeFinalMin] time awake after final wake, before rising
 * @returns {object} normalized night with derived metrics
 */
export function computeNight(input) {
  const bedMin = parseClock(input.bedtime)
  const outOfBedMin = input.outOfBed !== undefined ? parseClock(input.outOfBed) : undefined
  const finalWakeMin = input.finalWake !== undefined
    ? parseClock(input.finalWake)
    : outOfBedMin
  if (outOfBedMin === undefined && finalWakeMin === undefined) {
    throw new TypeError('a sleep entry needs outOfBed (preferred) or finalWake')
  }

  const sol = numberOr(input.sleepOnsetMin, 0, 'sleepOnsetMin')
  const waso = numberOr(input.wasoMin, 0, 'wasoMin')

  // The diary's "time in bed" is the full interval from lights-out to rising.
  const tib = timeInBedMinutes(bedMin, outOfBedMin ?? finalWakeMin)
  // Awake in bed after the final awakening, before actually getting up.
  const awakeFinal = input.awakeFinalMin !== undefined
    ? numberOr(input.awakeFinalMin, 0, 'awakeFinalMin')
    : Math.max(0, (outOfBedMin ?? finalWakeMin) - finalWakeMin)

  const tst = Math.max(0, tib - sol - waso - awakeFinal)
  const efficiency = tib > 0 ? tst / tib : 0
  const midpoint = midSleepMinutes(bedMin, sol, tst)
  const sleepEnd = bedMin + sol + tst

  const warnings = []
  if (tib < MIN_PLAUSIBLE_TIB) warnings.push(`time in bed ${tib} min looks too short to be a night`)
  if (tib > MAX_PLAUSIBLE_TIB) warnings.push(`time in bed ${tib} min exceeds 24 h`)
  if (sol + waso + awakeFinal > tib) warnings.push('awake time exceeds time in bed; check the entries')

  return {
    bedMin,
    outOfBedMin: outOfBedMin ?? finalWakeMin,
    finalWakeMin,
    sleepOnsetMin: sol,
    wasoMin: waso,
    awakeFinalMin: awakeFinal,
    tibMin: tib,
    tstMin: tst,
    efficiency,
    midpointMin: midpoint,
    sleepEndMin: sleepEnd,
    bedClock: formatMinutes(bedMin),
    outOfBedClock: formatMinutes(outOfBedMin ?? finalWakeMin),
    tstClock: formatMinutes(tst),
    warnings
  }
}

/** Clock position of the middle of actual sleep, in minutes after midnight. */
export function midSleepMinutes(bedMin, sleepOnsetMin, tstMin) {
  return bedMin + sleepOnsetMin + tstMin / 2
}

/**
 * Minutes of clock drift on a circular 24 h dial, signed and shortest-path.
 * Used for midpoint-of-sleep phase shifts, where 23:50 -> 00:10 is +20 min.
 */
export function circularClockDiff(aMin, bMin) {
  let diff = ((bMin - aMin) % 1440 + 1440) % 1440
  if (diff > 720) diff -= 1440
  return diff
}

/**
 * Age-adjusted sleep need in minutes. These are population reference ranges,
 * not personal prescriptions: the search range for an individual is narrow but
 * the midpoint is a starting hypothesis to be revised against their own data.
 *
 * @param {number} [age]
 */
export function sleepNeedMinutes(age) {
  if (typeof age === 'number' && Number.isFinite(age)) {
    if (age >= 65) return 7.5 * 60
    if (age >= 18) return 8 * 60
    if (age >= 14) return 8.5 * 60
    if (age >= 6) return 10 * 60
  }
  return 8 * 60
}

/**
 * Cumulative sleep debt over a set of nights, in minutes.
 *
 * Only shortfall counts: sleeping extra on one night does not repay another.
 * A single night's contribution is capped so one 4-hour night cannot make the
 * week look catastrophic, and nights without data contribute nothing.
 *
 * @param {readonly object[]} nights entries carrying `tstMin` and `date`
 * @param {number} needMin nightly need
 * @param {{ capPerNight?: number }} [options]
 */
export function sleepDebt(nights, needMin, options = {}) {
  const cap = options.capPerNight ?? 4 * 60
  let total = 0
  let counted = 0
  let worst = null
  for (const night of nights) {
    if (typeof night?.tstMin !== 'number') continue
    counted++
    const shortfall = Math.min(cap, Math.max(0, needMin - night.tstMin))
    total += shortfall
    if (worst === null || shortfall > worst.shortfallMin) {
      worst = { date: night.date, shortfallMin: shortfall }
    }
  }
  return { debtMin: Math.round(total), nightsCounted: counted, worstNight: worst }
}

/** Mean of the finite numbers, or null when there are none. */
export function mean(values) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (usable.length === 0) return null
  return usable.reduce((a, b) => a + b, 0) / usable.length
}

/**
 * Linear-interpolation percentile over a copy of the input. Returns null for
 * an empty set. Used for phase drift (p10/p90 midpoints), not for diagnosis.
 */
export function percentile(values, p) {
  const usable = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (usable.length === 0) return null
  if (usable.length === 1) return usable[0]
  const rank = (p / 100) * (usable.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return usable[lo]
  return usable[lo] + (usable[hi] - usable[lo]) * (rank - lo)
}

/** Pearson correlation, or null when it is undefined (constant input, n < 3). */
export function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  const n = pairs.length
  if (n < 3) return null
  const mx = pairs.reduce((a, [x]) => a + x, 0) / n
  const my = pairs.reduce((a, [, y]) => a + y, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (const [x, y] of pairs) {
    const ax = x - mx
    const ay = y - my
    num += ax * ay
    dx += ax * ax
    dy += ay * ay
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}

function numberOr(value, fallback, field) {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new TypeError(`${field} must be a non-negative number`)
  return n
}
