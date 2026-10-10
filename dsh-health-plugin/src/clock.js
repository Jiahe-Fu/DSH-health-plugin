/**
 * Local wall-clock helpers for the health plugin.
 *
 * Everything here is deliberately timezone-naive: a sleep diary entry says
 * "I got into bed at 23:40" in the user's own local clock, and that is what we
 * store. Dates are `YYYY-MM-DD` strings, times are `HH:MM` strings.
 */

/** Pad a number to two digits. */
function pad2(n) {
  return String(n).padStart(2, '0')
}

/** `HH:MM` for a minute-of-day value, wrapping into [0, 1440). */
export function formatMinutes(minutes) {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`
}

/** Minute-of-day for an `HH:MM` string. Throws on anything else. */
export function parseClock(value) {
  if (typeof value !== 'string') throw new TypeError(`clock must be a string, got ${typeof value}`)
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) throw new TypeError(`clock must look like HH:MM, got ${JSON.stringify(value)}`)
  const hours = Number(m[1])
  const mins = Number(m[2])
  if (hours > 23) throw new TypeError(`clock hour out of range: ${value}`)
  if (mins > 59) throw new TypeError(`clock minute out of range: ${value}`)
  return hours * 60 + mins
}

/** Local `YYYY-MM-DD` for a Date. */
export function toDateString(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Today as a local `YYYY-MM-DD`. */
export function today() {
  return toDateString(new Date())
}

/** True when the string is a real calendar date in `YYYY-MM-DD` form. */
export function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const probe = new Date(y, m - 1, d)
  return probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d
}

/** Shift a `YYYY-MM-DD` by whole days. */
export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number)
  const probe = new Date(y, m - 1, d + days)
  return toDateString(probe)
}

/** Whole days from `a` to `b` (negative when `b` precedes `a`). */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  const MS_PER_DAY = 86400000
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / MS_PER_DAY)
}

/** The `YYYY-MM-DD` window covering the `count` days ending at `end` (inclusive). */
export function dateWindow(end, count) {
  const last = Math.max(1, Math.floor(count))
  return { from: addDays(end, -(last - 1)), to: end, days: last }
}
