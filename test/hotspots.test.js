const { test } = require('node:test')
const assert = require('node:assert/strict')
const { classify, recencyScore, chanceOf, band, bestWindow, rankPlaces, metresBetween, HALF_LIVES } = require('../lib/hotspots')

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

test('the chance is the faded detection rate with effort, a capped inference without, and bands follow it', () => {
  assert.equal(chanceOf({ score: 0.9, detection: 0.92, effort: 13, lastAge: 0, halfLife: 21 }), 92)
  assert.equal(chanceOf({ score: 0.9, detection: 0.92, effort: 13, lastAge: 21, halfLife: 21 }), 65)
  assert.equal(chanceOf({ score: 0.9, detection: 0.25, effort: 4, lastAge: 1, halfLife: 21 }), 25)
  assert.equal(chanceOf({ score: 1, detection: null, effort: 0, lastAge: 0, halfLife: 10 }), 28)
  assert.equal(chanceOf({ score: 3, detection: null, effort: 1, lastAge: 0, halfLife: 10 }), 48, 'inferred chances approach the cap, never High')
  assert.equal(chanceOf({ score: 0.2, detection: null, effort: 0, lastAge: 15, halfLife: 4 }), 7)
  assert.deepEqual([92, 60, 59, 40, 39, 20, 19].map(band), ['High', 'High', 'Good', 'Good', 'Fair', 'Fair', 'Long shot'])
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
  assert.equal(park.chance, 67)
  assert.equal(park.band, 'High')
  assert.equal(park.days, 2)
  assert.deepEqual([park.lat, park.lng], [34.3, -83.7])
  assert.deepEqual(park.lastSeen, { day: '2026-10-25', time: '08:10', subId: 'S1', daysAgo: 0 })
  assert.deepEqual(park.effort, { checklists: 6, withSpecies: 4, detection: 67 })
  assert.equal(park.notes[0].text, 'north ramp')
  assert.equal(park.bestTime, null, 'two timed reports are not enough for a place window')
  assert.equal(dam.effort.detection, null)
  assert.equal(park.isHotspot, true)
  assert.equal(dam.isHotspot, false)
  assert.equal(dam.chance, 9)
  assert.equal(dam.band, 'Long shot')
  assert.equal(dam.lastSeen.daysAgo, 20)
})

test('a personal location near a hotspot folds into it; a distant one and other hotspots stay apart', () => {
  const asOf = '2026-10-25'
  assert.ok(Math.abs(metresBetween({ lat: 34.3, lng: -83.7 }, { lat: 34.3, lng: -83.7 })) < 1)
  const reports = [
    { locId: 'LPARK', locName: 'Don Carter SP', day: '2026-10-20', time: '09:00', lat: 34.3000, lng: -83.7000, isHotspot: true, subId: 'S1' },
    { locId: 'LYARD', locName: 'Don Carter State Park', day: '2026-10-25', time: '07:50', lat: 34.3030, lng: -83.7010, isHotspot: false, subId: 'S2', comment: 'at the boat ramp', observer: 'B' },
    { locId: 'LHOME', locName: 'Home', day: '2026-10-24', time: '08:00', lat: 34.4000, lng: -83.9000, isHotspot: false, subId: 'S3' },
    // Another hotspot 1.5 km off: a yard folds into the nearest hotspot, and never into a hotspot that far.
    { locId: 'LDAM', locName: 'Buford Dam', day: '2026-10-24', time: '08:00', lat: 34.3130, lng: -83.7100, isHotspot: true, subId: 'S4' }
  ]
  const effort = new Map([['LPARK', { checklists: 2, withSpecies: 1 }], ['LYARD', { checklists: 3, withSpecies: 3 }], ['LDAM', { checklists: 4, withSpecies: 1 }]])
  const places = rankPlaces({ reports, effort, asOf, halfLife: 21 })
  const ids = places.map((p) => p.locId)
  assert.ok(ids.includes('LPARK') && ids.includes('LDAM') && ids.includes('LHOME') && !ids.includes('LYARD'), ids.join(','))
  const park = places.find((p) => p.locId === 'LPARK')
  assert.equal(park.locName, 'Don Carter SP')
  assert.equal(park.days, 2)
  assert.deepEqual(park.lastSeen.subId, 'S2')
  assert.deepEqual(park.effort, { checklists: 5, withSpecies: 4, detection: 80 })
  assert.equal(park.notes[0].text, 'at the boat ramp')
  assert.deepEqual(park.merged, [{ locId: 'LYARD', locName: 'Don Carter State Park' }])
  assert.deepEqual(places.find((p) => p.locId === 'LDAM').merged, [])
  assert.equal(effort.get('LPARK').checklists, 2, 'the caller\'s effort map is not mutated')
})

test('a place gets its own best window once it has five timed reports', () => {
  const reports = ['06:30', '07:10', '07:40', '06:55', '07:20', '15:00'].map((time, i) => ({ locId: 'L1', locName: 'Park', day: `2026-10-${10 + i}`, time, subId: `S${i}` }))
  const [park] = rankPlaces({ reports, asOf: '2026-10-25', halfLife: 21 })
  assert.equal(park.bestTime.label, '6 am to 8 am')
  assert.equal(park.bestTime.samples, 6)
})
