const { test } = require('node:test')
const assert = require('node:assert/strict')
const { addDays, yearAgo, daysBetween, expectedSpecies } = require('../lib/seasonality')

const range = (from, to) => new Set(daysBetween(from, to))

test('date helpers work in UTC calendar days, across years and leap days', () => {
  assert.equal(addDays('2026-10-20', 7), '2026-10-27')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
  assert.equal(yearAgo('2026-10-20'), '2025-10-20')
  assert.equal(yearAgo('2024-02-29'), '2023-03-01')
  assert.equal(daysBetween('2026-10-30', '2026-11-02').length, 4)
})

test('expected species: present this time last year; migrants were absent two to four months earlier', () => {
  const day = '2026-10-20'
  const lastYear = new Map([
    // Reported every day last year: a resident.
    ['resident', range('2025-06-01', '2025-11-30')],
    // Arrived Oct 12 last year and stayed: a returning migrant.
    ['migrant', range('2025-10-12', '2025-11-30')],
    // Around in June and again now: a resident that goes under-reported.
    ['sporadic', new Set(['2025-06-25', '2025-07-15', '2025-10-18', '2025-10-19', '2025-10-21'])],
    // One report in the window, none around it: not regular enough to expect.
    ['vagrant', new Set(['2025-10-20'])],
    // Gone by this time last year.
    ['summer', range('2025-05-01', '2025-09-01')]
  ])
  const all = expectedSpecies(lastYear, day, { migrantTest: false })
  assert.deepEqual(all.map((s) => s.speciesCode), ['migrant', 'resident', 'sporadic', 'vagrant'])
  const migrants = expectedSpecies(lastYear, day)
  assert.deepEqual(migrants.map((s) => s.speciesCode), ['migrant'])
  assert.deepEqual(migrants[0], { speciesCode: 'migrant', daysLastYear: 15, windowDays: 15, firstLastYear: '2025-10-12', migrant: true })
})
