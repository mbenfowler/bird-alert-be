const test = require('node:test')
const assert = require('node:assert/strict')
const { xDraft, facebookDraft, xLength, dateList, isRestricted, placeName, RARITY } = require('../lib/megaPost')

const URL_ = 'https://bird-alert.vercel.app/share/s/abcdefghij'
const owl = {
  speciesCode: 'motowl', comName: 'Mottled Owl', state: 'US-TX', stateName: 'Texas', aba: 5, confirmed: 5, observers: 4,
  place: { locName: 'Santa Margarita Ranch (LTC 079) (restricted access)', county: 'Starr', days: ['2026-10-24', '2026-10-31'], media: false, obsDt: '2026-10-31 18:25' }
}

test('a Code 5 X post: the code, the rarity, the dates, the access note, the evidence, under 280', () => {
  const text = xDraft(owl, URL_)
  assert.match(text, /^🚨 ABA CODE 5 · MOTTLED OWL in Texas!/)
  assert.match(text, /Only a handful of ABA records ever\. Seen Oct 24 and Oct 31 at Santa Margarita Ranch \(LTC 079\), Starr Co\. \(private, by arrangement only 🙏\)/)
  assert.match(text, /✅ Confirmed by eBird reviewers · 4 observers/)
  assert.ok(text.includes(URL_))
  assert.match(text, /#birding #rarebird #Texasbirds$/, '#Megararity made way for the rarity line')
  assert.ok(xLength(text, URL_) <= 280)
})

test('a long X post drops the rarity line, then the hashtags, and never goes over', () => {
  const long = { ...owl, comName: 'Northern Rough-winged Swallow', stateName: 'Newfoundland and Labrador', state: 'CA-NL', place: { ...owl.place, locName: `${'A very long place name for a sea watch at the end of a long road '.repeat(2)}(restricted access)`, county: 'Division No. 1, Subdivision Y', media: true } }
  const text = xDraft(long, URL_)
  assert.ok(xLength(text, URL_) <= 280, `${xLength(text, URL_)}: ${text}`)
  assert.ok(!text.includes(RARITY[5]))
  assert.ok(text.includes(URL_), 'the link is never cut')
  assert.match(text, /by arrangement only/, 'nor the access note')
})

test('the Facebook post tells it in sentences and asks people not to go without permission', () => {
  const text = facebookDraft(owl, URL_)
  assert.equal(text.split('\n')[0], '🚨 An ABA Code 5 rarity in Texas: MOTTLED OWL')
  assert.match(text, /The Mottled Owl has only a handful of records ever in the ABA Area, and one has been reported at Santa Margarita Ranch \(LTC 079\) in Starr County on Oct 24 and Oct 31, by 4 observers, and confirmed by eBird's reviewers\./)
  assert.match(text, /Please don't go without permission\./)
  assert.ok(text.endsWith(`Details and map: ${URL_}`))
})

test('a public place gets no access note; a Code 4 says it is not seen every year; unreviewed says so', () => {
  const warbler = { ...owl, comName: 'Yellow-browed Warbler', aba: 4, confirmed: 0, observers: 1, stateName: 'California', state: 'US-CA', place: { locName: 'Rancho Corral de Tierra--Moss Beach area', county: 'San Mateo', days: ['2026-10-22'], media: true } }
  const x = xDraft(warbler, URL_)
  const fb = facebookDraft(warbler, URL_)
  assert.doesNotMatch(x + fb, /restricted|permission/)
  assert.match(x, /Not even seen every year in the ABA Area\. Seen Oct 22 at Rancho Corral de Tierra – Moss Beach area, San Mateo Co\./)
  assert.match(x, /⏳ Not yet reviewed by eBird · 📷 photo/)
  assert.match(fb, /The Yellow-browed Warbler isn't seen every year in the ABA Area, and one has been reported at Rancho Corral de Tierra – Moss Beach area in San Mateo County on Oct 22, not yet reviewed by eBird\./)
})

test('helpers: dates, restricted places, place names', () => {
  assert.equal(dateList(['2026-10-31']), 'Oct 31')
  assert.equal(dateList(['2026-10-31', '2026-10-24', '2026-10-24']), 'Oct 24 and Oct 31')
  assert.equal(dateList(['2026-10-20', '2026-10-24', '2026-11-02']), 'Oct 20, Oct 24 and Nov 2')
  assert.ok(isRestricted('Santa Margarita Ranch (restricted access)'))
  assert.ok(isRestricted('Smith Farm (private)'))
  assert.ok(!isRestricted('San Francisco Zoo'))
  assert.equal(placeName('Santa Margarita Ranch (LTC 079) (restricted access)'), 'Santa Margarita Ranch (LTC 079)')
})

test('a card is mega only for a Code 4 or 5 the HQ desk shared', () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret-123'
  const { cardLayout } = require('../lib/shareCard')
  assert.equal(cardLayout({ card: { aba: 5 } }), 'mega')
  assert.equal(cardLayout({ card: { aba: 4 } }), 'mega')
  assert.equal(cardLayout({ card: { aba: 3 } }), 'plain')
  assert.equal(cardLayout({}), 'plain')
})

test('a mega card renders a 1200x630 JPEG (photo and map tiles stubbed)', async () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-test-secret-test-secret-123'
  const { Jimp, JimpMime } = require('jimp')
  const { renderMegaCard } = require('../lib/shareCard')
  const photo = await new Jimp({ width: 400, height: 300, color: 0x336699ff }).getBuffer(JimpMime.png)
  const tile = await new Jimp({ width: 256, height: 256, color: 0xddddddff }).getBuffer(JimpMime.png)
  const realFetch = global.fetch
  global.fetch = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => (String(url).includes('tile.openstreetmap') ? tile : photo) })
  try {
    const jpeg = await renderMegaCard({ comName: 'Mottled Owl', birdImg: 'https://upload.wikimedia.org/x.jpg', lat: 26.43, lng: -98.93, obsDt: '2026-10-31 18:25', card: { aba: 5, county: 'Starr Co.', stateName: 'Texas', confirmed: true } })
    const image = await Jimp.read(jpeg)
    assert.deepEqual([image.bitmap.width, image.bitmap.height], [1200, 630])
  } finally { global.fetch = realFetch }
})
