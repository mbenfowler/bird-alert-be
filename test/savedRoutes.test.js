const { test } = require('node:test')
const assert = require('node:assert/strict')
const { cleanPoint, cleanStops } = require('../lib/savedRoutes')

test('route points are cleaned to the fields the page uses', () => {
  assert.deepEqual(cleanPoint({ locId: 'L22341308', name: ' Yahoola Creek Park ', lat: '34.53', lng: -83.96, note: '', extra: 'x' }), { locId: 'L22341308', name: 'Yahoola Creek Park', lat: 34.53, lng: -83.96, note: null })
  assert.equal(cleanPoint({ locId: null, name: 'Home', lat: 34, lng: -83 }).locId, null)
  assert.equal(cleanPoint({ name: 'x'.repeat(500), lat: 1, lng: 1 }).name.length, 200)
  for (const bad of [null, {}, { name: 'a', lat: 91, lng: 0 }, { name: '', lat: 1, lng: 1 }, { name: 'a', lat: 1, lng: 1, locId: 'drop table' }]) assert.throws(() => cleanPoint(bad), /Invalid point/)
})

test('a route is up to eight stops, or null to go back to the suggestion', () => {
  assert.equal(cleanStops(null), null)
  assert.throws(() => cleanStops(Array(9).fill({ name: 'a', lat: 1, lng: 1 })), /up to 8/)
  assert.throws(() => cleanStops('nope'), /up to 8/)
})
