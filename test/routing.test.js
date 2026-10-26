const { test } = require('node:test')
const assert = require('node:assert/strict')
const { thin, keyFor } = require('../lib/routing')

test('polylines are thinned to a bounded number of points, ends kept', () => {
  const line = Array.from({ length: 1000 }, (_, i) => [i, i])
  const t = thin(line, 50)
  assert.equal(t.length, 50)
  assert.deepEqual(t[0], [0, 0])
  assert.deepEqual(t[49], [999, 999])
  assert.equal(thin(line.slice(0, 10), 50).length, 10)
})

test('a drive is keyed by its rounded points in order', () => {
  assert.equal(keyFor([{ lat: 34.375941, lng: -83.869886 }, { lat: 34.38, lng: -83.83 }]), '34.3759,-83.8699|34.3800,-83.8300')
})
