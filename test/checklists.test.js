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

test('an eBird call in the sync never runs more than a few seconds past the deadline', () => {
  const { callBudget } = require('../lib/checklists')
  const now = Date.now()
  assert.equal(callBudget(Infinity), 15_000, 'a long way from the deadline, the usual limit')
  const near = callBudget(now + 2_000)
  assert.ok(near <= 7_000 && near > 6_000, String(near))
  assert.equal(callBudget(now - 60_000), 1000, 'long past it, a token second')
})

test('retention starts only with time to finish, else the next call does it', async () => {
  const { pruneWithin, RETENTION_RESERVE_MS } = require('../lib/retention')
  let ran = 0
  const prune = async () => { ran += 1; return { checklists: 3 } }
  const due = async () => true
  assert.deepEqual(await pruneWithin(Date.now() + RETENTION_RESERVE_MS + 10_000, { prune, due }), { retention: { checklists: 3 }, more: false })
  assert.deepEqual(await pruneWithin(Date.now() + RETENTION_RESERVE_MS - 1_000, { prune, due }), { retention: null, more: true })
  assert.deepEqual(await pruneWithin(Date.now() - 1_000, { prune, due: async () => false }), { retention: null, more: false }, 'already done today: nothing to wait for')
  assert.equal(ran, 1)
})
