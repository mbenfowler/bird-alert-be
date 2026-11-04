const { test } = require('node:test')
const assert = require('node:assert/strict')
const { cleanPlan } = require('../lib/eventRoutePlan')

const stop = { locId: 'L123', name: 'Ramsey Canyon', lat: 31.4501234, lng: -110.3000049 }

test('a saved route: stops to 5 decimals and a locId or null, the start to 2 (as the suggestion\'s from), the version as read', () => {
  assert.deepEqual(cleanPlan({ start: { name: 'Motel', lat: 31.40491, lng: -110.25512 }, stops: [stop, { name: 'A house', lat: 31.5, lng: -110.2 }], version: '3' }), {
    start: { name: 'Motel', lat: 31.4, lng: -110.26 },
    stops: [{ locId: 'L123', name: 'Ramsey Canyon', lat: 31.45012, lng: -110.3 }, { locId: null, name: 'A house', lat: 31.5, lng: -110.2 }],
    version: 3
  })
  assert.deepEqual(cleanPlan({ stops: [], version: 0 }), { start: null, stops: [], version: 0 })
})

test('a saved route that isn\'t one is a 400', () => {
  for (const bad of [
    null, { stops: {}, version: 0 }, { stops: Array(9).fill(stop), version: 0 }, { stops: [{ ...stop, lat: NaN }], version: 0 }, { stops: [{ ...stop, lng: '1' }], version: 0 },
    { stops: [{ ...stop, name: 'x'.repeat(201) }], version: 0 }, { stops: [{ ...stop, locId: 'S1' }], version: 0 }, { stops: [stop], start: { name: 'Home', lat: 1, lng: null }, version: 0 },
    { stops: [stop], start: { lat: 1, lng: 2 }, version: 0 }, { stops: [stop] }, { stops: [stop], version: 1.5 }, { stops: [stop], version: -1 }
  ]) assert.throws(() => cleanPlan(bad), (e) => e.status === 400, JSON.stringify(bad))
  assert.equal(cleanPlan({ stops: [{ ...stop, name: 'x'.repeat(200) }], version: 0 }).stops[0].name.length, 200)
})

const { routeDetails, targetsAt } = require('../lib/eventRoutePlan')
const { suggestStay } = require('../lib/eventRoute')

test('a stop\'s stay_min: whole minutes from 0 to 480, rounded; null or absent is the suggestion (left unsaved); anything else is a 400', () => {
  const plan = cleanPlan({ stops: [{ ...stop, stay_min: 44.6 }, { ...stop, stay_min: 0 }, { ...stop, stay_min: 480 }, { ...stop, stay_min: null }, stop], version: 0 })
  assert.deepEqual(plan.stops.map((s) => s.stay_min), [45, 0, 480, undefined, undefined])
  assert.ok(!('stay_min' in plan.stops[3]), 'null is not stored')
  for (const bad of [-1, 480.6, 481, '30', NaN, Infinity, true, {}]) {
    assert.throws(() => cleanPlan({ stops: [{ ...stop, stay_min: bad }], version: 0 }), (e) => e.status === 400 && /stay_min/.test(e.message), String(bad))
  }
})

test('the suggested stay: 15 min and 7 a target, to the nearest 5, from 15 to 90', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 10, 11, 40].map(suggestStay), [15, 20, 30, 35, 45, 50, 55, 85, 90, 90])
  assert.deepEqual([-2, NaN, undefined, null].map(suggestStay), [15, 15, 15, 15])
})

// The area's feed: a report on a line of latitude 31; public unless told.
const today = '2026-11-03'
const rec = (speciesCode, locId, lng, { obsDt = '2026-11-01 08:00', priv = false } = {}) =>
  ({ speciesCode, comName: speciesCode, locId, locName: `Place ${locId}`, lat: 31, lng, obsDt, locationPrivate: priv })
const records = [
  rec('aaa', 'L1', -110), rec('bbb', 'L1', -110), rec('aaa', 'L1', -110, { obsDt: '2026-10-31 07:00' }),
  rec('ccc', 'L9', -110.003, { priv: true }), // a personal spot ~300 m from L1: folds into it
  rec('ddd', 'L1', -110, { obsDt: '2026-10-20 08:00' }), // a target, but not this week
  rec('zzz', 'L2', -109), // not a target
  rec('ddd', 'L3', -108)
]
const scouting = { records, targets: ['aaa', 'bbb', 'ccc', 'ddd'], today }

test('targets at each stop: distinct targets this week, a personal spot folded into the hotspot counted with it; no locId or none reported: 0', () => {
  const stops = [{ locId: 'L1' }, { locId: 'L9' }, { locId: 'L2' }, { locId: 'L3' }, { locId: null }, { locId: 'L77' }]
  assert.deepEqual(targetsAt(stops, scouting), [3, 3, 0, 1, 0, 0])
  assert.deepEqual(targetsAt(stops, { records: [], targets: [], today: null }), [0, 0, 0, 0, 0, 0])
})

// A drive along the given points: a degree of longitude is 60 minutes and 50 miles.
const lineDrive = (calls = []) => async (points) => {
  calls.push(points.map((p) => p.name))
  const legs = points.slice(1).map((p, i) => ({ minutes: Math.abs(p.lng - points[i].lng) * 60, miles: Math.abs(p.lng - points[i].lng) * 50 }))
  return { legs, minutes: legs.reduce((s, l) => s + l.minutes, 0), miles: legs.reduce((s, l) => s + l.miles, 0), geometry: [] }
}
const saved = {
  start: { name: 'Motel', lat: 31, lng: -110.5 },
  stops: [{ locId: 'L1', name: 'Canyon', lat: 31, lng: -110 }, { locId: null, name: 'A house', lat: 31, lng: -109.8, stay_min: 10 }, { locId: 'L3', name: 'Marsh', lat: 31, lng: -108, stay_min: 120 }]
}

test('legs with a start: the drive into each stop from the one before, the first from the start; stays and totals', async () => {
  const calls = []
  const plan = await routeDetails(saved, scouting, { drive: lineDrive(calls) })
  assert.deepEqual(calls, [['Motel', 'Canyon', 'A house', 'Marsh']], 'one route through start and stops')
  assert.equal(plan.routed, true)
  assert.deepEqual(plan.legs, [{ min: 30, mi: 25 }, { min: 12, mi: 10 }, { min: 108, mi: 90 }])
  assert.deepEqual(plan.stops.map((s) => [s.stay_min, s.targets_here, s.suggested_stay_min]), [[null, 3, 35], [10, 0, 15], [120, 1, 20]])
  assert.deepEqual(plan.totals, { drive_min: 150, stay_min: 35 + 10 + 120, total_min: 150 + 165 })
  assert.deepEqual(plan.start, saved.start)
})

test('legs without a start: the first stop has none; one stop alone needs no route', async () => {
  const calls = []
  const plan = await routeDetails({ start: null, stops: saved.stops }, scouting, { drive: lineDrive(calls) })
  assert.deepEqual(calls, [['Canyon', 'A house', 'Marsh']])
  assert.deepEqual(plan.legs, [null, { min: 12, mi: 10 }, { min: 108, mi: 90 }])
  assert.deepEqual(plan.totals, { drive_min: 120, stay_min: 165, total_min: 285 })
  const boom = async () => { throw new Error('not called') }
  const one = await routeDetails({ start: null, stops: [saved.stops[0]] }, scouting, { drive: boom })
  assert.deepEqual([one.routed, one.legs, one.totals], [true, [null], { drive_min: 0, stay_min: 35, total_min: 35 }])
})

test('OSRM failing (null, a throw, or legs that don\'t fit): routed false, no legs, the total the stays alone', async () => {
  const fails = [async () => null, async () => { throw new Error('down') }, async () => ({ legs: [{ minutes: 5, miles: 1 }], minutes: 5, miles: 1 })]
  for (const drive of fails) {
    const plan = await routeDetails(saved, scouting, { drive })
    assert.deepEqual([plan.routed, plan.legs, plan.totals], [false, null, { drive_min: null, stay_min: 165, total_min: 165 }])
    assert.equal(plan.stops.length, 3)
  }
})

test('the start\'s meeting time: HH:MM on a 24-hour clock, kept as given; null or absent is none', () => {
  const at = (time) => cleanPlan({ start: { name: 'Motel', lat: 31.4, lng: -110.2, time }, stops: [], version: 0 }).start
  assert.deepEqual(at('05:15'), { name: 'Motel', lat: 31.4, lng: -110.2, time: '05:15' })
  assert.equal(at('00:00').time, '00:00')
  assert.equal(at('23:59').time, '23:59')
  assert.deepEqual(at(null), { name: 'Motel', lat: 31.4, lng: -110.2 })
  assert.deepEqual(at(undefined), { name: 'Motel', lat: 31.4, lng: -110.2 })
  for (const bad of ['5:15', '24:00', '12:60', '0515', '05:15:00', '5:15 AM', '', 515, false, {}]) {
    assert.throws(() => at(bad), (e) => e.status === 400 && /HH:MM/.test(e.message), JSON.stringify(bad))
  }
})

const { cleanPosition } = require('../lib/eventRoutePlan')

test('a position: a stop index (-1 the meeting point) or null, and when it was tapped, never later than now', () => {
  const now = new Date('2026-11-04T13:00:00Z')
  assert.deepEqual(cleanPosition({ stop: 2, at: '2026-11-04T12:40:00Z' }, now), { stop: 2, at: new Date('2026-11-04T12:40:00Z') })
  assert.deepEqual(cleanPosition({ stop: -1, at: '2026-11-04T12:40:00-07:00' }, now), { stop: -1, at: now }, 'later than now: now')
  assert.deepEqual(cleanPosition({ stop: null }, now), { stop: null, at: now })
  assert.deepEqual(cleanPosition({}, now), { stop: null, at: now })
  for (const bad of [{ stop: -2 }, { stop: 1.5 }, { stop: '1' }, { stop: 1, at: 'soon' }, { stop: 1, at: 1730000000000 }]) {
    assert.throws(() => cleanPosition(bad, now), (e) => e.status === 400, JSON.stringify(bad))
  }
})
