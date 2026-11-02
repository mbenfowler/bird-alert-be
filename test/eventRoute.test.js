const { test } = require('node:test')
const assert = require('node:assert/strict')
const { planRoute, parseFrom, placesFrom, coverPlaces, creditInOrder } = require('../lib/eventRoute')
const routing = require('../lib/routing')

const report = (speciesCode, locId, obsDt, lat = 31.4, lng = -110.3) => ({ code: speciesCode, speciesCode, comName: speciesCode.toUpperCase(), locName: `Place ${locId}`, locId, lat, lng, obsDt, subId: `S-${locId}-${speciesCode}` })

test('places are grouped by locId with their distinct species and newest report', () => {
  const places = placesFrom([report('a', 'L1', '2026-10-30 07:00'), report('b', 'L1', '2026-10-31 07:00'), report('a', 'L1', '2026-10-29 07:00'), report('c', 'L2', '2026-10-28 07:00')])
  assert.deepEqual(places.map((p) => [p.locId, [...p.species.keys()], p.latest]), [['L1', ['a', 'b'], '2026-10-31 07:00'], ['L2', ['c'], '2026-10-28 07:00']])
})

test('set cover takes the place adding the most uncovered species, ties to the newest report, and stops at nothing new or the cap', () => {
  const places = placesFrom([
    report('a', 'L1', '2026-10-30'), report('b', 'L1', '2026-10-30'), report('c', 'L1', '2026-10-30'),
    report('a', 'L2', '2026-10-31'), report('d', 'L2', '2026-10-31'),
    report('e', 'L3', '2026-10-29'), report('d', 'L3', '2026-10-29'),
    report('b', 'L4', '2026-11-01'),
    report('f', 'L5', '2026-10-01'), report('g', 'L6', '2026-10-02')
  ])
  // L1 (3 new); then L3 (d, e) over L2 (d only); L5 and L6 add one each: L6 is newer; L2 and L4 add nothing.
  assert.deepEqual(coverPlaces(places).map((p) => p.locId), ['L1', 'L3', 'L6', 'L5'])
  assert.deepEqual(coverPlaces(places, 2).map((p) => p.locId), ['L1', 'L3'])
})

test('birds are credited to the first stop visited where they were reported; a stop adding nothing is dropped', () => {
  const [a, b, c] = placesFrom([report('x', 'A', '1'), report('y', 'A', '1'), report('x', 'B', '1'), report('z', 'B', '1'), report('y', 'C', '1'), report('w', 'C', '1')])
  const credited = creditInOrder([b, c, a])
  assert.deepEqual(credited.map((s) => [s.place.locId, s.new_birds.map((n) => n.speciesCode)]), [['B', ['x', 'z']], ['C', ['y', 'w']]])
  assert.deepEqual(credited[0].new_birds[0], { code: 'x', speciesCode: 'x', comName: 'X' })
})

test('from is rounded to 2 decimals; a bad one is a 400', () => {
  assert.deepEqual(parseFrom('31.4567,-110.2949'), { lat: 31.46, lng: -110.29 })
  assert.equal(parseFrom(undefined), null)
  assert.equal(parseFrom(''), null)
  for (const bad of ['abc', '91,0', '0,181', '1;2']) assert.throws(() => parseFrom(bad), (e) => e.status === 400)
})

// Three places: A (x,y) far west, B (x,z) middle, C (y,w) east. Set cover picks A (2 new; newest), then B, then C.
const scenario = [
  report('x', 'A', '2026-11-01', 31.0, -111.0), report('y', 'A', '2026-11-01', 31.0, -111.0),
  report('x', 'B', '2026-10-31', 31.0, -110.5), report('z', 'B', '2026-10-31', 31.0, -110.5),
  report('y', 'C', '2026-10-30', 31.0, -110.0), report('w', 'C', '2026-10-30', 31.0, -110.0),
  report('x', 'D', '2026-10-01', 31.0, -110.9)
]

test('with OSRM, stops follow the trip order and legs; from is the first point', async () => {
  const from = { lat: 31, lng: -111.1 }
  const asked = []
  const trip = async (points) => {
    asked.push(points.map((p) => p.locId || 'from'))
    return { order: [0, 1, 2, 3], legs: [{ minutes: 5.4, miles: 3.2 }, { minutes: 30.6, miles: 29.5 }, { minutes: 31, miles: 30 }], minutes: 67, miles: 62.7, geometry: [[31, -111.1], [31, -110]] }
  }
  const plan = await planRoute(scenario, from, { trip, drive: async () => { throw new Error('not needed') } })
  assert.deepEqual(asked, [['from', 'A', 'B', 'C']])
  assert.equal(plan.routed, true)
  assert.deepEqual(plan.from, from)
  assert.deepEqual(plan.stops.map((s) => [s.n, s.locId, s.new_birds.map((b) => b.code), s.leg_min, s.leg_mi]), [[1, 'A', ['x', 'y'], 5, 3], [2, 'B', ['z'], 31, 30], [3, 'C', ['w'], 31, 30]])
  assert.deepEqual([plan.total_min, plan.total_mi, plan.covered, plan.reported, plan.skipped], [67, 63, 4, 4, 1])
  assert.deepEqual(plan.geometry, [[31, -111.1], [31, -110]])
})

test('without from, the route starts at the place with the most species, and its first leg is 0', async () => {
  const reported = [report('x', 'A', '2026-11-01', 31, -111), report('y', 'B', '2026-10-31', 31, -110.5), report('z', 'B', '2026-10-31', 31, -110.5)]
  let asked
  const trip = async (points) => { asked = points.map((p) => p.locId); return { order: [0, 1], legs: [{ minutes: 40, miles: 30 }], minutes: 40, miles: 30, geometry: [] } }
  const plan = await planRoute(reported, null, { trip })
  assert.deepEqual(asked, ['B', 'A'])
  assert.deepEqual(plan.stops.map((s) => [s.locId, s.leg_min, s.leg_mi]), [['B', 0, 0], ['A', 40, 30]])
  assert.equal(plan.from, null)
  // One place: no OSRM at all.
  const one = await planRoute([report('x', 'A', '1', 31, -111)], null, { trip: async () => { throw new Error('no call') } })
  assert.deepEqual([one.routed, one.stops.length, one.stops[0].leg_min, one.total_min, one.geometry], [true, 1, 0, 0, [[31, -111]]])
  // Nothing reported: an empty plan.
  const none = await planRoute([], null, { trip: async () => { throw new Error('no call') } })
  assert.deepEqual([none.stops, none.covered, none.reported, none.skipped, none.routed], [[], 0, 0, 0, true])
})

test('a stop left with no new birds after ordering is dropped and the rest routed again in order', async () => {
  // OSRM visits B, C, then A: A's x and y are already credited.
  const trip = async () => ({ order: [0, 2, 3, 1], legs: [{ minutes: 1, miles: 1 }, { minutes: 1, miles: 1 }, { minutes: 1, miles: 1 }], minutes: 3, miles: 3, geometry: [[0, 0]] })
  let again
  const drive = async (points) => { again = points.map((p) => p.locId || 'from'); return { minutes: 50, miles: 40, legs: [{ minutes: 10, miles: 8 }, { minutes: 40, miles: 32 }], geometry: [[1, 1], [2, 2]] } }
  const plan = await planRoute(scenario, { lat: 31, lng: -110.6 }, { trip, drive })
  assert.deepEqual(again, ['from', 'B', 'C'])
  assert.deepEqual(plan.stops.map((s) => [s.n, s.locId, s.new_birds.map((b) => b.code), s.leg_min]), [[1, 'B', ['x', 'z'], 10], [2, 'C', ['y', 'w'], 40]])
  assert.deepEqual([plan.total_min, plan.total_mi, plan.covered, plan.skipped, plan.routed], [50, 40, 4, 2, true])
  assert.deepEqual(plan.geometry, [[1, 1], [2, 2]])
})

test('when OSRM fails: nearest-first by straight line, no times, straight segments, routed false', async () => {
  const realFetch = global.fetch
  const calls = []
  global.fetch = async (url, init) => { calls.push([url, init.headers['User-Agent']]); return { ok: false, status: 503, json: async () => ({}) } }
  const error = console.error
  console.error = () => {}
  try {
    const from = { lat: 31, lng: -109.9 }
    const plan = await planRoute(scenario, from, { trip: routing.fetchTrip, drive: routing.drive })
    assert.equal(calls.length, 1)
    assert.match(calls[0][0], /^https:\/\/router\.project-osrm\.org\/trip\/v1\/driving\/-109\.9,31;-111,31;-110\.5,31;-110,31\?source=first&destination=any&roundtrip=false&overview=full&geometries=geojson/)
    assert.match(calls[0][1], /bird-alert/)
    assert.equal(plan.routed, false)
    // From the east: C, then B, then A (whose x and y are covered by then: dropped).
    assert.deepEqual(plan.stops.map((s) => [s.locId, s.new_birds.map((b) => b.code), s.leg_min, s.leg_mi]), [['C', ['y', 'w'], null, null], ['B', ['x', 'z'], null, null]])
    assert.deepEqual([plan.total_min, plan.total_mi, plan.covered, plan.reported, plan.skipped], [null, null, 4, 4, 2])
    assert.deepEqual(plan.geometry, [[31, -109.9], [31, -110], [31, -110.5]])
  } finally {
    global.fetch = realFetch
    console.error = error
  }
})

test('the OSRM trip answer is read into visiting order, miles and minutes, [lat, lng] geometry', async () => {
  const realFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      code: 'Ok',
      waypoints: [{ waypoint_index: 0 }, { waypoint_index: 2 }, { waypoint_index: 1 }],
      trips: [{ duration: 3600, distance: 1609.344 * 50, legs: [{ duration: 600, distance: 1609.344 * 10 }, { duration: 3000, distance: 1609.344 * 40 }], geometry: { coordinates: Array.from({ length: 900 }, (_, i) => [-110 - i / 1000, 31 + i / 1000]) } }]
    })
  })
  try {
    const t = await routing.fetchTrip([{ lat: 31, lng: -110 }, { lat: 31.1, lng: -110.1 }, { lat: 31.2, lng: -110.2 }])
    assert.deepEqual(t.order, [0, 2, 1])
    assert.deepEqual([t.minutes, Math.round(t.miles), t.legs.map((l) => Math.round(l.miles))], [60, 50, [10, 40]])
    assert.ok(t.geometry.length <= 500)
    assert.deepEqual(t.geometry[0], [31, -110])
  } finally { global.fetch = realFetch }
})

test('the route has exactly the scouting\'s access rules: whatever event-scouting refuses, it refuses', async () => {
  const events = require('../lib/events')
  const { eventRoute } = require('../lib/eventRoute')
  const real = events.eventScouting
  const seen = []
  events.eventScouting = async (user, id, opts) => { seen.push([user.id, id, Object.keys(opts).sort()]); const { HttpError } = require('../lib/http'); throw new HttpError(404, 'No such event') }
  try {
    await assert.rejects(eventRoute({ id: 7 }, '12', { from: '31.111,-110.222' }), (e) => e.status === 404)
    assert.deepEqual(seen, [[7, '12', ['fetchFeed', 'now']]])
    // A bad from is refused before anything is read.
    await assert.rejects(eventRoute({ id: 7 }, '12', { from: 'nope' }), (e) => e.status === 400)
    assert.equal(seen.length, 1)
  } finally { events.eventScouting = real }
})
