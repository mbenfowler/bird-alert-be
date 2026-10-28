const { test } = require('node:test')
const assert = require('node:assert/strict')
const { assess } = require('../lib/chase')

const now = Date.parse('2026-10-27T18:00')

test('a bird on the latest checklists is fresh, and the newest find counts as last seen', () => {
  const r = assess({ lastSeen: '2026-10-27 08:54', now, looks: [{ obsDt: '2026-10-27 14:57', found: true }, { obsDt: '2026-10-27 14:40', found: true }, { obsDt: '2026-10-27 12:00', found: false }] })
  assert.equal(r.lastSeen, '2026-10-27 14:57')
  assert.equal(r.missesSince, 0)
  assert.equal(r.verdict, 'fresh')
  assert.deepEqual([r.checkedSince, r.foundSince], [3, 2])
})

test('every checklist that misses it lowers the chance, more so for an easy bird', () => {
  const looks = (n) => Array.from({ length: n }, (_, i) => ({ obsDt: `2026-10-27 1${i}:00`, found: false }))
  const one = assess({ lastSeen: '2026-10-27 08:00', now, looks: looks(1) })
  const four = assess({ lastSeen: '2026-10-27 08:00', now, looks: looks(4) })
  assert.ok(four.stillThere < one.stillThere)
  assert.equal(four.verdict, 'gone')
  assert.ok(four.chance <= four.stillThere)
})

test('with no checklists since, the chance only fades with time', () => {
  const day = assess({ lastSeen: '2026-10-26 18:00', now, looks: [] })
  const week = assess({ lastSeen: '2026-10-20 18:00', now, looks: [] })
  assert.equal(day.stillThere, 71)
  assert.equal(day.verdict, 'likely')
  assert.ok(week.stillThere < 10)
  assert.equal(assess({ lastSeen: null, now, looks: [] }).verdict, 'unknown')
})

test('a resident bird fades slower than a rarity', () => {
  const rare = assess({ lastSeen: '2026-10-24 18:00', now, looks: [] })
  const resident = assess({ lastSeen: '2026-10-24 18:00', now, looks: [], halfLifeHours: 504 })
  assert.ok(resident.stillThere > rare.stillThere)
})
