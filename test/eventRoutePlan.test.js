const { test } = require('node:test')
const assert = require('node:assert/strict')
const { cleanPlan } = require('../lib/eventRoutePlan')

const stop = { locId: 'L123', name: 'Ramsey Canyon', lat: 31.4501234, lng: -110.3000049 }

test('a saved route: stops to 5 decimals and a locId or null, the start to 2 (as the suggestion\'s from), the version as read', () => {
  assert.deepEqual(cleanPlan({ start: { name: 'Motel', lat: 31.40491, lng: -110.25512 }, stops: [stop, { name: 'A house', lat: 31.5, lng: -110.2 }], version: '3' }), {
    start: { name: 'Motel', lat: 31.4, lng: -110.26 },
    stops: [{ locId: 'L123', name: 'Ramsey Canyon', lat: 31.45012, lng: -110.3 }, { locId: null, name: 'A house', lat: 31.5, lng: -110.2 }],
    version: 3
  })
  assert.deepEqual(cleanPlan({ stops: [], version: 0 }), { start: null, stops: [], version: 0 })
})

test('a saved route that isn\'t one is a 400', () => {
  for (const bad of [
    null, { stops: {}, version: 0 }, { stops: Array(9).fill(stop), version: 0 }, { stops: [{ ...stop, lat: NaN }], version: 0 }, { stops: [{ ...stop, lng: '1' }], version: 0 },
    { stops: [{ ...stop, name: 'x'.repeat(201) }], version: 0 }, { stops: [{ ...stop, locId: 'S1' }], version: 0 }, { stops: [stop], start: { name: 'Home', lat: 1, lng: null }, version: 0 },
    { stops: [stop], start: { lat: 1, lng: 2 }, version: 0 }, { stops: [stop] }, { stops: [stop], version: 1.5 }, { stops: [stop], version: -1 }
  ]) assert.throws(() => cleanPlan(bad), (e) => e.status === 400, JSON.stringify(bad))
  assert.equal(cleanPlan({ stops: [{ ...stop, name: 'x'.repeat(200) }], version: 0 }).stops[0].name.length, 200)
})
