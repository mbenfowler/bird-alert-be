const { test } = require('node:test')
const assert = require('node:assert/strict')
const { newestPerSpecies, mergeSightings } = require('../lib/pushAlerts')

const obs = (speciesCode, subId, comName = speciesCode) => ({ speciesCode, subId, comName, locName: 'Lake', obsDt: '2026-10-20 08:10' })

test('the same observation in both feeds is announced once, as a watch-list bird', () => {
  const merged = mergeSightings({ watchlist: [obs('a', 'S1')], notable: [obs('a', 'S1'), obs('b', 'S2')] })
  assert.deepEqual(merged.map((s) => [s.speciesCode, s.kind]), [['a', 'both'], ['b', 'notable']])
})

test('only the newest observation per species survives', () => {
  const list = [{ speciesCode: 'a', subId: 'S2' }, { speciesCode: 'b', subId: 'S3' }, { speciesCode: 'a', subId: 'S1' }]
  assert.deepEqual(newestPerSpecies(list).map((o) => o.subId), ['S2', 'S3'])
})

test('a first of the season keeps that tag even when the bird is also on the watch list', () => {
  const merged = mergeSightings({ watchlist: [obs('whtspa', 'S1')], season: [{ ...obs('whtspa', 'S1'), lastSeenOn: '2026-04-12' }, obs('winwre', 'S2')] })
  assert.deepEqual(merged.map((s) => [s.speciesCode, s.kind, s.lastSeenOn]), [['whtspa', 'season', '2026-04-12'], ['winwre', 'season', undefined]])
})

test('a lifer outranks every other reason for a sighting', () => {
  const bunting = { speciesCode: 'paibun', subId: 'S1' }
  const merged = mergeSightings({ watchlist: [bunting], notable: [bunting], lifer: [bunting, { speciesCode: 'sedwre', subId: 'S2' }] })
  assert.deepEqual(merged.map((m) => [m.speciesCode, m.kind]), [['paibun', 'lifer'], ['sedwre', 'lifer']])
})
