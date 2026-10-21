const { test } = require('node:test')
const assert = require('node:assert/strict')
const { describe, newestPerSpecies, mergeSightings } = require('../lib/pushAlerts')

const obs = (speciesCode, subId, comName = speciesCode) => ({ speciesCode, subId, comName, locName: 'Lake', obsDt: '2026-10-20 08:10' })

test('one watch-list sighting names the bird and place', () => {
  const n = describe(mergeSightings({ watchlist: [obs('snogoo', 'S1', 'Snow Goose')] }))
  assert.equal(n.title, 'Snow Goose spotted nearby!')
  assert.match(n.body, /Lake/)
  assert.equal(n.tag, 'bird-snogoo')
})

test('one notable sighting says so in the title', () => {
  const n = describe(mergeSightings({ notable: [obs('kirwar', 'S9', "Kirtland's Warbler")] }))
  assert.equal(n.title, "Notable sighting nearby: Kirtland's Warbler")
})

test('the same observation in both feeds is announced once, as a watch-list bird', () => {
  const merged = mergeSightings({ watchlist: [obs('a', 'S1')], notable: [obs('a', 'S1'), obs('b', 'S2')] })
  assert.deepEqual(merged.map((s) => [s.speciesCode, s.kind]), [['a', 'both'], ['b', 'notable']])
  const n = describe(merged)
  assert.equal(n.title, '2 sightings nearby (1 watch list, 1 notable)')
  assert.equal(n.body, 'a, b (notable).')
})

test('several sightings are summarised with a count', () => {
  const birds = ['A', 'B', 'C', 'D', 'E'].map((c) => obs(c.toLowerCase(), 'S' + c, c))
  const n = describe(mergeSightings({ watchlist: birds }))
  assert.equal(n.title, '5 birds from your watch list spotted nearby!')
  assert.equal(n.body, 'A, B, C and 2 more.')
})

test('only the newest observation per species survives', () => {
  const list = [{ speciesCode: 'a', subId: 'S2' }, { speciesCode: 'b', subId: 'S3' }, { speciesCode: 'a', subId: 'S1' }]
  assert.deepEqual(newestPerSpecies(list).map((o) => o.subId), ['S2', 'S3'])
})

test('a first of the season keeps that tag even when the bird is also on the watch list', () => {
  const merged = mergeSightings({ watchlist: [obs('whtspa', 'S1')], season: [{ ...obs('whtspa', 'S1'), lastSeenOn: '2026-04-12' }, obs('winwre', 'S2')] })
  assert.deepEqual(merged.map((s) => [s.speciesCode, s.kind, s.lastSeenOn]), [['whtspa', 'season', '2026-04-12'], ['winwre', 'season', undefined]])
})
