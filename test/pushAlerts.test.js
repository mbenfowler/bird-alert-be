const { test } = require('node:test')
const assert = require('node:assert/strict')
const { describe, newestPerSpecies } = require('../lib/pushAlerts')

test('one sighting names the bird and place', () => {
  const n = describe([{ comName: 'Snow Goose', locName: 'Lake Lanier', obsDt: '2026-10-20 08:10', speciesCode: 'snogoo' }])
  assert.equal(n.title, 'Snow Goose spotted nearby!')
  assert.match(n.body, /Lake Lanier/)
  assert.equal(n.tag, 'bird-snogoo')
})

test('several sightings are summarised with a count', () => {
  const birds = ['A', 'B', 'C', 'D', 'E'].map((c) => ({ comName: c, locName: 'x', obsDt: 'y', speciesCode: c.toLowerCase() }))
  const n = describe(birds)
  assert.equal(n.title, '5 birds from your watch list spotted nearby!')
  assert.equal(n.body, 'A, B, C and 2 more.')
})

test('only the newest observation per species survives', () => {
  const obs = [{ speciesCode: 'a', subId: 'S2' }, { speciesCode: 'b', subId: 'S3' }, { speciesCode: 'a', subId: 'S1' }]
  assert.deepEqual(newestPerSpecies(obs).map((o) => o.subId), ['S2', 'S3'])
})
