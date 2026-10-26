const { test } = require('node:test')
const assert = require('node:assert/strict')
const { classify, recencyScore, band, bestWindow, rankPlaces, HALF_LIVES } = require('../lib/hotspots')

test('species fall into persistence classes from their own year, and notable wins', () => {
  assert.equal(classify({ monthsPresent: 12, daysLastYear: 300 }), 'resident')
  assert.equal(classify({ monthsPresent: 6, daysLastYear: 90 }), 'seasonal')
  assert.equal(classify({ monthsPresent: 2, daysLastYear: 20 }), 'passage')
  assert.equal(classify({ monthsPresent: 8, daysLastYear: 8 }), 'passage')
  assert.equal(classify({ monthsPresent: 12, daysLastYear: 300, notable: true }), 'rare')
  assert.deepEqual(HALF_LIVES, { resident: 21, seasonal: 10, passage: 4, rare: 2 })
})

test('a report keeps half its value after one half-life, and days are counted once', () => {
  assert.equal(recencyScore(['2026-10-25'], '2026-10-25', 4), 1)
  assert.equal(recencyScore(['2026-10-21'], '2026-10-25', 4), 0.5)
  assert.equal(recencyScore(['2026-10-21', '2026-10-21'], '2026-10-25', 4), 0.5)
  assert.ok(recencyScore(['2026-10-15'], '2026-10-25', 21) > recencyScore(['2026-10-15'], '2026-10-25', 2))
})

test('bands weigh detection when effort is enough, recency otherwise, and staleness caps them', () => {
  assert.equal(band({ score: 0.9, detection: 0.6, effort: 5, lastAge: 1, halfLife: 10 }), 'High')
  assert.equal(band({ score: 0.9, detection: 0.6, effort: 2, lastAge: 1, halfLife: 10 }), 'Fair')
  assert.equal(band({ score: 3, detection: null, effort: 0, lastAge: 1, halfLife: 10 }), 'High')
  assert.equal(band({ score: 1.3, detection: null, effort: 0, lastAge: 3, halfLife: 10 }), 'Good')
  assert.equal(band({ score: 3, detection: 0.9, effort: 9, lastAge: 25, halfLife: 10 }), 'Fair')
  assert.equal(band({ score: 0.1, detection: null, effort: 1, lastAge: 20, halfLife: 4 }), 'Long shot')
})

test('the best window is the busiest two hours, only with enough reports', () => {
  assert.equal(bestWindow(['07:10', '07:30', '08:15', '09:00']), null)
  const w = bestWindow(['07:10', '07:30', '06:50', '08:15', '09:00', '13:00', '07:59'])
  assert.deepEqual({ from: w.from, to: w.to, label: w.label, samples: w.samples }, { from: 6, to: 8, label: '6 am to 8 am', samples: 7 })
  assert.equal(bestWindow(['17:00', '17:30', '18:10', '16:20', '17:45']).label, '4 pm to 6 pm')
})

test('places merge every source, keep coordinates and notes, and rank by band then score', () => {
  const asOf = '2026-10-25'
  const reports = [
    { locId: 'L1', locName: 'Park', day: '2026-10-25', time: '08:10', lat: 34.3, lng: -83.7, isHotspot: true, subId: 'S1', comment: 'north ramp', observer: 'A' },
    { locId: 'L1', locName: 'Park', day: '2026-10-24', time: '07:00', subId: 'S2' },
    { locId: 'L1', day: '2026-10-24', time: '07:00', subId: 'S2' },
    { locId: 'L2', locName: 'Dam', day: '2026-10-05', isHotspot: false, subId: 'S3' },
    { locId: 'L3', locName: 'Old', day: '2026-08-01' },
    { locId: null, day: '2026-10-25' }
  ]
  const effort = new Map([['L1', { checklists: 6, withSpecies: 4 }], ['L2', { checklists: 1, withSpecies: 1 }]])
  const places = rankPlaces({ reports, effort, asOf, halfLife: 10 })
  assert.deepEqual(places.map((p) => p.locId), ['L1', 'L2'])
  const [park, dam] = places
  assert.equal(park.band, 'High')
  assert.equal(park.days, 2)
  assert.deepEqual([park.lat, park.lng], [34.3, -83.7])
  assert.deepEqual(park.lastSeen, { day: '2026-10-25', time: '08:10', subId: 'S1', daysAgo: 0 })
  assert.deepEqual(park.effort, { checklists: 6, withSpecies: 4, detection: 67 })
  assert.equal(park.notes[0].text, 'north ramp')
  assert.equal(dam.effort.detection, null)
  assert.equal(park.isHotspot, true)
  assert.equal(dam.isHotspot, false)
  assert.equal(dam.band, 'Long shot')
  assert.equal(dam.lastSeen.daysAgo, 20)
})
