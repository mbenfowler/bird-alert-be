const { test } = require('node:test')
const assert = require('node:assert/strict')
const { listRow, speciesRows } = require('../lib/checklists')
const { dayRows, timeOf } = require('../lib/seasonality')

test('a listed checklist becomes a row with its day, time and place', () => {
  const row = listRow('US-GA-139', { locId: 'L123', subId: 'S405330020', userDisplayName: 'A Birder', numSpecies: 12, obsDt: '25 Oct 2026', obsTime: '11:44', isoObsDate: '2026-10-25 11:44', loc: { locName: 'Clarks Bridge Park', latitude: 34.35, longitude: -83.75, isHotspot: true } })
  assert.deepEqual(row, { sub_id: 'S405330020', region: 'US-GA-139', loc_id: 'L123', loc_name: 'Clarks Bridge Park', lat: 34.35, lng: -83.75, is_hotspot: true, obs_day: '2026-10-25', obs_time: '11:44', num_species: 12, observer: 'A Birder' })
  assert.equal(listRow('US-GA-139', { subId: 'S1', locId: 'L1', isoObsDate: 'garbage' }), null)
  assert.equal(listRow('US-GA-139', { locId: 'L1', isoObsDate: '2026-10-25 11:44' }), null)
})

test('a checklist view yields one species row each with note and media counts', () => {
  const rows = speciesRows('S1', { obs: [
    { speciesCode: 'pursan', howManyAtleast: 1, comments: '  North boat ramp, in the sweetgums  ', mediaCounts: { P: 2, A: 1 } },
    { speciesCode: 'blkvul', howManyAtleast: 12 },
    { speciesCode: null }
  ] })
  assert.deepEqual(rows, [
    { sub_id: 'S1', species_code: 'pursan', how_many: 1, comments: 'North boat ramp, in the sweetgums', photos: 2, audio: 1, video: 0 },
    { sub_id: 'S1', species_code: 'blkvul', how_many: 12, comments: null, photos: 0, audio: 0, video: 0 }
  ])
})

test("a history day's rows keep each species' place and time, first report wins", () => {
  assert.equal(timeOf('2026-10-20 08:10'), '08:10')
  assert.equal(timeOf('2026-10-20'), null)
  const rows = dayRows('US-GA-139', '2026-10-20', [
    { speciesCode: 'reshaw', locId: 'L2664464', locName: 'Lanier Village Estates', obsDt: '2026-10-20 08:10', subId: 'S1' },
    { speciesCode: 'reshaw', locId: 'L9', locName: 'Elsewhere', obsDt: '2026-10-20 09:00', subId: 'S2' },
    { speciesCode: 'cangoo', locId: 'L5', locName: 'Lake', obsDt: '2026-10-20' }
  ])
  assert.deepEqual(rows, [
    { region: 'US-GA-139', day: '2026-10-20', speciesCode: 'reshaw', locId: 'L2664464', locName: 'Lanier Village Estates', obsTime: '08:10', subId: 'S1' },
    { region: 'US-GA-139', day: '2026-10-20', speciesCode: 'cangoo', locId: 'L5', locName: 'Lake', obsTime: null, subId: null }
  ])
})
