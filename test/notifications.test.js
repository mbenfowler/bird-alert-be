const { test } = require('node:test')
const assert = require('node:assert/strict')
const { sightingNotification, watchlistNotification, summaryNotification, formatObsDt } = require('../lib/notifications')
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
  assert.deepEqual(n.actions.map((a) => a.action), ['map', 'ebird'])
  assert.equal(n.data.ebirdUrl, 'https://ebird.org/checklist/S1')
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
  // Lake Lanier at zoom 14 lands in tile column 4373, row 6530 (checked against tile.openstreetmap.org).
  assert.equal(Math.floor(lonToX(-83.9014, 14)), 4373)
  assert.equal(Math.floor(latToY(34.2695, 14)), 6530)
})

test('a first of the season says so, with when it was last around', () => {
  const n = sightingNotification({ ...sighting, kind: 'season', lastSeenOn: '2026-04-12' })
  assert.equal(n.title, '🍂 First Snow Goose of the season!')
  assert.equal(n.body, 'Lake Lanier · Oct 20, 1:49 PM · 3 seen · first since Apr 12')
  const spring = sightingNotification({ ...sighting, obsDt: '2026-03-30 09:00', kind: 'season' })
  assert.match(spring.title, /^🌱 First/)
  assert.match(spring.body, /first in over a year$/)
})

test('watch-list sightings share one notification with a line per bird and no map', () => {
  const second = { ...sighting, speciesCode: 'cangoo', comName: 'Canada Goose', locName: 'Clarks Bridge', obsDt: '2026-10-20 15:10', subId: 'S2' }
  const n = watchlistNotification([sighting, second], new Map([['snogoo', { birdImg: 'https://img/snogoo.jpg' }]]))
  assert.equal(n.title, '⭐ 2 watch list birds spotted nearby')
  assert.equal(n.body, 'Snow Goose · Lake Lanier · Oct 20, 1:49 PM\nCanada Goose · Clarks Bridge · Oct 20, 3:10 PM')
  assert.equal(n.image, undefined)
  assert.ok(n.icon.endsWith('/images/bird.png'), 'a list shows the app icon')
  assert.deepEqual(n.actions.map((a) => a.action), ['app'])
  assert.deepEqual(n.data.speciesCodes, ['snogoo', 'cangoo'])
  assert.equal(n.data.kind, 'watchlist')
})

test('a lone watch-list bird keeps its photo and the usual title', () => {
  const n = watchlistNotification([sighting], new Map([['snogoo', { birdImg: 'https://img/snogoo.jpg' }]]))
  assert.equal(n.title, '⭐ Snow Goose spotted nearby!')
  assert.equal(n.icon, 'https://img/snogoo.jpg')
  assert.equal(n.image, undefined)
})

test('a long watch-list run names six birds and counts the rest', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ ...sighting, speciesCode: `b${i}`, comName: `Bird ${i}`, subId: `S${i}` }))
  const n = watchlistNotification(many)
  assert.equal(n.title, '⭐ 9 watch list birds spotted nearby')
  assert.equal(n.body.split('\n').length, 7)
  assert.ok(n.body.endsWith('and 3 more'))
})
