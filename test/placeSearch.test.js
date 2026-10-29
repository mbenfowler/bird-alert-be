const { test } = require('node:test')
const assert = require('node:assert/strict')
const { shortLabel, parsePoints, words } = require('../lib/placeSearch')

test('Nominatim labels lose the county, zip and country', () => {
  assert.equal(shortLabel('Yahoola Creek Park, Dahlonega, Lumpkin County, Georgia, 30533, United States'), 'Yahoola Creek Park, Dahlonega, Georgia')
  assert.equal(shortLabel('Gainesville, Hall County, Georgia, United States'), 'Gainesville, Georgia')
  assert.equal(shortLabel('Bosque de Chapultepec, Miguel Hidalgo, Ciudad de México, 11580, México'), 'Bosque de Chapultepec, Miguel Hidalgo, Ciudad de México')
})

test('route points are parsed and bounded', () => {
  assert.deepEqual(parsePoints('34.3,-83.8;34.5,-83.9'), [{ lat: 34.3, lng: -83.8 }, { lat: 34.5, lng: -83.9 }])
  assert.throws(() => parsePoints('34.3,-83.8'), /Between 2 and 10/)
  assert.throws(() => parsePoints(Array(11).fill('1,1').join(';')), /Between 2 and 10/)
  assert.throws(() => parsePoints('91,0;1,1'), /Invalid point/)
  assert.throws(() => parsePoints('a,b;1,1'), /Invalid point/)
})

test('search words drop punctuation and are capped', () => {
  assert.deepEqual(words("  Yahoola-Creek  park! "), ['yahoola', 'creek', 'park'])
  assert.equal(words('a b c d e f g h').length, 6)
})
