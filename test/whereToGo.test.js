const { test } = require('node:test')
const assert = require('node:assert/strict')
const { aggregatePlaces, pickRoute, mapsRouteUrl } = require('../lib/whereToGo')

const place = (locId, locName, chance, extra = {}) => ({ locId, locName, lat: 34 + (locId.length / 100), lng: -83, isHotspot: true, chance, band: chance >= 60 ? 'High' : 'Good', lastSeen: { day: '2026-10-25', time: '08:00', subId: null, daysAgo: 0 }, notes: [], bestTime: null, ...extra })
const results = [
  { speciesCode: 'norcar', bestTime: { label: '8 am to 10 am', source: 'reports' }, places: [place('LA', 'Park', 90), place('LB', 'Dam', 40), place('LY', 'Yard', 95, { isHotspot: false })] },
  { speciesCode: 'hoomer', bestTime: { label: '6 am to 8 am', source: 'reports' }, places: [place('LB', 'Dam', 70, { bestTime: { label: '4 pm to 6 pm', share: 60, samples: 6 } }), place('LC', 'Cove', 60)] },
  { speciesCode: 'whtspa', bestTime: { label: 'Morning', source: 'typical' }, places: [place('LA', 'Park', 50)] }
]
const names = new Map([['norcar', 'Northern Cardinal'], ['hoomer', 'Hooded Merganser'], ['whtspa', 'White-throated Sparrow']])

test('places fold together with expected birds, named birds in chance order, and a voted window', () => {
  const places = aggregatePlaces(results, names)
  assert.deepEqual(places.map((p) => [p.locId, p.expected]), [['LA', 1.4], ['LB', 1.1], ['LY', 1], ['LC', 0.6]])
  const park = places[0]
  assert.deepEqual(park.birds.map((b) => [b.comName, b.chance]), [['Northern Cardinal', 90], ['White-throated Sparrow', 50]])
  assert.equal(park.bestTime, '8 am to 10 am')
  assert.equal(places[1].bestTime, '4 pm to 6 pm', "a place's own window outranks the species window")
  assert.equal(park.seenToday, true)
  assert.equal(places[2].isHotspot, false)
})

test('the route covers different birds rather than the same bird thrice, and skips yards', () => {
  const places = aggregatePlaces(results, names)
  const route = pickRoute(places, { maxStops: 2 })
  assert.deepEqual(route.stops.map((s) => s.locId), ['LA', 'LB'])
  // Cardinal 90% at the park plus 40% at the dam -> 94%; sparrow 50%; merganser 70%: 2.1 birds covered.
  assert.equal(route.covers, 2.1)
  assert.match(route.url, /google\.com\/maps\/dir\/\?api=1&destination=34\.02%2C-83&waypoints=34\.02%2C-83&travelmode=driving/)
  assert.equal(pickRoute([]).url, null)
  assert.equal(mapsRouteUrl([{ lat: 1, lng: 2 }]), 'https://www.google.com/maps/dir/?api=1&destination=1%2C2&travelmode=driving')
})
