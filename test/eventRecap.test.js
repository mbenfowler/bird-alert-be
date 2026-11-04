const { test } = require('node:test')
const assert = require('node:assert/strict')
const recap = require('../lib/eventRecap')
const { wallTime } = require('../lib/timezones')

const bigDay = { id: 7, state: 'AZ', location: 'US-AZ-003', timezone: 'America/Phoenix', starts_on: '2026-11-10', ends_on: '2026-11-10', kind: 'bigday' }
// A tally row as the table has it; `min` minutes after 5 AM Phoenix time on the day.
const row = (id, code, min, extra = {}) => ({ id, species_code: code, observed_at: new Date(Date.parse('2026-11-10T12:00:00Z') + min * 60_000), added_by: 1, stop_index: null, ...extra })

test('a wall-clock time in a zone, the day the clocks change included', () => {
  assert.equal(wallTime('2026-11-11', 3, 'America/Phoenix').toISOString(), '2026-11-11T10:00:00.000Z')
  assert.equal(wallTime('2026-11-01', 3, 'America/New_York').toISOString(), '2026-11-01T08:00:00.000Z', 'after falling back')
  assert.equal(wallTime('2026-03-08', 3, 'America/New_York').toISOString(), '2026-03-08T07:00:00.000Z', 'after springing forward')
  assert.equal(wallTime('2026-11-11', 3, 'Not/AZone').toISOString(), '2026-11-11T03:00:00.000Z', 'an unknown zone is UTC')
})

test('the recap is live until 3 AM the morning after, open for fixes 48 hours, then sealed, in the event\'s zone', () => {
  const at = (iso) => recap.recapClock(bigDay, new Date(iso))
  assert.equal(at('2026-11-11T09:59:00Z').status, 'live', '2:59 AM in Phoenix')
  assert.equal(at('2026-11-11T10:00:00Z').status, 'open')
  assert.equal(at('2026-11-11T10:00:00Z').closesAt.toISOString(), '2026-11-11T10:00:00.000Z')
  assert.equal(at('2026-11-11T10:00:00Z').fixesUntil.toISOString(), '2026-11-13T10:00:00.000Z')
  assert.equal(at('2026-11-13T09:59:59Z').status, 'open')
  assert.equal(at('2026-11-13T10:00:00Z').status, 'sealed')
  // A trip runs to its last day; no stored zone: its area's.
  const trip = { state: 'GA', location: 'US-GA-139', starts_on: '2026-11-10', ends_on: '2026-11-12' }
  assert.equal(recap.recapClock(trip, new Date('2026-11-13T07:59:00Z')).status, 'live', '2:59 AM in Atlanta')
  assert.equal(recap.recapClock(trip, new Date('2026-11-13T08:00:00Z')).status, 'open')
})

test('the share code: the id and an HMAC, checked by working it out again', () => {
  const code = recap.recapCode(2)
  assert.match(code, /^2-[0-9a-z]{6}$/)
  assert.equal(recap.readRecapCode(code), 2)
  assert.equal(recap.readRecapCode(code.toUpperCase()), 2, 'case doesn\'t matter')
  assert.equal(recap.readRecapCode(`3-${code.slice(2)}`), null, 'another event\'s id with this tag')
  assert.equal(recap.readRecapCode('2-zzzzzz'), null)
  for (const bad of ['', '2', '02-abcdef', 'x', null, undefined, '2-abc']) assert.equal(recap.readRecapCode(bad), null, String(bad))
  assert.equal(recap.readRecapCode(recap.recapCode(123456)), 123456)
})

test('the timeline: in the order seen, added_at for older rows, ties by the row added first', () => {
  const ordered = recap.inOrder([
    row(3, 'grhowl', 0),
    row(1, 'comrav', 20),
    { id: 2, species_code: 'mexjay', observed_at: null, added_at: new Date('2026-11-10T12:10:00Z') },
    row(4, 'acowoo', 20)
  ])
  assert.deepEqual(ordered.map((t) => t.species_code), ['grhowl', 'mexjay', 'comrav', 'acowoo'])
  assert.equal(ordered[1].at, '2026-11-10T12:10:00.000Z')
  assert.deepEqual(recap.inOrder([]), [])
})

test('lifers: each member\'s, against their list before the event, numbered on from it; none claimed for a list too short to judge by', () => {
  const ordered = recap.inOrder([row(1, 'grhowl', 0), row(2, 'arwoo', 130, { stop_index: 0 }), row(3, 'rubrob', 225, { stop_index: 1 })])
  const lifers = recap.lifersOf(ordered, [
    { userId: 1, name: 'Matt', before: new Set(['grhowl', 'arwoo', ...Array.from({ length: 200 }, (_, i) => `x${i}`)]) },
    { userId: 2, name: 'Kirin', before: new Set(['grhowl', ...Array.from({ length: 208 }, (_, i) => `x${i}`)]) },
    { userId: 3, name: 'New', before: null }
  ])
  assert.deepEqual(lifers.map((l) => [l.speciesCode, l.who, l.number]), [['arwoo', 'Kirin', 210], ['rubrob', 'Matt', 203], ['rubrob', 'Kirin', 211]])
  assert.equal(lifers[0].stopIndex, 0)
  assert.deepEqual(recap.lifersOf([], [{ userId: 1, name: 'Matt', before: new Set() }]), [])
})

test('the best hour: the clock hour in the event\'s zone that added the most, the earlier on a tie; null with no birds', () => {
  const ordered = recap.inOrder([row(1, 'a', 0), row(2, 'b', 125), row(3, 'c', 130), row(4, 'd', 170), row(5, 'e', 61), row(6, 'f', 65)])
  assert.deepEqual(recap.bestHour(ordered, 'America/Phoenix'), { start: '07:00', added: 3 })
  assert.deepEqual(recap.bestHour(recap.inOrder([row(1, 'a', 0), row(2, 'b', 61)]), 'America/Phoenix'), { start: '05:00', added: 1 })
  assert.equal(recap.bestHour([], 'America/Phoenix'), null)
})

test('stops: when the first bird there was seen, the time between the first and last, what each added; the best stop', () => {
  const stops = [{ name: 'Ramsey Canyon', lat: 31.44, lng: -110.3, stay_min: 90 }, { name: 'San Pedro House', lat: 31.55, lng: -110.14 }, { name: 'Portal', lat: 31.91, lng: -109.14 }]
  const ordered = recap.inOrder([row(1, 'a', 60, { stop_index: 0 }), row(2, 'b', 100, { stop_index: 0 }), row(3, 'c', 200, { stop_index: 1 }), row(4, 'd', 10)])
  const stats = recap.stopStats(stops, ordered)
  assert.deepEqual(stats[0], { index: 0, name: 'Ramsey Canyon', lat: 31.44, lng: -110.3, arrive: '2026-11-10T13:00:00.000Z', stayMin: 40, species: 2, added: 2 })
  assert.equal(stats[1].stayMin, null, 'one bird and no planned stay')
  assert.deepEqual([stats[2].arrive, stats[2].species], [null, 0])
  assert.deepEqual(recap.bestStop(stats), { index: 0, name: 'Ramsey Canyon', species: 2 })
  assert.equal(recap.bestStop(recap.stopStats(stops, [])), null)
  assert.deepEqual(recap.stopStats(null, ordered), [])
})

test('who found what: their adds and their own checklist ticks; birds only they have, and birds everyone has', () => {
  const ordered = recap.inOrder([row(1, 'a', 0), row(2, 'b', 1, { added_by: 2 }), row(3, 'c', 2), row(4, 'd', 3, { added_by: 2 })])
  const members = [{ userId: 1, name: 'Matt' }, { userId: 2, name: 'Kirin' }]
  const { byMember, together } = recap.whoFound(ordered, members, [{ user_id: 2, tally_id: 1 }, { user_id: 1, tally_id: 2 }])
  assert.deepEqual(byMember, [{ name: 'Matt', count: 3, only: ['c'] }, { name: 'Kirin', count: 3, only: ['d'] }])
  assert.equal(together, 2)
  assert.deepEqual(recap.whoFound([], members), { byMember: [{ name: 'Matt', count: 0, only: [] }, { name: 'Kirin', count: 0, only: [] }], together: 0 })
})

test('the scouting called it: the latest emailed bird of the day that made the tally; the rarest by its ABA code', () => {
  const ordered = recap.inOrder([row(1, 'lewwoo', 400, { stop_index: 3 }), row(2, 'rubrob', 225), row(3, 'grhowl', 0)])
  const called = recap.scoutingCalled([{ day: '2026-11-08', species_code: 'rubrob' }, { day: '2026-11-09', species_code: 'lewwoo' }, { day: '2026-11-10', species_code: 'eletro' }], ordered)
  assert.deepEqual(called, { speciesCode: 'lewwoo', emailedOn: '2026-11-09', at: '2026-11-10T18:40:00.000Z', stopIndex: 3 })
  assert.equal(recap.scoutingCalled([], ordered), null)
  assert.equal(recap.scoutingCalled([{ day: '2026-11-09', species_code: 'eletro' }], ordered), null)
  const aba = { rubrob: 3, lewwoo: 1, grhowl: 1 }
  assert.deepEqual(recap.rarest(ordered, (c) => aba[c]), { speciesCode: 'rubrob', aba: 3, at: '2026-11-10T15:45:00.000Z', stopIndex: null })
  assert.equal(recap.rarest(ordered, () => 2), null, 'nothing coded 3 or up')
})

test('the public view: no names, no personal spots, and nothing underscored leaves', () => {
  const at = '2026-11-10T13:00:00.000Z'
  const facts = {
    members: [{ id: 1, name: 'Matt', organizer: true }],
    totals: { species: 2, stops: 2, miles: 40, fieldMinutes: 60, firstBird: null, lastBird: null, bestStop: { index: 1, name: 'Aunt May\'s yard', species: 1, _private: true }, bestHour: null },
    timeline: [
      { n: 1, speciesCode: 'a', comName: 'A', at, stopIndex: 0, place: 'Ramsey Canyon', lifer: true, liferFor: ['Matt'] },
      { n: 2, speciesCode: 'b', comName: 'B', at, stopIndex: 1, place: 'Aunt May\'s yard', lifer: false, liferFor: [] }
    ],
    lifers: [{ speciesCode: 'b', comName: 'B', at, place: 'Aunt May\'s yard', who: 'Matt', number: 12, _stopIndex: 1, _userId: 1 }],
    highlights: { rarest: { speciesCode: 'b', comName: 'B', aba: 3, at, place: 'Aunt May\'s yard', _stopIndex: 1 }, scoutingCalled: null },
    targets: { total: 1, found: 1, missed: [] },
    stops: [{ index: 0, name: 'Ramsey Canyon', lat: 31.44, lng: -110.3, _private: false }, { index: 1, name: 'Aunt May\'s yard', lat: 31.5, lng: -110.2, _private: true }],
    route: { miles: 40, line: [[31.44, -110.3], [31.5, -110.2]], _publicLine: null },
    byMember: [{ name: 'Matt', count: 2, only: [] }],
    together: 2,
    candidates: []
  }
  const view = recap.strip(recap.redact(facts))
  assert.deepEqual(Object.keys(view).sort(), ['highlights', 'lifers', 'route', 'stops', 'targets', 'timeline', 'totals'])
  assert.deepEqual(view.stops.map((s) => s.name), ['Ramsey Canyon'])
  assert.deepEqual(view.route, { miles: 40, line: null })
  assert.deepEqual(view.timeline.map((t) => [t.place, t.stopIndex, t.liferFor]), [['Ramsey Canyon', 0, null], [null, null, null]])
  assert.deepEqual(view.lifers, [{ speciesCode: 'b', comName: 'B', at, place: null, who: null, number: 12 }])
  assert.equal(view.highlights.rarest.place, null)
  assert.deepEqual(view.totals.bestStop, { index: 1, name: null, species: 1 })
  assert.ok(!JSON.stringify(view).includes('Matt'), 'no names anywhere')
  assert.ok(!JSON.stringify(view).includes('Aunt May'), 'no personal place anywhere')
})

test('the recap email: their lifers, the highlights, how long fixes are open, one-click unsubscribe; in French with its spacing', () => {
  const { recapMessage } = require('../lib/mailer')
  const facts = {
    totals: { species: 92, stops: 6, miles: 186 },
    lifers: [
      { speciesCode: 'arwoo', comName: 'Arizona Woodpecker', at: '2026-11-10T14:12:00.000Z', place: 'Ramsey Canyon', _userId: 5 },
      { speciesCode: 'rubrob', comName: 'Rufous-backed Robin', at: '2026-11-10T15:47:00.000Z', place: 'San Pedro House', _userId: 9 },
      { speciesCode: 'wsowl', comName: 'Whiskered Screech-Owl', at: '2026-11-11T01:30:00.000Z', place: null, _userId: 5 }
    ],
    highlights: { rarest: { speciesCode: 'rubrob', comName: 'Rufous-backed Robin', aba: 3, place: 'San Pedro House' }, scoutingCalled: { speciesCode: 'lewwoo', comName: 'Lewis\'s Woodpecker' } },
    targets: { total: 20, found: 14, missed: [] }
  }
  const vars = { event: { id: 7, name: 'Big Day 2027', kind: 'bigday', starts_on: '2026-11-10' }, facts, name: 'Kirin', area: 'Cochise County', fixesUntil: new Date('2026-11-13T10:00:00Z'), zone: 'America/Phoenix' }
  const mail = recapMessage({ id: 5, email: 'kirin@example.com', locale: 'en', state: 'AZ', location: 'US-AZ-003' }, vars)
  assert.equal(mail.subject, 'Your recap is ready: Big Day 2027: 92 species in Cochise County')
  assert.equal(mail.bulk, true)
  assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  assert.match(mail.text, /Hi Kirin,/)
  assert.match(mail.text, /You picked up 2 lifers, starting with Arizona Woodpecker at Ramsey Canyon, 7:12 AM and ending with Whiskered Screech-Owl, 6:30 PM\./)
  assert.match(mail.text, /Rufous-backed Robin \(ABA Code 3\), San Pedro House/)
  assert.match(mail.text, /The scouting called it: Lewis's Woodpecker/)
  assert.match(mail.text, /14 of 20 targets found/)
  assert.match(mail.text, /Fixes are open until Friday, November 13\./)
  assert.match(mail.text, /November 10 · 6 stops · 186 mi · 3 lifers/)
  assert.match(mail.html, /See the recap/)
  assert.match(mail.html, /\/events\/7"/)

  // Someone with no lifers, no name in the group, in French: the tally instead, and French spacing.
  const fr = recapMessage({ id: 6, email: 'jo@example.com', locale: 'fr-CA', state: 'QC', location: 'CA-QC-MR' }, { ...vars, name: null })
  assert.match(fr.subject, /^Ton bilan est prêt : Big Day 2027 : 92 espèces dans Cochise County$/)
  assert.match(fr.text, /92 espèces au décompte\./)
  assert.match(fr.text, /au décompte \? Les corrections sont ouvertes jusqu’au vendredi 13 novembre\./)
})
