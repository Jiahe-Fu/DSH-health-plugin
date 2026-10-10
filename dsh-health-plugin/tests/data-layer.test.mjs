/**
 * Data-layer tests: the arithmetic that every CBT-I decision depends on.
 *
 * Run with the bundled Node runtime:
 *   node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { addDays, dateWindow, daysBetween, formatMinutes, isDateString, parseClock } from '../src/clock.js'
import { circularClockDiff, computeNight, sleepDebt, sleepNeedMinutes } from '../src/sleep.js'
import { buildRecord, describeRecord, flagRecord, METRIC_KINDS } from '../src/metrics.js'
import { HealthStore } from '../src/store.js'
import { analyzeNights, nightFromRecord, planSleepWindow, screenInsomnia } from '../src/sleep-analysis.js'
import { buildReport, windowPair } from '../src/report.js'

// ---------------------------------------------------------------- clock ----

test('clock: parse and format round-trip', () => {
  assert.equal(parseClock('23:40'), 1420)
  assert.equal(parseClock('0:05'), 5)
  assert.equal(formatMinutes(1420), '23:40')
  assert.equal(formatMinutes(5), '00:05')
})

test('clock: rejects malformed times', () => {
  assert.throws(() => parseClock('24:00'), /hour out of range/)
  assert.throws(() => parseClock('12:60'), /minute out of range/)
  assert.throws(() => parseClock('noon'), /HH:MM/)
  assert.throws(() => parseClock(1230), /must be a string/)
})

test('clock: date arithmetic across month and year boundaries', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(daysBetween('2026-01-01', '2026-03-01'), 59)
  assert.equal(isDateString('2026-02-30'), false)
  assert.equal(isDateString('2026-02-28'), true)
})

test('clock: dateWindow spans the trailing N days inclusive', () => {
  const window = dateWindow('2026-03-10', 7)
  assert.deepEqual(window, { from: '2026-03-04', to: '2026-03-10', days: 7 })
})

// ---------------------------------------------------------------- sleep ----

test('sleep: a normal night produces the expected derived numbers', () => {
  const night = computeNight({
    bedtime: '23:00',
    finalWake: '06:30',
    outOfBed: '06:40',
    sleepOnsetMin: 20,
    wasoMin: 30
  })
  // 23:00 -> 06:40 is 460 minutes in bed.
  assert.equal(night.tibMin, 460)
  // 460 - 20 (SOL) - 30 (WASO) - 10 (awake after final wake) = 400.
  assert.equal(night.tstMin, 400)
  assert.equal(night.awakeFinalMin, 10)
  assert.equal(Math.round(night.efficiency * 100), 87)
  assert.equal(night.bedClock, '23:00')
  assert.equal(night.outOfBedClock, '06:40')
  assert.deepEqual(night.warnings, [])
})

test('sleep: a bedtime after midnight stays on the wake date', () => {
  const night = computeNight({ bedtime: '01:30', outOfBed: '08:00', sleepOnsetMin: 45, wasoMin: 15 })
  assert.equal(night.tibMin, 390)
  assert.equal(night.tstMin, 330)
})

test('sleep: time in bed crossing midnight is handled without a negative span', () => {
  const night = computeNight({ bedtime: '23:30', outOfBed: '00:15' })
  assert.equal(night.tibMin, 45)
  assert.ok(night.warnings.some((w) => w.includes('too short')))
})

test('sleep: outOfBed is optional when finalWake is given', () => {
  const night = computeNight({ bedtime: '23:00', finalWake: '07:00' })
  assert.equal(night.tibMin, 480)
  assert.equal(night.awakeFinalMin, 0)
})

test('sleep: a night without any wake time is rejected', () => {
  assert.throws(() => computeNight({ bedtime: '23:00' }), /outOfBed.*or finalWake/)
})

test('sleep: circular clock difference takes the shortest path', () => {
  assert.equal(circularClockDiff(23 * 60 + 50, 20), 30)
  assert.equal(circularClockDiff(20, 23 * 60 + 50), -30)
  assert.equal(circularClockDiff(3 * 60, 4 * 60), 60)
})

test('sleep: need rises as age falls and debts only count shortfall', () => {
  assert.ok(sleepNeedMinutes(70) < sleepNeedMinutes(30))
  assert.ok(sleepNeedMinutes(30) < sleepNeedMinutes(10))

  const nights = [
    { date: '2026-03-01', tstMin: 6 * 60 },
    { date: '2026-03-02', tstMin: 8 * 60 },
    { date: '2026-03-03', tstMin: 3 * 60 }
  ]
  const debt = sleepDebt(nights, 8 * 60)
  // 120 short on the 1st, 0 on the 2nd, capped at 240 on the 3rd.
  assert.equal(debt.debtMin, 120 + 240)
  assert.equal(debt.nightsCounted, 3)
  assert.equal(debt.worstNight.date, '2026-03-03')
})

// -------------------------------------------------------------- metrics ----

test('metrics: every catalog kind builds from its minimal arguments', () => {
  const samples = {
    sleep: { bedtime: '23:00', outOfBed: '07:00' },
    weight: { kg: 70 },
    blood_pressure: { systolic: 120, diastolic: 78 },
    heart_rate: { bpm: 62 },
    temperature: { celsius: 36.6 },
    glucose: { mmol: 5.2, context: 'fasting' },
    exercise: { activity: '跑步', minutes: 30 },
    steps: { count: 8000 },
    diet: { meal: '午餐', description: '米饭青菜' },
    mood: { mood: '平静', score: 4 },
    symptom: { name: '头痛', severity: 3 },
    medication: { name: '维生素D', dose: '1000IU' },
    menstrual: { phase: '经期' },
    lab: { item: '血红蛋白', measure: '140', unit: 'g/L' }
  }
  for (const kind of METRIC_KINDS) {
    const record = buildRecord(kind, { date: '2026-03-10', ...samples[kind] }, '2026-03-10')
    assert.equal(record.kind, kind, `${kind} should build`)
    assert.equal(record.date, '2026-03-10')
    assert.ok(record.value && typeof record.value === 'object', `${kind} needs a value object`)
    assert.equal(typeof describeRecord(record), 'string')
    assert.ok(Array.isArray(flagRecord(record)))
  }
})

test('metrics: implausible and contradictory values are refused', () => {
  assert.throws(() => buildRecord('weight', { kg: 900 }, '2026-03-10'), /above the plausible maximum/)
  assert.throws(() => buildRecord('blood_pressure', { systolic: 120, diastolic: 130 }, '2026-03-10'), /below systolic/)
  assert.throws(() => buildRecord('mood', { mood: '低落', score: 9 }, '2026-03-10'), /above the plausible maximum/)
  assert.throws(() => buildRecord('symptom', { severity: 3 }, '2026-03-10'), /name is required/)
  assert.throws(() => buildRecord('nonsense', {}, '2026-03-10'), /unknown metric kind/)
})

test('metrics: dangerous readings raise clinical flags', () => {
  const crisis = buildRecord('blood_pressure', { systolic: 190, diastolic: 125 }, '2026-03-10')
  assert.ok(flagRecord(crisis).some((f) => f.includes('立即就医')))

  const fever = buildRecord('temperature', { celsius: 39.4 }, '2026-03-10')
  assert.ok(flagRecord(fever).some((f) => f.includes('高热')))

  const normal = buildRecord('heart_rate', { bpm: 64 }, '2026-03-10')
  assert.deepEqual(flagRecord(normal), [])
})

test('metrics: sleep flags fire on a bad night', () => {
  const record = buildRecord('sleep', {
    bedtime: '23:00',
    outOfBed: '07:00',
    sleepOnsetMin: 90,
    wasoMin: 70
  }, '2026-03-10')
  const flags = flagRecord(record)
  assert.ok(flags.some((f) => f.includes('入睡潜伏期')))
  assert.ok(flags.some((f) => f.includes('夜间觉醒')))
})

// ---------------------------------------------------------------- store ----

/** Fresh, isolated store per test. */
async function withStore(run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-health-'))
  try {
    return await run(new HealthStore({ dir }), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('store: append then query round-trips through disk', async () => {
  await withStore(async (store, dir) => {
    const record = buildRecord('weight', { kg: 71.5, date: '2026-03-10' }, '2026-03-10')
    const stored = await store.append(record)
    assert.equal(typeof stored.id, 'string')
    assert.equal(stored.v, 1)

    // A fresh store must see the same data: the file is the source of truth.
    const reopened = new HealthStore({ dir })
    const found = await reopened.query({ from: '2026-03-01', to: '2026-03-31' })
    assert.equal(found.length, 1)
    assert.equal(found[0].value.kg, 71.5)

    const raw = await readFile(join(dir, 'records', '2026.jsonl'), 'utf8')
    assert.equal(raw.trim().split('\n').length, 1)
  })
})

test('store: update and delete rewrite the year file', async () => {
  await withStore(async (store, dir) => {
    const first = await store.append(buildRecord('steps', { count: 5000, date: '2026-03-10' }, '2026-03-10'))
    await store.append(buildRecord('steps', { count: 7000, date: '2026-03-11' }, '2026-03-11'))

    const updated = await store.update(first.id, { value: { count: 9000 } })
    assert.equal(updated.value.count, 9000)

    const afterUpdate = await new HealthStore({ dir }).query({ from: '2026-03-01', to: '2026-03-31' })
    assert.equal(afterUpdate.find((r) => r.id === first.id).value.count, 9000)

    assert.equal(await store.remove(first.id), true)
    assert.equal(await store.remove('does-not-exist'), false)

    const afterDelete = await new HealthStore({ dir }).query({ from: '2026-03-01', to: '2026-03-31' })
    assert.equal(afterDelete.length, 1)
  })
})

test('store: a corrupt line is skipped, not fatal', async () => {
  await withStore(async (store, dir) => {
    await store.append(buildRecord('weight', { kg: 70, date: '2026-03-10' }, '2026-03-10'))
    const path = join(dir, 'records', '2026.jsonl')
    const good = await readFile(path, 'utf8')
    await writeFile(path, `${good}{ this is not json\n${good}`, 'utf8')

    const reopened = new HealthStore({ dir })
    const found = await reopened.query({ from: '2026-03-01', to: '2026-03-31' })
    assert.equal(found.length, 2, 'both good lines survive')
    assert.equal(reopened.skippedLines().length, 1, 'the bad line is reported')
  })
})

test('store: records land in the file for their own year', async () => {
  await withStore(async (store, dir) => {
    await store.append(buildRecord('weight', { kg: 70, date: '2025-12-31' }, '2025-12-31'))
    await store.append(buildRecord('weight', { kg: 71, date: '2026-01-01' }, '2026-01-01'))
    const files = await readFile(join(dir, 'records', '2025.jsonl'), 'utf8')
    assert.ok(files.includes('2025-12-31'))
    const range = await store.query({ from: '2025-12-01', to: '2026-01-31', kinds: ['weight'] })
    assert.deepEqual(range.map((r) => r.date), ['2025-12-31', '2026-01-01'])
  })
})

test('store: 40 appends, 40 edits and 40 deletes all land', async () => {
  // On Windows a rename onto a momentarily-open file fails with EPERM rather
  // than succeeding or failing permanently, so the atomic write retries. This
  // exercises that path hard, because a delete that fails is a record the user
  // cannot get rid of.
  await withStore(async (store, dir) => {
    const ids = []
    for (let index = 0; index < 40; index++) {
      const date = addDays('2026-03-01', index)
      const stored = await store.append(buildRecord('steps', { count: 1000 + index, date }, date))
      ids.push(stored.id)
    }
    assert.equal((await store.query({ from: '2026-03-01', to: '2026-04-30' })).length, 40)

    for (const id of ids) {
      const updated = await store.update(id, { value: { count: 42 } })
      assert.notEqual(updated, null, `update ${id} must succeed`)
    }

    for (const id of ids) {
      assert.equal(await store.remove(id), true, `remove ${id} must succeed`)
    }

    assert.equal((await store.query({ from: '2026-03-01', to: '2026-04-30' })).length, 0)
    const raw = await readFile(join(dir, 'records', '2026.jsonl'), 'utf8')
    assert.equal(raw.trim(), '')
  })
})

test('store: profile merge preserves unknown fields and stamps timestamps', async () => {
  await withStore(async (store, dir) => {
    assert.equal(await store.readProfile(), null)
    await store.updateProfile({ heightCm: 175, birthYear: 1990, targetWake: '06:40', customField: 'keep me' })
    const merged = await store.updateProfile({ conditions: ['高血压'] })
    assert.equal(merged.heightCm, 175)
    assert.equal(merged.customField, 'keep me')
    assert.deepEqual(merged.conditions, ['高血压'])
    assert.equal(merged.v, 1)
    assert.ok(merged.createdAt)
    assert.ok(merged.updatedAt)

    const reopened = await new HealthStore({ dir }).readProfile()
    assert.equal(reopened.targetWake, '06:40')
  })
})

test('store: a corrupt profile is reported rather than thrown', async () => {
  await withStore(async (store, dir) => {
    await mkdir(join(dir), { recursive: true })
    await writeFile(join(dir, 'profile.json'), '{ not json', 'utf8')
    const profile = await new HealthStore({ dir }).readProfile()
    assert.equal(profile.corrupt, true)
  })
})

// ------------------------------------------------------ sleep analysis ----

/** Build `count` synthetic sleep records with controllable properties. */
function synthesizeNights(count, make) {
  const records = []
  for (let i = 0; i < count; i++) {
    const date = addDays('2026-03-01', i)
    records.push(buildRecord('sleep', { date, ...make(i) }, date))
  }
  return records
}

test('analysis: efficient nights with a late caffeine habit', () => {
  // Bedtime 23:30, in bed 8 h, 15 min to fall asleep, 20 min awake at night.
  const records = synthesizeNights(10, (i) => ({
    bedtime: '23:30',
    outOfBed: '07:30',
    sleepOnsetMin: 15 + (i % 3) * 5,
    wasoMin: 20,
    caffeine: [{ at: '18:00', mg: 120 }],
    quality: 4
  }))
  const analysis = analyzeNights(records.map(nightFromRecord), { age: 30 })

  assert.equal(analysis.nights, 10)
  assert.equal(analysis.mean.tibMin, 480)
  assert.equal(analysis.mean.solMin, 20)
  assert.ok(analysis.mean.efficiency > 0.85)
  assert.equal(analysis.insomniaScreen.label, 'no-clear-pattern')
  assert.equal(analysis.correlations.caffeineToOnset.n, 10)
  // Every night drank coffee at 18:00, so there is no variance to correlate.
  assert.equal(analysis.correlations.caffeineToOnset.r, null)
})

test('analysis: the insomnia screen needs frequency and duration', () => {
  // Six bad nights inside one week: frequent, but not yet 3 months.
  const bad = synthesizeNights(6, () => ({ bedtime: '23:00', outOfBed: '07:00', sleepOnsetMin: 70, wasoMin: 50 }))
  const subacute = analyzeNights(bad.map(nightFromRecord))
  assert.equal(subacute.insomniaScreen.label, 'subacute-pattern')
  assert.equal(subacute.insomniaScreen.durationMet, false)
  assert.ok(subacute.warnings.some((w) => w.includes('入睡困难与夜间觉醒同时存在')))
})

test('analysis: phase drift is detected from scattered midpoints', () => {
  const records = synthesizeNights(12, (i) => (i % 2 === 0
    ? { bedtime: '21:30', outOfBed: '05:30', sleepOnsetMin: 10, wasoMin: 10 }
    : { bedtime: '02:30', outOfBed: '10:30', sleepOnsetMin: 10, wasoMin: 10 }))
  const analysis = analyzeNights(records.map(nightFromRecord))
  assert.ok(analysis.phase.spreadMin > 90)
  assert.equal(analysis.phase.irregular, true)
  assert.ok(analysis.warnings.some((w) => w.includes('昼夜节律相位不稳定')))
})

// ------------------------------------------------------------ the plan ----

test('plan: refuses to compress the window without enough diary nights', () => {
  const records = synthesizeNights(3, () => ({ bedtime: '23:00', outOfBed: '07:00', sleepOnsetMin: 60, wasoMin: 40 }))
  const plan = planSleepWindow({ nights: records.map(nightFromRecord), profile: { targetWake: '07:00' } })
  assert.equal(plan.dataQuality, 'thin')
  assert.equal(plan.plan.adjustment, 'none')
  assert.ok(plan.safety.refusals.some((r) => r.code === 'data:insufficient'))
  // Even with no adjustment we still hand back a fixed rising time.
  assert.equal(plan.plan.targetWake, '07:00')
})

test('plan: low efficiency shrinks the window by at most 30 minutes', () => {
  // TIB 9 h, TST ~ 9h - 75 - 45 = 6h -> efficiency ~67%.
  const records = synthesizeNights(14, () => ({ bedtime: '22:00', outOfBed: '07:00', sleepOnsetMin: 75, wasoMin: 45 }))
  const plan = planSleepWindow({ nights: records.map(nightFromRecord), profile: { targetWake: '07:00' } })
  assert.equal(plan.dataQuality, 'sufficient')
  assert.equal(plan.plan.adjustment, 'shrink')
  assert.equal(plan.current.tibMin - plan.plan.prescribedTibMin, 30)
  assert.match(plan.plan.reason, /85%/)
})

test('plan: never drops below the five hour floor', () => {
  const records = synthesizeNights(14, () => ({ bedtime: '00:30', outOfBed: '05:30', sleepOnsetMin: 40, wasoMin: 40 }))
  const plan = planSleepWindow({ nights: records.map(nightFromRecord), profile: { targetWake: '05:30' } })
  assert.ok(plan.plan.prescribedTibMin >= 5 * 60)
  assert.equal(plan.plan.prescribedTibMin, 5 * 60)
})

test('plan: high efficiency grows the window and bedtime moves earlier', () => {
  const records = synthesizeNights(14, () => ({ bedtime: '23:00', outOfBed: '07:00', sleepOnsetMin: 10, wasoMin: 5 }))
  const plan = planSleepWindow({ nights: records.map(nightFromRecord), profile: { targetWake: '07:00' } })
  assert.equal(plan.plan.adjustment, 'grow')
  assert.ok(plan.plan.prescribedTibMin > plan.current.tibMin)
  assert.equal(plan.plan.targetWake, '07:00')
  // 07:00 minus a ~8.4 h window lands before 23:00.
  assert.ok(plan.plan.targetBed < '23:00' || plan.plan.targetBed > '23:30')
})

test('plan: contraindications and red flags block the behavioural plan', () => {
  const records = synthesizeNights(14, () => ({
    bedtime: '23:00',
    outOfBed: '07:00',
    sleepOnsetMin: 80,
    wasoMin: 50,
    note: '夜里打鼾，有时会憋醒'
  }))
  const plan = planSleepWindow({
    nights: records.map(nightFromRecord),
    profile: { targetWake: '06:30', conditions: ['双相情感障碍'], occupation: '货车司机' }
  })
  assert.equal(plan.safety.ok, false)
  assert.equal(plan.plan.adjustment, 'none')
  const codes = plan.safety.refusals.map((r) => r.code)
  assert.ok(codes.some((c) => c.startsWith('red-flag:apnea')))
  assert.ok(codes.includes('contraindication:bipolar'))
  assert.ok(codes.includes('contraindication:safety_critical') || codes.includes('contraindication:safety_critical'))
})

test('plan: infers the rising time when the profile has no target', () => {
  const records = synthesizeNights(10, () => ({ bedtime: '23:00', outOfBed: '06:50', sleepOnsetMin: 15, wasoMin: 15 }))
  const plan = planSleepWindow({ nights: records.map(nightFromRecord), profile: {} })
  // modeClock rounds to the nearest 10 minutes.
  assert.equal(plan.plan.targetWake, '06:50')
})

// -------------------------------------------------------------- reports ----

test('report: weekly markdown carries the sleep-first sections', async () => {
  await withStore(async (store) => {
    for (let i = 0; i < 7; i++) {
      const date = addDays('2026-03-02', i)
      await store.append(buildRecord('sleep', {
        date, bedtime: '23:15', outOfBed: '07:00', sleepOnsetMin: 25, wasoMin: 20, quality: 3
      }, date))
    }
    await store.append(buildRecord('weight', { kg: 70 + 0.3, date: '2026-03-05' }, '2026-03-05'))
    await store.append(buildRecord('blood_pressure', { systolic: 186, diastolic: 122, date: '2026-03-06' }, '2026-03-06'))

    const window = windowPair('2026-03-08', 7)
    const records = await store.query({ from: window.current.from, to: window.current.to })
    const previous = await store.query({ from: window.previous.from, to: window.previous.to })
    const report = buildReport({ records, window: window.current, previous })

    assert.match(report.markdown, /# 健康报告/)
    assert.match(report.markdown, /## 睡眠/)
    assert.match(report.markdown, /平均总睡眠时间/)
    assert.match(report.markdown, /## 生命体征/)
    assert.match(report.markdown, /需要留意的读数/)
    assert.match(report.markdown, /立即就医/)
    assert.equal(report.summary.totalRecords, 9)
  })
})

test('report: an empty window reports no sleep data instead of crashing', () => {
  const window = windowPair('2026-03-08', 7)
  const report = buildReport({ records: [], window: window.current, previous: [] })
  assert.match(report.markdown, /本周期没有睡眠记录/)
  assert.equal(report.summary.totalRecords, 0)
})
