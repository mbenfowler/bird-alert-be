const { test } = require('node:test')
const assert = require('node:assert/strict')
const { thisWeekPicks, maskEmail, clockTime } = require('../lib/scoutEmail')
const { scoutingMessage } = require('../lib/mailer')

const user = { id: 1, email: 'pat@example.com', locale: 'en' }
const base = { eventId: 7, place: 'Big Day 2027', daysToGo: 5, final: false, seen: [], unreported: [], group: false, standIn: false }

test('the address is masked to its first letter and its domain', () => {
  assert.equal(maskEmail('pat@example.com'), 'p•••@example.com')
  assert.equal(maskEmail('x@y.org'), 'x•••@y.org')
  assert.equal(maskEmail('nope'), '•••')
})

test('the time in the subject is the person\'s own, UTC when their zone is unknown', () => {
  const now = new Date('2026-11-03T16:14:00Z')
  assert.equal(clockTime(now, 'America/New_York', 'en'), '11:14 AM')
  assert.equal(clockTime(now, 'Not/AZone', 'en'), '4:14 PM')
  assert.equal(clockTime(now, null, 'en'), '4:14 PM')
})

test('what else is about: the last week only, rarest first, then the most reported, then the newest; up to 10, one species each', () => {
  const o = (speciesCode, obsDt, extra = {}) => ({ speciesCode, comName: speciesCode, locName: `at ${speciesCode}`, obsDt, ...extra })
  const records = [
    o('common', '2026-11-02 08:00'), o('common', '2026-11-01 08:00', { locName: 'elsewhere' }), o('common', '2026-10-31 08:00'),
    o('newest', '2026-11-03 07:00'),
    o('flagged', '2026-10-30 07:00', { obsReviewed: true }),
    o('code4', '2026-10-29 07:00', { aba: 4 }),
    o('old', '2026-10-20 07:00'),
    o('escapee', '2026-11-02 07:00', { exoticCategory: 'X' }),
    o('duck', '2026-11-02 07:00', { comName: 'duck sp.' }),
    o('hybrid', '2026-11-02 07:00', { comName: 'Mallard x American Black Duck' }),
    o('target', '2026-11-02 07:00')
  ]
  const picks = thisWeekPicks(records, '2026-10-28', { skip: new Set(['target']) })
  assert.deepEqual(picks.map((p) => p.latest.speciesCode), ['code4', 'flagged', 'common', 'newest'])
  assert.deepEqual(picks.map((p) => p.rare), [true, true, false, false])
  assert.equal(picks[2].latest.obsDt, '2026-11-02 08:00', 'its newest report')
  assert.equal(picks[2].reports, 3)
  const many = Array.from({ length: 15 }, (_, i) => o(`s${i}`, '2026-11-01 07:00'))
  assert.equal(thisWeekPicks(many, '2026-10-28').length, 10)
  assert.deepEqual(thisWeekPicks(null, '2026-10-28'), [])
})

test('the morning report reads as it always has', () => {
  const daily = scoutingMessage(user, { ...base, seen: [{ bird: 'Elegant Trogon', where: 'Cave Creek', date: 'Nov 2, 7:10 AM', evidence: '' }], unreported: ['Flammulated Owl'] })
  assert.equal(daily.subject, 'Scouting Big Day 2027: 5 days to go')
  assert.match(daily.text, /Your target birds reported there in the last 3 days:/)
  assert.match(daily.text, /\/unsubscribe\//)
  assert.ok(!/Plan your route|What’s being seen|as of/.test(daily.text + daily.subject))
  assert.equal(scoutingMessage(user, { ...base, daysToGo: 1, final: true }).subject, 'Final scouting report: Big Day 2027 tomorrow')
})

test('asked for now: its own subject, the last 7 days, the day itself worded as such, no unsubscribe', () => {
  const requested = { asOf: '9:14 AM', thisWeek: null, route: null, noTargets: false }
  const msg = scoutingMessage(user, { ...base, requested, seen: [{ bird: 'Elegant Trogon', where: 'Cave Creek', date: 'Nov 2', evidence: '' }] })
  assert.equal(msg.subject, 'Scouting report for Big Day 2027 (as of 9:14 AM)')
  assert.match(msg.text, /Here’s your scouting report for Big Day 2027, 5 days to go\./)
  assert.match(msg.text, /Your target birds reported there in the last 7 days:\n• Elegant Trogon · Cave Creek · Nov 2/)
  assert.match(msg.text, /Plan your route: \S+\/events\/7\b/)
  assert.ok(!msg.text.includes('/unsubscribe/'))
  assert.equal(msg.to, 'pat@example.com')
  assert.match(scoutingMessage(user, { ...base, daysToGo: 1, final: true, requested }).text, /Your final scouting report for Big Day 2027: the trip is tomorrow\./)
  assert.match(scoutingMessage(user, { ...base, daysToGo: 0, final: true, requested }).text, /Your scouting report for Big Day 2027: the trip is today\./)
  assert.match(scoutingMessage(user, { ...base, daysToGo: -1, final: true, requested }).text, /Your scouting report for Big Day 2027, while the trip is on\./)
  assert.match(scoutingMessage(user, { ...base, requested }).text, /None of your target birds were reported there in the last 7 days\./)
})

test('asked for with nothing to report: what else is about, an invitation to pick targets, and the saved route', () => {
  const msg = scoutingMessage(user, {
    ...base,
    group: true,
    requested: {
      asOf: '9:14 AM',
      noTargets: true,
      thisWeek: [{ bird: 'Rufous-backed Robin', where: 'Tubac', date: 'Nov 1', notable: true }, { bird: 'Acorn Woodpecker', where: 'Portal', date: 'Nov 2', notable: false }],
      route: { start: { name: 'Our motel' }, stops: [{ name: 'Ramsey Canyon' }, { name: 'Carr Canyon' }] }
    }
  })
  assert.ok(!msg.text.includes('None of your target birds'))
  assert.match(msg.text, /What’s being seen there this week:\n• Rufous-backed Robin · Tubac · Nov 1 · rare there\n• Acorn Woodpecker · Portal · Nov 2\n/)
  assert.match(msg.text, /Pick the birds you’re after and this report will follow them: \S+\/events\/7\b/)
  assert.match(msg.text, /Your group’s route:\nMeeting point: Our motel\n1\. Ramsey Canyon\n2\. Carr Canyon/)
  assert.ok(!msg.text.includes('Plan your route'))
  const empty = scoutingMessage(user, { ...base, requested: { asOf: '9:14 AM', noTargets: true, thisWeek: [], route: { start: null, stops: [{ name: 'Only stop' }] } } })
  assert.match(empty.text, /Nothing has been reported there in the last 7 days\./)
  assert.match(empty.text, /Your route:\n1\. Only stop/)
  assert.ok(!empty.text.includes('Meeting point'))
})
