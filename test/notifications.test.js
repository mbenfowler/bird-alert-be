const { test } = require('node:test')
const assert = require('node:assert/strict')
const { sightingNotification, summaryNotification, formatObsDt } = require('../lib/notifications')
const { lonToX, latToY } = require('../lib/staticMap')

const sighting = { speciesCode: 'snogoo', comName: 'Snow Goose', locName: 'Lake Lanier', obsDt: '2026-10-20 13:49', howMany: 3, lat: 34.2695, lng: -83.9014, subId: 'S1', kind: 'watchlist' }

test('observation times read naturally', () => {
  assert.equal(formatObsDt('2026-10-20 13:49'), 'Oct 20, 1:49 PM')
  assert.equal(formatObsDt('2026-10-20 00:05'), 'Oct 20, 12:05 AM')
  assert.equal(formatObsDt('2026-10-20'), 'Oct 20')
})

test('a watch-list sighting carries photo, map, actions and the essentials in the text', () => {
  const n = sightingNotification(sighting, { birdImg: 'https://img/snogoo.jpg' })
  assert.equal(n.title, '⭐ Snow Goose spotted nearby!')
  assert.equal(n.body, 'Lake Lanier · Oct 20, 1:49 PM · 3 seen')
  assert.equal(n.icon, 'https://img/snogoo.jpg')
  assert.match(n.image, /\/api\/map\?lat=34\.2695&lng=-83\.9014&zoom=14$/)
  assert.equal(n.tag, 'sighting-snogoo-S1')
  assert.deepEqual(n.actions.map((a) => a.action), ['map', 'app'])
  assert.equal(n.data.lat, 34.2695)
})

test('a notable sighting is labelled and falls back to the app icon without a photo', () => {
  const n = sightingNotification({ ...sighting, kind: 'notable', howMany: 1 })
  assert.equal(n.title, '❗ Notable: Snow Goose reported nearby')
  assert.equal(n.body, 'Lake Lanier · Oct 20, 1:49 PM')
  assert.match(n.icon, /\/images\/bird\.png$/)
})

test('overflow becomes one summary', () => {
  const n = summaryNotification(['A', 'B', 'C', 'D', 'E'].map((c) => ({ comName: c })))
  assert.equal(n.title, '5 more sightings nearby')
  assert.equal(n.body, 'A, B, C and 2 more.')
})

test('tile maths matches the slippy-map convention', () => {
  // At zoom 0 the world is one tile; the equator/prime meridian sits at its centre.
  assert.equal(lonToX(0, 0), 0.5)
  assert.ok(Math.abs(latToY(0, 0) - 0.5) < 1e-9)
  // Lake Lanier at zoom 14 lands in tile column 4373, row 6529 (checked against tile.openstreetmap.org).
  assert.equal(Math.floor(lonToX(-83.9014, 14)), 4373)
  assert.equal(Math.floor(latToY(34.2695, 14)), 6529)
})
