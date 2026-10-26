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

test('the route weighs driving: two neighbours beat a far stop that adds a little more', () => {
  const { pickRoute } = require('../lib/whereToGo')
  const bird = (speciesCode, chance) => ({ speciesCode, comName: speciesCode, chance, band: 'Good', lastSeen: { daysAgo: 1 }, note: null })
  // Chicopee and Elachee are a kilometre apart; North Hall is 15 km away and offers one more bird.
  const chicopee = { locId: 'CH', locName: 'Chicopee Lake', lat: 34.2470, lng: -83.8470, isHotspot: true, expected: 1.6, birds: [bird('a', 80), bird('b', 80)] }
  const elachee = { locId: 'EL', locName: 'Elachee', lat: 34.2540, lng: -83.8470, isHotspot: true, expected: 1.3, birds: [bird('c', 70), bird('d', 60)] }
  const north = { locId: 'NH', locName: 'North Hall', lat: 34.3900, lng: -83.8470, isHotspot: true, expected: 1.4, birds: [bird('e', 70), bird('f', 70)] }
  const route = pickRoute([chicopee, north, elachee], { maxStops: 3 })
  assert.deepEqual(route.stops.map((s) => s.locId).sort(), ['CH', 'EL'])
  // The neighbours are visited back to back, never with the far one between them.
  const all = pickRoute([chicopee, north, elachee].map((p) => p.locId === 'NH' ? { ...p, birds: [bird('e', 99), bird('f', 99), bird('g', 99), bird('h', 99)], expected: 4 } : p), { maxStops: 3 })
  const ids = all.stops.map((s) => s.locId)
  assert.equal(ids.length, 3)
  assert.equal(Math.abs(ids.indexOf('CH') - ids.indexOf('EL')), 1, `order ${ids.join(' → ')}`)
})

test('a starting point pulls the route toward it and starts the directions there', () => {
  const { parseOrigin } = require('../lib/whereToGo')
  const bird = (code, chance) => ({ speciesCode: code, comName: code, chance })
  const near = { locId: 'N', locName: 'Near', lat: 34.30, lng: -83.80, isHotspot: true, expected: 1, birds: [bird('a', 100)] }
  const far = { locId: 'F', locName: 'Far', lat: 34.80, lng: -83.80, isHotspot: true, expected: 1, birds: [bird('a', 100)] }
  assert.equal(pickRoute([far, near], { maxStops: 1, origin: { lat: 34.80, lng: -83.80 } }).stops[0].locId, 'F')
  assert.equal(pickRoute([far, near], { maxStops: 1, origin: { lat: 34.30, lng: -83.80 } }).stops[0].locId, 'N')
  // Two stops from the far end: the far one comes first.
  const other = { ...near, locId: 'N2', birds: [bird('b', 100)] }
  const route = pickRoute([far, { ...other, lat: 34.31 }, { ...near, locId: 'N3', birds: [bird('c', 100)], lat: 34.75 }], { maxStops: 2, origin: { lat: 34.82, lng: -83.80 } })
  assert.deepEqual(route.stops.map((s) => s.locId), ['F', 'N3'])
  assert.match(pickRoute([near], { origin: { lat: 34.2, lng: -83.7 } }).url, /origin=34\.2%2C-83\.7/)
  assert.deepEqual(parseOrigin('34.2345,-83.8765'), { lat: 34.23, lng: -83.88 })
  assert.equal(parseOrigin('nope'), null)
  assert.equal(parseOrigin(''), null)
})
