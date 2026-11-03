const { test } = require('node:test')
const assert = require('node:assert/strict')
const { maskEmail, clockTime } = require('../lib/scoutEmail')
const { thisWeekPicks } = require('../lib/scouting')
const { scoutingMessage } = require('../lib/mailer')
const { birdOfTheDay, placesOf, freshOf, freshness } = require('../lib/scoutMail')

const user = { id: 1, email: 'pat@example.com', locale: 'en' }

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

// The email's fixtures: now is 2026-11-03 09:00 in Phoenix (16:00 UTC).
const now = new Date('2026-11-03T16:00:00Z')
const pat = { id: 1, email: 'pat@example.com', locale: 'en', timezone: 'America/Phoenix' }
const at = (where, locId, lat, lng) => ({ where, locId, lat, lng })
const ramsey = at('Ramsey Canyon Preserve', 'L1', 31.4466, -110.3061)
const beattys = at('Miller Canyon--Beatty\'s Guest Ranch', 'L2', 31.417, -110.273)
const whitewater = at('Whitewater Draw Wildlife Area', 'L3', 31.559, -109.716)
const row = (code, bird, place, obsDt, extra = {}) => ({ code, bird, ...place, obsDt, date: obsDt, subId: `S-${code}`, flagged: false, evidence: '', aba: null, birdImg: null, ...extra })
const seen = [
  row('arizwo', 'Arizona Woodpecker', ramsey, '2026-11-02 08:00'),
  row('paired', 'Painted Redstart', ramsey, '2026-11-01 08:00'),
  row('rubrob', 'Rufous-backed Robin', beattys, '2026-11-03 07:30', { flagged: true, aba: 3, evidence: 'Confirmed by eBird reviewer · photo · 4 birders', birdImg: 'https://example.org/robin.jpg?a=1&b=2' }),
  row('sancra', 'Sandhill Crane', whitewater, '2026-11-02 10:30')
]
const daily = { eventId: 7, place: 'Big Day 2027', daysToGo: 6, seen, unreported: ['Montezuma Quail', 'Flammulated Owl'], targetCount: 8, recentDays: 3, now }
const sections = (text) => text.split('\n\n').map((p) => p.split('\n')[0])

test('the bird of the day: the rarest reported by ABA code, then flagged by eBird, then the newest', () => {
  assert.equal(birdOfTheDay(seen).code, 'rubrob')
  const plain = [row('a', 'A', ramsey, '2026-11-01 08:00'), row('b', 'B', ramsey, '2026-11-02 08:00')]
  assert.equal(birdOfTheDay(plain).code, 'b', 'equals: the newest')
  assert.equal(birdOfTheDay([...plain, row('c', 'C', ramsey, '2026-10-30 08:00', { flagged: true })]).code, 'c', 'flagged over newer')
  assert.equal(birdOfTheDay([row('c', 'C', ramsey, '2026-11-02 08:00', { flagged: true }), row('d', 'D', ramsey, '2026-10-29 08:00', { aba: 4 })]).code, 'd', 'a code over a flag')
  assert.equal(birdOfTheDay([row('e', 'E', ramsey, '2026-11-02 08:00', { aba: 1 }), row('f', 'F', ramsey, '2026-11-02 09:00', { aba: 2 })]).code, 'f', 'codes 1-2 count for nothing')
  assert.equal(birdOfTheDay([]), null)
})

test('places: most targets first, then the newest; the newest checklist there is the one linked', () => {
  const places = placesOf(seen)
  assert.deepEqual(places.map((p) => [p.where, p.birds.length]), [['Ramsey Canyon Preserve', 2], ['Miller Canyon--Beatty\'s Guest Ranch', 1], ['Whitewater Draw Wildlife Area', 1]])
  assert.equal(places[0].subId, 'S-arizwo')
  const rare = placesOf([row('x', 'X', ramsey, '2026-11-02 08:00'), row('y', 'Y', ramsey, '2026-11-02 08:00'), row('z', 'Z', whitewater, '2026-11-01 08:00', { notable: true })], { rareFirst: true })
  assert.equal(rare[0].where, 'Whitewater Draw Wildlife Area', 'what else is about: a place with a rare bird first')
})

test('fresh is the last 24 hours on the person\'s clock; freshness reads as today, yesterday, days ago', () => {
  assert.deepEqual(freshOf(seen, '2026-11-03 09:00').map((s) => s.code), ['rubrob', 'sancra'])
  assert.deepEqual(freshOf([row('d', 'D', ramsey, '2026-11-02')], '2026-11-03 09:00').map((s) => s.code), ['d'], 'no time of day: noon')
  assert.deepEqual([freshness('2026-11-03 07:00', '2026-11-03', 'en'), freshness('2026-11-02', '2026-11-03', 'en'), freshness('2026-10-31 07:00', '2026-11-03', 'en')], ['today', 'yesterday', '3 days ago'])
})

test('the daily email: the countdown and bar, what\'s new, the bird of the day, the map and places, what\'s missing, the route; designed, with its unsubscribe', () => {
  const mail = scoutingMessage(pat, { ...daily, group: true, route: { start: { name: 'Sierra Vista Motel' }, stops: [{ name: 'Ramsey Canyon Preserve' }, { name: 'San Pedro House' }] } })
  assert.equal(mail.subject, 'Big Day 2027: Rufous-backed Robin and 1 more new today · 6 days to go')
  assert.equal(mail.to, 'pat@example.com')
  assert.deepEqual(sections(mail.text), ['Big Day 2027 · 6 days to go', 'New: Rufous-backed Robin, Sandhill Crane', 'Bird of the day: Rufous-backed Robin (ABA Code 3)', 'Where they’re being seen:',
    'Still missing (nothing in the last 2 weeks): Montezuma Quail, Flammulated Owl', 'Your group’s route:', 'Open the event: https://bird-alert.vercel.app/events/7', sections(mail.text)[7], sections(mail.text)[8]])
  assert.match(mail.text, /^Big Day 2027 · 6 days to go\nWith your group\n4 of 8 targets reported in the last 3 days\n/)
  assert.match(mail.text, /1\. Ramsey Canyon Preserve \(yesterday\)\n   Arizona Woodpecker, Painted Redstart\n   Checklist on eBird: https:\/\/ebird.org\/checklist\/S-arizwo\n2\. Miller Canyon--Beatty's Guest Ranch \(today\)\n   Rufous-backed Robin \(rare there\)/)
  assert.match(mail.text, /Your group’s route:\nMeeting point: Sierra Vista Motel\n1\. Ramsey Canyon Preserve\n2\. San Pedro House/)
  assert.match(mail.text, /Turn off trip emails: \S+\/unsubscribe\//)
  assert.match(mail.text, /Sightings and checklists from eBird/)
  assert.doesNotMatch(mail.text, /&#39;|&amp;|&middot;|<[a-z]/, 'plain text has no escapes or tags')
  // The HTML: the layout, the bar, the hero's photo (escaped), one map with a pin per place, chips, the buttons and the footer.
  const html = mail.html
  assert.match(html, /<h1[^>]*>Big Day 2027 · 6 days to go<\/h1>/)
  assert.match(html, /<strong>4 of 8 targets<\/strong> reported in the last 3 days/)
  assert.match(html, /<td width="50%" style="height:12px;background:#ff6a00;/)
  assert.match(html, /<img src="https:\/\/example.org\/robin.jpg\?a=1&amp;b=2"/)
  assert.match(html, /ABA Code 3<\/span>/)
  assert.match(html, /\/api\/map\?pins=31\.4466%2C-110\.3061%2C1%3B31\.4170%2C-110\.2730%2C2%3B31\.5590%2C-109\.7160%2C3/)
  assert.match(html, /Miller Canyon--Beatty&#39;s Guest Ranch/)
  assert.equal((html.match(/Checklist on eBird/g) || []).length, 3, 'one checklist link a place')
  assert.match(html, />Open the event<\/a>/)
  assert.match(html, />Plan the route<\/a>/)
  assert.match(html, /Turn off trip emails/)
  assert.match(html, /Cornell Lab of Ornithology/)
  assert.doesNotMatch(html, /width="(5[3-9]\d|[6-9]\d\d)"|(?<!max-)width:\s*(5[3-9]\d|[6-9]\d\d)px/, 'nothing wider than 520')
})

test('each part shows only when it has something to say', () => {
  const quiet = scoutingMessage(pat, { ...daily, seen: [row('arizwo', 'Arizona Woodpecker', ramsey, '2026-11-01 08:00')], unreported: [] })
  assert.equal(quiet.subject, 'Big Day 2027: 1 of 8 targets around · 6 days to go')
  assert.ok(!quiet.text.includes('New:'), 'nothing in the last 24 hours')
  assert.ok(!quiet.text.includes('Still missing'), 'nothing missing')
  assert.match(quiet.text, /Your route:\nNo route saved yet\. Plan your route: \S+\/events\/7#route/)
  assert.ok(!quiet.html.includes('Plan the route'), 'no saved route: one button for it, up in its section')
  assert.ok(!quiet.html.includes('<img src="https://example'), 'no photo, no image')
  assert.ok(!quiet.text.includes('With your group'))
  const many = Array.from({ length: 8 }, (_, i) => row(`b${i}`, `Bird ${i}`, at(`Spot ${i}`, `L${10 + i}`, 31 + i / 100, -110), `2026-11-0${1 + (i % 2)} 08:00`))
  const more = scoutingMessage(pat, { ...daily, seen: many })
  assert.equal((more.html.match(/Checklist on eBird/g) || []).length, 5, 'the top 5 places')
  assert.match(more.text, /\+3 more places on the event page: \S+\/events\/7/)
  assert.equal(decodeURIComponent(more.html.match(/pins=([^"]+)"/)[1]).split(';').length, 5, 'a pin for each place shown')
  const none = scoutingMessage(pat, { ...daily, seen: [], thisWeek: [] })
  assert.equal(none.subject, 'Big Day 2027: no targets reported yet · 6 days to go')
  assert.match(none.text, /0 of 8 targets reported in the last 3 days/)
  assert.match(none.text, /None of your target birds were reported there in the last 3 days\./)
  assert.match(none.text, /What’s being seen there this week:\nNothing has been reported there in the last 7 days\./)
  assert.ok(!none.text.includes('Bird of the day') && !none.html.includes('/api/map'))
})

test('likely lifers standing in say so; with no targets at all, what else is about and an invitation to pick some', () => {
  const standIn = scoutingMessage(pat, { ...daily, standIn: true, unreported: [] })
  assert.match(standIn.subject, /Rufous-backed Robin and 1 more new today/)
  assert.match(standIn.text, /4 of 8 likely lifers reported in the last 3 days/)
  assert.match(standIn.text, /You haven’t picked target birds yet, so these are likely lifers for your dates\.\nPick target birds: \S+\/events\/7/)
  assert.equal(scoutingMessage(pat, { ...daily, standIn: true, seen: [] }).subject, 'Big Day 2027: no likely lifers reported yet · 6 days to go')
  const thisWeek = [row('ruddov', 'Ruddy Ground Dove', whitewater, '2026-11-02 08:00', { notable: true }), row('acowoo', 'Acorn Woodpecker', ramsey, '2026-11-02 09:00'), row('bridti', 'Bridled Titmouse', ramsey, '2026-11-01 09:00')]
  const fallback = scoutingMessage(pat, { ...daily, seen: [], unreported: [], targetCount: 0, noTargets: true, thisWeek, requested: { asOf: '9:00 AM' } })
  assert.equal(fallback.subject, 'Scouting report for Big Day 2027 (as of 9:00 AM)')
  assert.ok(!/targets reported|None of your target birds/.test(fallback.text), 'no targets: no bar, nothing to say of them')
  assert.match(fallback.text, /What’s being seen there this week:\n1\. Whitewater Draw Wildlife Area \(yesterday\)\n   Ruddy Ground Dove \(rare there\)\n   Checklist on eBird: \S+\n2\. Ramsey Canyon Preserve \(yesterday\)\n   Acorn Woodpecker, Bridled Titmouse/)
  assert.match(fallback.text, /Pick the birds you’re after and this report will follow them\. \S+\/events\/7/)
  assert.match(fallback.html, /background:#ffd700;font-size:13px;">Ruddy Ground Dove<\/span>/, 'a rare bird\'s chip stands out')
  assert.match(fallback.html, />Pick target birds<\/a>/)
  assert.match(fallback.html, /\/api\/map\?pins=/, 'the map shows what else is about')
})

test('asked for now: its own subject, the last 7 days, the day itself, and no unsubscribe; the daily keeps its', () => {
  const requested = { asOf: '9:14 AM' }
  const asked = scoutingMessage(pat, { ...daily, recentDays: 7, requested })
  assert.equal(asked.subject, 'Scouting report for Big Day 2027 (as of 9:14 AM)')
  assert.match(asked.text, /4 of 8 targets reported this week/)
  assert.ok(!asked.text.includes('/unsubscribe/') && !asked.html.includes('/unsubscribe/') && !asked.html.includes('Turn off trip emails'))
  assert.match(asked.html, /Cornell Lab of Ornithology/, 'the eBird credit stays')
  const daily1 = scoutingMessage(pat, daily)
  assert.ok(daily1.text.includes('/unsubscribe/') && daily1.html.includes('/unsubscribe/'))
  assert.match(scoutingMessage(pat, { ...daily, daysToGo: 1, requested }).text, /^Big Day 2027 · tomorrow\n/)
  assert.match(scoutingMessage(pat, { ...daily, daysToGo: 0, requested }).text, /^Big Day 2027 · today\n/)
  assert.match(scoutingMessage(pat, { ...daily, daysToGo: -1, requested }).text, /^Big Day 2027 · under way\n/)
  assert.match(scoutingMessage(pat, { ...daily, seen: [seen[0]], daysToGo: 1 }).subject, /^Big Day 2027: 1 of 8 targets around · tomorrow$/)
})

test('everything from the data is escaped in the HTML and read as typed in the text', () => {
  const nasty = { ...daily, place: 'Tom & Jerry\'s <Big> Day', seen: [row('x', 'Bird <b>', at('O\'Neil "Pond" & Co', 'L9', 31, -110), '2026-11-03 08:00')], unreported: ['<script>'], route: { start: { name: 'Mo & Jo\'s' }, stops: [{ name: '<i>Stop</i>' }] } }
  const mail = scoutingMessage(pat, nasty)
  assert.doesNotMatch(mail.html, /<b>|<script>|<i>Stop|<Big>/)
  assert.match(mail.html, /Tom &amp; Jerry&#39;s &lt;Big&gt; Day/)
  assert.match(mail.text, /Tom & Jerry's <Big> Day · 6 days to go/)
  assert.match(mail.text, /O'Neil "Pond" & Co/)
  assert.match(mail.text, /Meeting point: Mo & Jo's/)
})
