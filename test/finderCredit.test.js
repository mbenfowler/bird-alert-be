const test = require('node:test')
const assert = require('node:assert/strict')
const { withCredits, firstReport } = require('../lib/finderCredit')
const { xDraft, facebookDraft, xLength, creditText } = require('../lib/megaPost')

const URL_ = 'https://bird-alert.vercel.app/share/s/abcdefghij'
const ASOF = '2026-11-02'
const warbler = {
  speciesCode: 'yebwar3', comName: 'Yellow-browed Warbler', state: 'US-CA', stateName: 'California', aba: 4, confirmed: 2, observers: 5,
  place: { locId: 'L1', locName: 'Rancho Corral de Tierra--Moss Beach area', county: 'San Mateo', lat: 37.5236, lng: -122.5059, days: ['2026-10-22', '2026-10-23'], media: true, obsDt: '2026-10-23 10:26' }
}
const owl = {
  speciesCode: 'motowl', comName: 'Mottled Owl', state: 'US-TX', stateName: 'Texas', aba: 5, confirmed: 5, observers: 4,
  place: { locId: 'L9', locName: 'Santa Margarita Ranch (LTC 079) (restricted access)', county: 'Starr', lat: 26.47, lng: -98.88, days: ['2026-10-24', '2026-10-31'], media: false, obsDt: '2026-10-31 18:25' }
}
const report = (over) => ({ speciesCode: 'yebwar3', locId: 'L1', lat: 37.5236, lng: -122.5059, obsDt: '2026-10-23 08:37', subId: 'S20', userDisplayName: 'Bea Chaser', ...over })

test('the first report at the place wins, ties go to the earlier checklist, others are counted once', () => {
  const records = [
    report({ obsDt: '2026-10-23 08:37', subId: 'S20', userDisplayName: 'Bea Chaser' }),
    report({ obsDt: '2026-10-22 12:50', subId: 'S12', userDisplayName: 'Jane Finder' }),
    report({ obsDt: '2026-10-22 12:50', subId: 'S100', userDisplayName: 'Tie Loser' }),
    report({ obsDt: '2026-10-23 09:54', subId: 'S21', userDisplayName: 'Bea Chaser' }),
    report({ locId: 'L2', lat: 37.52355, lng: -122.50589, obsDt: '2026-10-23 10:00', subId: 'S22', userDisplayName: 'Nearby Neighbor' }), // 100 m away: the same spot
    report({ locId: 'L3', lat: 38.5, lng: -122.5, obsDt: '2026-10-01 07:00', subId: 'S1', userDisplayName: 'Far Away' }), // another place
    report({ speciesCode: 'other', obsDt: '2026-10-01 07:00', subId: 'S2', userDisplayName: 'Wrong Bird' })
  ]
  const c = firstReport(records, warbler, ASOF)
  assert.deepEqual(c, { name: 'Jane Finder', others: 3, observers: 4, firstDay: '2026-10-22', verified: true })
  assert.equal(firstReport([], warbler, ASOF), null)
})

test('a first report on the edge of the 30 days is "reported by", not "found by"', () => {
  const edge = firstReport([report({ obsDt: '2026-10-04 07:00', userDisplayName: 'Old Timer' }), report({ subId: 'S30', userDisplayName: 'Bea Chaser' })], warbler, ASOF)
  assert.equal(edge.verified, false)
  assert.equal(creditText({ ...warbler, credit: edge }), 'reported by Old Timer and 1 other')
  const inside = firstReport([report({ obsDt: '2026-10-05 07:00', userDisplayName: 'Early Bird' })], warbler, ASOF)
  assert.equal(inside.verified, true)
  assert.equal(creditText({ ...warbler, credit: inside }), 'found by Early Bird')
})

test('a private or restricted place never names anyone', () => {
  const credit = { name: 'Ranch Guest', others: 3, observers: 4, firstDay: '2026-10-24', verified: true }
  assert.equal(creditText({ ...owl, credit }), 'reported by 4 observers')
  assert.equal(creditText({ ...owl, credit: { ...credit, observers: 1, others: 0 } }), null)
  assert.equal(creditText({ ...warbler, place: { ...warbler.place, locationPrivate: true }, credit }), 'reported by 4 observers')
  const x = xDraft({ ...owl, credit }, URL_)
  const fb = facebookDraft({ ...owl, credit }, URL_)
  assert.doesNotMatch(x + fb, /Ranch Guest/)
  assert.match(x, /\(private, by arrangement only 🙏\) · reported by 4 observers/)
  assert.match(fb, /Reported by 4 observers\./)
})

test('X: the credit rides on the place line, under 280, and goes last when trimming (never the link or access note)', () => {
  const credit = { name: 'Jane Finder', others: 3, observers: 4, firstDay: '2026-10-22', verified: true }
  const x = xDraft({ ...warbler, credit }, URL_)
  assert.match(x, /Seen Oct 22 and Oct 23 at Rancho Corral de Tierra – Moss Beach area, San Mateo Co\. · found by Jane Finder \(and 3 others\)/)
  assert.doesNotMatch(x, /5 observers/, 'the credit counts them, so the evidence line does not repeat it')
  assert.ok(xLength(x, URL_) <= 280)
  // Long: hashtags and the rarity line go before the credit does.
  const long = { ...warbler, comName: 'Northern Rough-winged Swallow', stateName: 'Newfoundland and Labrador', state: 'CA-NL', place: { ...warbler.place, locName: 'A rather long sea watch at the far end of the road', county: 'Division No. 1, Subdivision Y' }, credit: { ...credit, name: 'Bartholomew Featherstonehaugh-Smythe' } }
  const lx = xDraft(long, URL_)
  assert.ok(xLength(lx, URL_) <= 280, `${xLength(lx, URL_)}: ${lx}`)
  assert.ok(lx.includes(URL_))
  if (!lx.includes('found by')) assert.doesNotMatch(lx, /#birding/, 'the hashtags went first')
  // Very long: the credit goes, the access note and link stay.
  const huge = { ...owl, credit: { ...credit, name: 'X'.repeat(60) }, place: { ...owl.place, locationPrivate: false, locName: `${'An extremely long ranch name for a sea watch '.repeat(3)}(restricted access)` } }
  const hx = xDraft(huge, URL_)
  assert.ok(xLength(hx, URL_) <= 280)
  assert.ok(hx.includes(URL_))
  assert.match(hx, /by arrangement only/)
})

test('Facebook: a sentence for the finder, with the date and the others since', () => {
  const fb = facebookDraft({ ...warbler, credit: { name: 'Jane Finder', others: 3, observers: 4, firstDay: '2026-10-22', verified: true } }, URL_)
  assert.match(fb, /on Oct 22 and Oct 23, confirmed by eBird's reviewers\. First reported by Jane Finder on Oct 22, with 3 others since\./)
  const unsure = facebookDraft({ ...warbler, credit: { name: 'Old Timer', others: 1, observers: 2, firstDay: '2026-10-04', verified: false } }, URL_)
  assert.match(unsure, /Reported by Old Timer and 1 other\./)
  assert.match(facebookDraft(warbler, URL_), /by 5 observers/, 'without a credit, the count stays in the story')
})

test('one call per state; a state that fails leaves its picks as they were', async () => {
  const calls = []
  const ca2 = { ...warbler, speciesCode: 'other2', place: { ...warbler.place, locId: 'L7' } }
  const fetch = async (state) => {
    calls.push(state)
    if (state === 'US-TX') throw new Error('eBird is busy')
    return [report({ obsDt: '2026-10-22 12:50', userDisplayName: 'Jane Finder' })]
  }
  const out = await withCredits([warbler, ca2, owl], { asOf: ASOF, fetch })
  assert.deepEqual(calls.sort(), ['US-CA', 'US-TX'])
  assert.equal(out[0].credit.name, 'Jane Finder')
  assert.equal(out[1].credit, undefined, 'no report of that bird there')
  assert.equal(out[2].credit, undefined, 'the failed state: no credit, nothing thrown')
})
