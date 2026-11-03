const { test } = require('node:test')
const assert = require('node:assert/strict')
const { planRoute, parseFrom, parseIds, applyPicks, routeKey, buildPlaces, coverPlaces, creditInOrder, insertionCost, pathCost, bruteForce, twoOpt, MINUTES_PER_BIRD } = require('../lib/eventRoute')
const routing = require('../lib/routing')

// A report at a place on a line of latitude 31: lng says where. Private unless told.
const rep = (speciesCode, locId, lng, { obsDt = '2026-11-01 08:00', priv = false, lat = 31 } = {}) =>
  ({ speciesCode, comName: speciesCode.toUpperCase(), locId, locName: `Place ${locId}`, lat, lng, obsDt, locationPrivate: priv })

// A table where a degree of longitude is 100 minutes and 80 miles (only east-west matters).
const lineTable = (calls = []) => async (points) => {
  calls.push(points.map((p) => p.locId || 'start'))
  const f = (k) => points.map((a) => points.map((b) => Math.abs(a.lng - b.lng) * k))
  return { minutes: f(100), miles: f(80) }
}
// A route along the given points with the same scale.
const lineDrive = (calls = []) => async (points) => {
  calls.push(points.map((p) => p.locId || 'start'))
  const legs = points.slice(1).map((p, i) => ({ minutes: Math.abs(p.lng - points[i].lng) * 100, miles: Math.abs(p.lng - points[i].lng) * 80 }))
  return { legs, minutes: legs.reduce((s, l) => s + l.minutes, 0), miles: legs.reduce((s, l) => s + l.miles, 0), geometry: points.map((p) => [p.lat, p.lng]) }
}

test('every report counts: a bird reported at the big lake this week is credited there, not given its own stop', () => {
  // Greater Yellowlegs (greyel) at the gas station (its newest report) and at the lake (earlier this week).
  const places = buildPlaces([
    rep('greyel', 'LOVES', -110.0, { obsDt: '2026-11-01 16:00' }),
    rep('greyel', 'LAKE', -109.9, { obsDt: '2026-10-29 09:00' }), rep('sancra', 'LAKE', -109.9), rep('ferhaw', 'LAKE', -109.9)
  ])
  const chosen = coverPlaces(places, 15)
  assert.deepEqual(chosen.map((p) => p.locId), ['LAKE'])
  assert.deepEqual([...chosen[0].species.keys()].sort(), ['ferhaw', 'greyel', 'sancra'])
})

test('a personal location folds into the nearest public hotspot within MERGE_METRES, which gains its birds; one far from any stays, private', () => {
  const places = buildPlaces(
    [rep('a', 'L1', -110.0), rep('b', 'P1', -110.003, { priv: true }), rep('c', 'P2', -110.5, { priv: true })],
    // A hotspot from the area's feed with no target bird: still a place a yard folds into.
    [{ speciesCode: 'amerob', locId: 'L9', locName: 'Town Park', lat: 31, lng: -110.4995, locationPrivate: false }]
  )
  const by = new Map(places.map((p) => [p.locId, p]))
  assert.deepEqual([...by.keys()].sort(), ['L1', 'L9'])
  assert.deepEqual([...by.get('L1').species.keys()].sort(), ['a', 'b'])
  assert.deepEqual(by.get('L1').merged, [{ locId: 'P1', locName: 'Place P1' }])
  assert.equal(by.get('L1').private, false)
  assert.deepEqual([...by.get('L9').species.keys()], ['c'])
  const lonely = buildPlaces([rep('d', 'P3', -111, { priv: true })])
  assert.deepEqual(lonely.map((p) => [p.locId, p.private, p.merged]), [['P3', true, []]])
})

test('insertion cost: between two stops, after the last, or before the first when it is not fixed', () => {
  const m = [[0, 10, 30], [10, 0, 20], [30, 20, 0]]
  const table = { minutes: m, miles: m.map((r) => r.map((v) => v / 2)) }
  assert.deepEqual(insertionCost([0, 2], 1, table), { pos: 1, minutes: 0, miles: 0 })
  assert.deepEqual(insertionCost([0, 1], 2, table), { pos: 2, minutes: 20, miles: 10 })
  assert.deepEqual(insertionCost([1, 2], 0, table, { fixedFirst: false }), { pos: 0, minutes: 10, miles: 5 })
  assert.equal(insertionCost([1, 2], 0, table).pos, 1, 'a fixed first stays first')
})

test('ordering: exact for small paths and 2-opt untangles a crossed one, the first kept first', () => {
  const xs = [0, 5, 1, 4, 2, 3]
  const m = xs.map((a) => xs.map((b) => Math.abs(a - b)))
  const exact = bruteForce([0, 1, 2, 3, 4, 5], m)
  assert.equal(exact[0], 0)
  assert.deepEqual(exact.map((i) => xs[i]), [0, 1, 2, 3, 4, 5])
  const two = twoOpt([0, 1, 2, 3, 4, 5], m)
  assert.equal(two[0], 0)
  assert.equal(pathCost(two, m), 5)
})

test('the core takes a place only while it costs at most MINUTES_PER_BIRD a new bird; the rest are extras with their detours, best value first', async () => {
  assert.equal(MINUTES_PER_BIRD, 15)
  const from = { lat: 31, lng: -110 }
  const places = buildPlaces([
    // A: 3 birds 10 min out (first, always). B: 2 birds 20 min past A (10 a bird: core).
    rep('a1', 'A', -109.9), rep('a2', 'A', -109.9), rep('a3', 'A', -109.9),
    rep('b1', 'B', -109.7), rep('b2', 'B', -109.7),
    // C: 1 bird 40 min past B (40 a bird: extra). D: 2 birds 50 min past B (25 a bird: extra, ahead of C).
    rep('c1', 'C', -109.3), rep('d1', 'D', -109.2), rep('d2', 'D', -109.2),
    // E: only birds A has: skipped.
    rep('a1', 'E', -110.1)
  ])
  const tableCalls = []
  const driveCalls = []
  const plan = await planRoute({ places, reported: 8, from }, { table: lineTable(tableCalls), drive: lineDrive(driveCalls) })
  assert.equal(tableCalls.length, 1)
  assert.deepEqual(driveCalls, [['start', 'A', 'B']])
  assert.deepEqual(plan.stops.map((s) => [s.n, s.locId, s.new_birds.map((b) => b.code), s.leg_min, s.leg_mi, s.private, s.merged]),
    [[1, 'A', ['a1', 'a2', 'a3'], 10, 8, false, []], [2, 'B', ['b1', 'b2'], 20, 16, false, []]])
  assert.deepEqual(plan.extras.map((e) => [e.locId, e.new_birds.map((b) => b.code), e.add_min, e.add_mi, e.private]), [['D', ['d1', 'd2'], 50, 40, false], ['C', ['c1'], 40, 32, false]])
  assert.deepEqual([plan.total_min, plan.total_mi, plan.covered, plan.covered_with_extras, plan.reported, plan.skipped, plan.routed], [30, 24, 5, 8, 8, 1, true])
  // Every target reported at each place, not just what it is credited with; and a name for each.
  assert.deepEqual(plan.stops.map((s) => s.species), [['a1', 'a2', 'a3'], ['b1', 'b2']])
  assert.deepEqual(plan.extras.map((e) => e.species), [['d1', 'd2'], ['c1']])
  assert.deepEqual(plan.names, { a1: 'A1', a2: 'A2', a3: 'A3', b1: 'B1', b2: 'B2', c1: 'C1', d1: 'D1', d2: 'D2' })
  assert.deepEqual(plan.from, from)
})

test('without a start, the place with the most birds comes first with a 0 leg; one place needs no OSRM', async () => {
  const places = buildPlaces([rep('x', 'A', -110), rep('y', 'B', -110.05), rep('z', 'B', -110.05)])
  const plan = await planRoute({ places, reported: 3, from: null }, { table: lineTable(), drive: lineDrive() })
  assert.deepEqual(plan.stops.map((s) => [s.locId, s.leg_min]), [['B', 0], ['A', 5]])
  assert.equal(plan.from, null)
  const boom = async () => { throw new Error('no call') }
  const one = await planRoute({ places: buildPlaces([rep('x', 'A', -110)]), reported: 1, from: null }, { table: boom, drive: boom })
  assert.deepEqual([one.routed, one.stops.length, one.stops[0].leg_min, one.total_min, one.geometry, one.extras], [true, 1, 0, 0, [[31, -110]], []])
  const none = await planRoute({ places: [], reported: 0, from: { lat: 31, lng: -110 } }, { table: boom, drive: boom })
  assert.deepEqual([none.stops, none.extras, none.covered, none.skipped, none.routed, none.geometry], [[], [], 0, 0, true, []])
})

test('birds are credited in visit order and a stop left with none is dropped', () => {
  const [a, b, c] = buildPlaces([rep('x', 'A', 0), rep('y', 'A', 0), rep('x', 'B', 1), rep('z', 'B', 1), rep('y', 'C', 2), rep('w', 'C', 2)])
  assert.deepEqual(creditInOrder([b, c, a]).map((s) => [s.place.locId, s.new_birds.map((n) => n.code)]), [['B', ['x', 'z']], ['C', ['y', 'w']]])
})

test('from is rounded to 2 decimals; a bad one is a 400', () => {
  assert.deepEqual(parseFrom('31.4567,-110.2949'), { lat: 31.46, lng: -110.29 })
  assert.equal(parseFrom(''), null)
  for (const bad of ['abc', '91,0', '0,181']) assert.throws(() => parseFrom(bad), (e) => e.status === 400)
})

test('when OSRM fails: the same choices on straight lines at 35 mph, no times, straight segments, routed false', async () => {
  const realFetch = global.fetch
  const calls = []
  global.fetch = async (url, init) => { calls.push([String(url), init.headers['User-Agent']]); return { ok: false, status: 503, json: async () => ({}) } }
  const error = console.error
  console.error = () => {}
  try {
    const from = { lat: 31, lng: -110 }
    // About 6 miles (10 min at 35 mph) a 0.1 degree here: A (3 birds) first; B 2 birds 0.1 further (5 min a bird): core;
    // C 1 bird 1 degree further (about 100 min): extra.
    const places = buildPlaces([rep('a1', 'A', -109.9), rep('a2', 'A', -109.9), rep('a3', 'A', -109.9), rep('b1', 'B', -109.8), rep('b2', 'B', -109.8), rep('c1', 'C', -108.8)])
    const plan = await planRoute({ places, reported: 6, from }, { table: routing.fetchTable, drive: async () => { throw new Error('no route after a failed table') } })
    assert.equal(calls.length, 1)
    assert.match(calls[0][0], /^https:\/\/router\.project-osrm\.org\/table\/v1\/driving\/-110,31;-109\.9,31;-109\.8,31;-108\.8,31\?annotations=duration,distance$/)
    assert.match(calls[0][1], /bird-alert/)
    assert.equal(plan.routed, false)
    assert.deepEqual(plan.stops.map((s) => [s.locId, s.leg_min, s.leg_mi]), [['A', null, null], ['B', null, null]])
    assert.deepEqual(plan.extras.map((e) => [e.locId, e.add_min, e.add_mi]), [['C', null, null]])
    assert.deepEqual([plan.total_min, plan.total_mi, plan.covered, plan.covered_with_extras], [null, null, 5, 6])
    assert.deepEqual(plan.geometry, [[31, -110], [31, -109.9], [31, -109.8]])
  } finally {
    global.fetch = realFetch
    console.error = error
  }
})

test('the OSRM table answer is read as minutes and miles; a missing road is null', async () => {
  const realFetch = global.fetch
  global.fetch = async () => ({ ok: true, json: async () => ({ code: 'Ok', durations: [[0, 600], [null, 0]], distances: [[0, 1609.344 * 5], [null, 0]] }) })
  try {
    const t = await routing.fetchTable([{ lat: 31, lng: -110 }, { lat: 31.1, lng: -110.1 }])
    assert.deepEqual(t.minutes, [[0, 10], [null, 0]])
    assert.deepEqual(t.miles.map((r) => r.map((v) => (v === null ? null : Math.round(v)))), [[0, 5], [null, 0]])
  } finally { global.fetch = realFetch }
})

test('the route has exactly the scouting\'s access rules: whatever event-scouting refuses, it refuses', async () => {
  const events = require('../lib/events')
  const { eventRoute } = require('../lib/eventRoute')
  const real = events.scoutingFor
  const seen = []
  events.scoutingFor = async (user, id, opts) => { seen.push([user.id, id, Object.keys(opts).sort()]); const { HttpError } = require('../lib/http'); throw new HttpError(404, 'No such event') }
  try {
    await assert.rejects(events.eventScouting({ id: 7 }, '12'), (e) => e.status === 404)
    await assert.rejects(eventRoute({ id: 7 }, '12', { from: '31.111,-110.222' }), (e) => e.status === 404)
    assert.deepEqual(seen.map(([u, id]) => [u, id]), [[7, '12'], [7, '12']])
    await assert.rejects(eventRoute({ id: 7 }, '12', { from: 'nope' }), (e) => e.status === 400)
    assert.equal(seen.length, 2, 'a bad from is refused before anything is read')
  } finally { events.scoutingFor = real }
})

// Picking: a table where latitude and longitude both cost (100 minutes, 80 miles a degree).
const gridTable = async (points) => {
  const f = (k) => points.map((a) => points.map((b) => (Math.abs(a.lat - b.lat) + Math.abs(a.lng - b.lng)) * k))
  return { minutes: f(100), miles: f(80) }
}
const gridDrive = async (points) => {
  const legs = points.slice(1).map((p, i) => { const d = Math.abs(p.lat - points[i].lat) + Math.abs(p.lng - points[i].lng); return { minutes: d * 100, miles: d * 80 } })
  return { legs, minutes: legs.reduce((s, l) => s + l.minutes, 0), miles: legs.reduce((s, l) => s + l.miles, 0), geometry: points.map((p) => [p.lat, p.lng]) }
}
// From the start: A (3 birds) 10 min east, B (3) 20 min further. X, off to the north, has one of A's birds and one of its own:
// 40 min of detour for 1 bird, so an extra unless added.
const pickPlaces = () => buildPlaces([
  rep('a1', 'A', -109.9), rep('a2', 'A', -109.9), rep('a3', 'A', -109.9),
  rep('b1', 'B', -109.7), rep('b2', 'B', -109.7), rep('b3', 'B', -109.7),
  rep('a1', 'X', -110, { lat: 31.2 }), rep('x1', 'X', -110, { lat: 31.2 })
])
const start = { lat: 31, lng: -110 }
const tools = { table: gridTable, drive: gridDrive }

test('an added extra joins the core at its cheapest place and takes the credit for birds it is visited first for', async () => {
  const plain = await planRoute({ places: pickPlaces(), reported: 6, from: start }, tools)
  assert.deepEqual(plain.stops.map((s) => [s.locId, s.picked]), [['A', false], ['B', false]])
  assert.deepEqual(plain.extras.map((e) => [e.locId, e.new_birds.map((b) => b.code), e.add_min, e.dropped]), [['X', ['x1'], 40, false]])
  assert.deepEqual([plain.add, plain.drop], [[], []])

  const picked = await planRoute({ places: pickPlaces(), reported: 6, from: start, add: ['X'] }, tools)
  // X is visited first (start, X, A, B is the quickest order), so a1 is X's now.
  assert.deepEqual(picked.stops.map((s) => [s.n, s.locId, s.new_birds.map((b) => b.code), s.picked]),
    [[1, 'X', ['a1', 'x1'], true], [2, 'A', ['a2', 'a3'], false], [3, 'B', ['b1', 'b2', 'b3'], false]])
  assert.deepEqual(picked.stops.map((s) => s.leg_min), [20, 30, 20])
  // A keeps a1 in its species though X is credited with it.
  assert.deepEqual(picked.stops.map((s) => s.species), [['a1', 'x1'], ['a1', 'a2', 'a3'], ['b1', 'b2', 'b3']])
  assert.deepEqual(plain.extras[0].species, ['a1', 'x1'], 'an extra lists birds the core has too')
  assert.deepEqual([picked.extras, picked.covered, picked.covered_with_extras, picked.total_min, picked.add, picked.drop], [[], 7, 7, 70, ['X'], []])
})

test('a dropped place is never in the core but still shows as an extra, marked dropped', async () => {
  const plan = await planRoute({ places: pickPlaces(), reported: 6, from: start, drop: ['B'] }, tools)
  assert.deepEqual(plan.stops.map((s) => s.locId), ['A'])
  assert.deepEqual(plan.extras.map((e) => [e.locId, e.new_birds.map((b) => b.code), e.dropped]).sort(), [['B', ['b1', 'b2', 'b3'], true], ['X', ['x1'], false]])
  assert.deepEqual(plan.drop, ['B'])
  // The best first place can be dropped too: the next best leads.
  const noA = await planRoute({ places: pickPlaces(), reported: 6, from: null, drop: ['A'] }, tools)
  assert.ok(!noA.stops.some((s) => s.locId === 'A'))
  assert.equal(noA.extras.find((e) => e.locId === 'A')?.dropped, true)
})

test('a personal location named in add or drop means the hotspot it folded into; unknown ids are ignored', () => {
  const places = buildPlaces([rep('a', 'L1', -110.0), rep('b', 'L2', -110.003, { priv: true }), rep('c', 'L3', -111)])
  assert.deepEqual(applyPicks(places, ['L2', 'L404'], ['L3', 'L405']).add, ['L1'])
  assert.deepEqual(applyPicks(places, ['L2', 'L1'], []).add, ['L1'], 'the same place once')
  assert.deepEqual(applyPicks(places, [], ['L3']).drop, ['L3'])
  assert.throws(() => applyPicks(places, ['L2'], ['L1']), (e) => e.status === 400 && /both added and dropped/.test(e.message))
})

test('more added places than stops is a 400; exactly the cap is fine', async () => {
  const many = buildPlaces(Array.from({ length: 9 }, (_, i) => rep(`s${i}`, `P${i}`, -110 + i / 10)))
  const ids = many.map((p) => p.locId)
  await assert.rejects(planRoute({ places: many, reported: 9, from: start, add: ids }, tools), (e) => e.status === 400 && /up to 8 stops/.test(e.message))
  const eight = await planRoute({ places: many, reported: 9, from: start, add: ids.slice(0, 8) }, tools)
  assert.equal(eight.stops.length, 8)
  assert.ok(eight.stops.every((s) => s.picked))
  assert.deepEqual(eight.extras.map((e) => e.locId), ['P8'])
})

test('add and drop are eBird location ids, up to 20 each; anything else is a 400 before anything is read', async () => {
  assert.deepEqual(parseIds(undefined, 'add'), [])
  assert.deepEqual(parseIds('', 'add'), [])
  assert.deepEqual(parseIds(' L1, L22 ,L1,', 'add'), ['L1', 'L22'])
  assert.deepEqual(parseIds(Array.from({ length: 20 }, (_, i) => `L${i}`).join(','), 'drop').length, 20)
  for (const bad of ['X1', 'L1,hotspot', 'L1;L2', 'l12', Array.from({ length: 21 }, (_, i) => `L${i}`).join(',')]) {
    assert.throws(() => parseIds(bad, 'add'), (e) => e.status === 400, bad)
  }
  const events = require('../lib/events')
  const { eventRoute } = require('../lib/eventRoute')
  const real = events.scoutingFor
  let reads = 0
  events.scoutingFor = async () => { reads += 1; throw new Error('not reached') }
  try {
    await assert.rejects(eventRoute({ id: 7 }, '12', { add: 'L1,nope' }), (e) => e.status === 400 && /add/.test(e.message))
    await assert.rejects(eventRoute({ id: 7 }, '12', { drop: 'S123' }), (e) => e.status === 400 && /drop/.test(e.message))
    assert.equal(reads, 0)
  } finally { events.scoutingFor = real }
})

test('the cache key holds the sorted add and drop lists', () => {
  const reports = [rep('a', 'L1', -110), rep('b', 'L2', -109)]
  const base = routeKey(reports, start)
  assert.equal(base, routeKey(reports, start, { add: [], drop: [] }))
  assert.equal(routeKey(reports, start, { add: ['L2', 'L1'], drop: ['L9'] }), routeKey(reports, start, { add: ['L1', 'L2'], drop: ['L9'] }))
  assert.notEqual(routeKey(reports, start, { add: ['L1'] }), base)
  assert.notEqual(routeKey(reports, start, { drop: ['L1'] }), routeKey(reports, start, { add: ['L1'] }))
})

test('a stop\'s species include those of personal spots folded into it; names cover stops and extras only', async () => {
  const places = buildPlaces([
    rep('a', 'L1', -110.0), rep('b', 'L2', -110.003, { priv: true }), rep('a', 'L3', -109.99),
    rep('c', 'L4', -105)
  ])
  const plan = await planRoute({ places, reported: 3, from: null }, { table: lineTable(), drive: lineDrive() })
  assert.deepEqual(plan.stops.map((s) => [s.locId, s.species, s.merged.map((m) => m.locId)]), [['L1', ['a', 'b'], ['L2']]])
  assert.deepEqual(plan.extras.map((e) => [e.locId, e.species]), [['L4', ['c']]])
  assert.deepEqual(plan.names, { a: 'A', b: 'B', c: 'C' })
  assert.equal(plan.skipped, 1, 'L3 adds nothing: skipped, so not named for')
  const none = await planRoute({ places: [], reported: 0, from: null }, { table: lineTable(), drive: lineDrive() })
  assert.deepEqual(none.names, {})
})

test('the suggested route: each stop has its targets this week (folded spots included) and a suggested stay, with their total', async () => {
  const { suggestStay } = require('../lib/eventRoute')
  // A: 2 targets, plus 1 more at a personal spot about 300 m away that folds into it; B: 1 target, a degree east.
  const places = buildPlaces([rep('x', 'A', -110), rep('y', 'A', -110), rep('z', 'P', -110.003, { priv: true }), rep('w', 'B', -109.9)])
  const plan = await planRoute({ places, reported: 4, from: { lat: 31, lng: -110.1 } }, { table: lineTable(), drive: lineDrive() })
  assert.deepEqual(plan.stops.map((s) => [s.locId, s.targets_here, s.suggested_stay_min]), [['A', 3, suggestStay(3)], ['B', 1, suggestStay(1)]])
  assert.deepEqual([suggestStay(3), suggestStay(1)], [35, 20])
  assert.equal(plan.stay_min_total, 55)
  const none = await planRoute({ places: [], reported: 0, from: null }, { table: lineTable(), drive: lineDrive() })
  assert.equal(none.stay_min_total, 0)
})
