/**
 * Renders sample scouting emails from made-up fixtures (Cochise County, Arizona), for a look before
 * shipping: nothing is read from a database and nothing is sent.
 *
 *   node -r ./test/setup.js scripts/preview-scout-email.js <out-dir>
 *
 * Writes scout-email-a.html (the daily report: a saved route, a bird new today) and
 * scout-email-b.html (asked for now, with none of the targets reported: what else is about),
 * and their plain text beside them. The test setup's dummy secret signs the unsubscribe link,
 * so that link goes nowhere: it is a preview.
 */
const fs = require('fs')
const path = require('path')
const { scoutingMessage } = require('../lib/scoutMail')
const { formatObsDt } = require('../lib/i18n')

const out = process.argv[2]
if (!out) { console.error('Usage: node -r ./test/setup.js scripts/preview-scout-email.js <out-dir>'); process.exit(1) }

const now = new Date()
const timezone = 'America/Phoenix'
const wall = (hoursAgo) => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  .format(new Date(now.getTime() - hoursAgo * 3_600_000))
const user = { id: 1, email: 'pat@example.com', locale: 'en', timezone }

const spots = {
  ramsey: { where: 'Ramsey Canyon Preserve', locId: 'L128951', lat: 31.4466, lng: -110.3061 },
  beattys: { where: 'Miller Canyon--Beatty\'s Guest Ranch', locId: 'L210477', lat: 31.4170, lng: -110.2730 },
  sanpedro: { where: 'San Pedro House', locId: 'L128955', lat: 31.5490, lng: -110.1340 },
  whitewater: { where: 'Whitewater Draw Wildlife Area', locId: 'L127394', lat: 31.5590, lng: -109.7160 },
  southfork: { where: 'Cave Creek Canyon--South Fork', locId: 'L127411', lat: 31.8540, lng: -109.1770 },
  rustler: { where: 'Rustler Park', locId: 'L127420', lat: 31.9040, lng: -109.2770 },
  portal: { where: 'Portal', locId: 'L127418', lat: 31.9130, lng: -109.1410 },
  carr: { where: 'Carr Canyon', locId: 'L127400', lat: 31.4340, lng: -110.2860 }
}
let sub = 140_000_000
const row = (code, bird, spot, hoursAgo, extra = {}) => {
  const obsDt = wall(hoursAgo)
  return { code, bird, ...spots[spot], obsDt, date: formatObsDt(obsDt, 'en'), subId: `S${sub++}`, flagged: false, evidence: '', aba: null, birdImg: null, ...extra }
}

// (a) Daily, 6 days out: a Rufous-backed Robin new this morning, ten of twelve targets about, the group's route saved.
const daily = scoutingMessage(user, {
  eventId: 42,
  place: 'Big Day 2027',
  daysToGo: 6,
  group: true,
  targetCount: 12,
  recentDays: 3,
  now,
  seen: [
    row('rubrob', 'Rufous-backed Robin', 'beattys', 3, { flagged: true, aba: 3, evidence: 'Confirmed by eBird reviewer · photo · 4 birders', birdImg: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/6c/Turdus_rufopalliatus.jpg/330px-Turdus_rufopalliatus.jpg?utm_source=en.wikipedia.org&utm_campaign=api&utm_content=thumbnail' }),
    row('arizwo', 'Arizona Woodpecker', 'ramsey', 20),
    row('paired', 'Painted Redstart', 'ramsey', 26),
    row('heptan', 'Hepatic Tanager', 'ramsey', 30),
    row('mexchi', 'Mexican Chickadee', 'rustler', 28),
    row('elet', 'Elegant Trogon', 'southfork', 44, { flagged: true, evidence: 'Unconfirmed: not yet reviewed · 2 birders' }),
    row('sancra', 'Sandhill Crane', 'whitewater', 22),
    row('lewwoo', 'Lewis\'s Woodpecker', 'sanpedro', 50),
    row('gresca', 'Greater Pewee', 'carr', 60),
    row('bkcspa', 'Black-chinned Sparrow', 'portal', 66)
  ],
  unreported: ['Montezuma Quail', 'Flammulated Owl'],
  route: {
    start: { name: 'Sierra Vista Motel', lat: 31.55, lng: -110.3 },
    stops: [{ name: 'Ramsey Canyon Preserve' }, { name: 'Miller Canyon--Beatty\'s Guest Ranch' }, { name: 'San Pedro House' }, { name: 'Whitewater Draw Wildlife Area' }]
  }
})

// (b) Asked for now, 6 days out: none of the targets reported this week, so what else is about; no route saved.
const asked = scoutingMessage(user, {
  eventId: 42,
  place: 'Big Day 2027',
  daysToGo: 6,
  targetCount: 3,
  recentDays: 7,
  now,
  seen: [],
  unreported: ['Montezuma Quail', 'Flammulated Owl'],
  thisWeek: [
    row('rubrob', 'Rufous-backed Robin', 'beattys', 3, { notable: true }),
    row('ruddov', 'Ruddy Ground Dove', 'sanpedro', 30, { notable: true }),
    row('sancra', 'Sandhill Crane', 'whitewater', 22),
    row('arizwo', 'Arizona Woodpecker', 'ramsey', 20),
    row('paired', 'Painted Redstart', 'ramsey', 26),
    row('acowoo', 'Acorn Woodpecker', 'ramsey', 28),
    row('bridti', 'Bridled Titmouse', 'carr', 40),
    row('rufwsp', 'Rufous-winged Sparrow', 'sanpedro', 52),
    row('vermfl', 'Vermilion Flycatcher', 'whitewater', 70),
    row('chclon', 'Chestnut-collared Longspur', 'whitewater', 90)
  ],
  route: null,
  requested: { asOf: new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(now) }
})

fs.mkdirSync(out, { recursive: true })
for (const [name, mail] of [['a', daily], ['b', asked]]) {
  fs.writeFileSync(path.join(out, `scout-email-${name}.html`), mail.html)
  fs.writeFileSync(path.join(out, `scout-email-${name}.txt`), `Subject: ${mail.subject}\n\n${mail.text}\n`)
  console.log(`${name}: ${mail.subject}`)
}
