const { test } = require('node:test')
const assert = require('node:assert/strict')
const { layout, sightingsBody, byChecklist } = require('../lib/mailer')

const sighting = { speciesCode: 'snogoo', comName: 'Snow <Goose>', locName: 'Lake Lanier', obsDt: '2026-10-20 13:49', howMany: 3, lat: 34.2695, lng: -83.9014, subId: 'S123' }

test('a digest has one map with a pin per checklist, and a card per checklist listing its birds', () => {
  const sameChecklist = { ...sighting, speciesCode: 'cangoo', comName: 'Canada Goose', howMany: 1 }
  const elsewhere = { ...sighting, speciesCode: 'tunswa', comName: 'Tundra Swan', locName: 'Clarks Bridge', lat: 34.3001, lng: -83.8002, subId: 'S2', obsDt: '2026-10-20 15:10' }
  const html = sightingsBody([sighting, sameChecklist, elsewhere], new Map([['snogoo', { birdImg: 'https://img/snogoo.jpg' }]]))
  const maps = html.match(/\/api\/map\?pins=[^"]+/g) || []
  assert.equal(maps.length, 1, 'one map for the digest')
  assert.equal(decodeURIComponent(maps[0]), '/api/map?pins=34.2695,-83.9014,1;34.3001,-83.8002,2')
  assert.equal((html.match(/View checklist on eBird/g) || []).length, 2, 'one checklist button per checklist')
  assert.match(html, /ebird\.org\/checklist\/S123/)
  assert.match(html, /ebird\.org\/checklist\/S2/)
  assert.match(html, /https:\/\/img\/snogoo\.jpg/)
  assert.match(html, /Snow &lt;Goose&gt;/, 'bird names are escaped')
  assert.match(html, /3 seen/)
  assert.match(html, /Canada Goose/)
  assert.ok(html.indexOf('Lake Lanier') < html.indexOf('Clarks Bridge'), 'checklists keep their order')
  assert.doesNotMatch(html, /lat=34\.2695&lng=/, 'no per-bird maps')
})

test('html in names and places is escaped', () => {
  const html = sightingsBody([{ ...sighting, comName: 'Snow <b>Goose</b>', locName: 'Lake & Dam' }])
  assert.match(html, /Snow &lt;b&gt;Goose&lt;\/b&gt;/)
  assert.match(html, /Lake &amp; Dam/)
})

test('pins stop at twelve checklists and the list is capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...sighting, speciesCode: `b${i}`, comName: `Bird ${i}`, subId: `S${i}`, lat: 34 + i / 100, lng: -83 - i / 100 }))
  const html = sightingsBody(many)
  const pins = decodeURIComponent((html.match(/\/api\/map\?pins=[^"]+/) || [''])[0]).split(';')
  assert.equal(pins.length, 12)
  assert.equal((html.match(/View checklist on eBird/g) || []).length, 25)
  assert.match(html, /and 5 more/)
})

test('the plain-text digest is grouped by checklist too', () => {
  const groups = byChecklist([sighting, { ...sighting, speciesCode: 'cangoo', comName: 'Canada Goose' }, { ...sighting, subId: 'S2', locName: 'Dam', lat: 34.31, lng: -83.81 }])
  assert.deepEqual(groups.map((g) => [g.pin, g.subId, g.sightings.length]), [['1', 'S123', 2], ['2', 'S2', 1]])
})

test('the shell has the header, the body and footer links', () => {
  const html = layout({ heading: 'Hello', intro: 'Intro', body: '<p>Body</p>', footerLinks: [{ href: 'https://x/u', label: 'Unsubscribe' }] })
  assert.match(html, /Bird <span[^>]*>Alert!<\/span>/)
  assert.match(html, /<h1[^>]*>Hello<\/h1>/)
  assert.match(html, /href="https:\/\/x\/u"/)
})

test('the migration email has a section per movement, links out and an unsubscribe link', () => {
  const { migrationMessage } = require('../lib/mailer')
  const user = { id: 1, email: 'a@b.c', location: 'US-GA-139' }
  const report = {
    arrived: [{ speciesCode: 'whtspa', comName: 'White-throated Sparrow', birdImg: 'https://img/w.jpg', daysThisWeek: 3, firstSeen: '2026-10-15' }],
    departed: [{ speciesCode: 'rthhum', comName: 'Ruby-throated Hummingbird', daysBefore: 12, lastSeen: '2026-10-02' }],
    coming: [{ speciesCode: 'winwre', comName: 'Winter Wren', daysLastYear: 9, windowDays: 15, firstLastYear: '2025-10-25' }]
  }
  const message = migrationMessage(user, report, 'Hall')
  assert.equal(message.subject, 'Migration this week in Hall: 1 arrival, 1 moved on, 1 to watch for')
  assert.match(message.html, /White-throated Sparrow/)
  assert.match(message.html, /Back since October 15, reported on 3 days this week/)
  assert.match(message.html, /Last reported October 2, after 12 days in the month before/)
  assert.match(message.html, /reported on 9 of 15 days, from October 25/)
  assert.match(message.html, /dashboard\.birdcast\.info\/region\/US-GA-139/)
  assert.match(message.html, /\/map\?code=whtspa/)
  assert.match(message.html, /\/unsubscribe\//)
  assert.match(message.text, /- Winter Wren \(9 of 15 days this time last year\)/)
  assert.equal(migrationMessage(user, { arrived: [], departed: [], coming: [] }, null).subject, 'Migration this week in your area: a quiet week')
})

test('a sighting card carries its ABA code chip for codes 3-5 only', () => {
  const base = { speciesCode: 'roahaw', comName: 'Roadside Hawk', subId: 'S1', locName: 'Estero Llano Grande', obsDt: '2026-10-28 08:00', lat: 26.1, lng: -97.9 }
  assert.match(sightingsBody([{ ...base, aba: 4 }]), /Roadside Hawk <span[^>]*>ABA Code 4<\/span>/)
  assert.ok(!sightingsBody([{ ...base, aba: 1 }]).includes('ABA Code'))
  assert.ok(!sightingsBody([base]).includes('ABA Code'))
})
