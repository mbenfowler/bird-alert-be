const { test } = require('node:test')
const assert = require('node:assert/strict')
const { withEvidence, withoutEscapees, evidenceLine } = require('../lib/evidence')
const { sightingNotification, reviewNotification } = require('../lib/notifications')
const { reviewFields } = require('../lib/pushAlerts')

const report = (over) => ({ speciesCode: 'yegvir', comName: 'Yellow-green Vireo', locId: 'L1', locName: 'San Francisco Zoo', lat: 37.733, lng: -122.503, obsDt: '2026-10-29 09:10', subId: 'S1', obsReviewed: false, obsValid: false, hasRichMedia: false, evidence: null, userDisplayName: 'A Birder', ...over })

test('evidence reads every report of the bird at that spot: reviewer, media and how many birders', () => {
  const rows = withEvidence([
    report({ subId: 'S1', userDisplayName: 'Ann' }),
    report({ subId: 'S2', userDisplayName: 'Bo', obsReviewed: true, obsValid: true, evidence: 'P', hasRichMedia: true }),
    // A second checklist by the same birder is one birder.
    report({ subId: 'S3', userDisplayName: 'Ann' }),
    // 600 m away at another locId still counts; 5 km away doesn't.
    report({ subId: 'S4', locId: 'L2', lat: 37.738, userDisplayName: 'Cy' }),
    report({ subId: 'S5', locId: 'L9', lat: 37.78, userDisplayName: 'Di' }),
    // Another species at the same spot is no evidence for this one.
    report({ subId: 'S6', speciesCode: 'other', userDisplayName: 'Ed', obsReviewed: true, obsValid: true })
  ])
  assert.deepEqual(rows[0].evidence, { confirmed: true, media: 'photo', birders: 3 }, 'a fresh report of a confirmed bird is a confirmed bird')
  assert.deepEqual(rows[4].evidence, { confirmed: false, media: null, birders: 1 })
  // Without observer names each checklist counts once.
  const anonymous = withEvidence([report({ subId: 'S1', userDisplayName: undefined }), report({ subId: 'S2', userDisplayName: undefined, evidence: 'A', hasRichMedia: true })])
  assert.deepEqual(anonymous[0].evidence, { confirmed: false, media: 'audio', birders: 2 })
})

test('only escapees eBird itself marks are dropped; a zoo is not a reason', () => {
  const notable = [report({ speciesCode: 'yegvir' }), report({ speciesCode: 'cockat', comName: 'Cockatiel' }), report({ speciesCode: 'monpar', comName: 'Monk Parakeet' })]
  const recent = [{ speciesCode: 'cockat', exoticCategory: 'X' }, { speciesCode: 'monpar', exoticCategory: 'N' }, { speciesCode: 'yegvir' }]
  assert.deepEqual(withoutEscapees(notable, recent).map((o) => o.speciesCode), ['yegvir', 'monpar'])
  assert.equal(withoutEscapees(notable, []).length, 3, 'no recent feed, nothing dropped')
})

test('the evidence line is plain, and unconfirmed reports still go out marked as such', () => {
  assert.equal(evidenceLine({ confirmed: true, media: 'photo', birders: 3 }), 'Confirmed by eBird reviewer · photo · 3 birders')
  assert.equal(evidenceLine({ confirmed: false, media: null, birders: 1 }), 'Unconfirmed: not yet reviewed · 1 birder')
  assert.equal(evidenceLine(null), '')
  const push = sightingNotification({ ...report({}), kind: 'notable', aba: 3, region: 'US-CA-075', evidence: { confirmed: false, media: null, birders: 1 } })
  assert.match(push.body, /Unconfirmed: not yet reviewed · 1 birder$/)
  const watched = sightingNotification({ ...report({}), kind: 'season' })
  assert.doesNotMatch(watched.body, /review/, 'no evidence, no line')
})

test('a Code 3-5 bird sent before review is followed; confirmed ones and Codes 1-2 are not', () => {
  const unconfirmed = { ...report({}), evidence: { confirmed: false, media: null, birders: 1 } }
  assert.equal(reviewFields(unconfirmed, 3, 'US-CA-075').review_state, 'pending')
  assert.equal(reviewFields(unconfirmed, 5, 'US-CA-075').review_state, 'pending')
  assert.equal(reviewFields(unconfirmed, 2, 'US-CA-075').review_state, null)
  assert.equal(reviewFields(unconfirmed, null, 'US-CA-075').review_state, null)
  assert.equal(reviewFields({ ...unconfirmed, evidence: { confirmed: true, media: null, birders: 4 } }, 4, 'US-CA-075').review_state, null)
  // A range alert is followed in the county it was reported in.
  assert.equal(reviewFields({ ...unconfirmed, away: { miles: 20, region: 'US-CA-081' } }, 4, 'US-CA-075').sighting_region, 'US-CA-081')
  const follow = reviewNotification({ speciesCode: 'yebwar', subId: 'S9', comName: 'Yellow-browed Warbler', locName: 'Rancho Corral de Tierra', obsDt: '2026-10-22 12:50', aba: 4, region: 'US-CA-081' })
  assert.equal(follow.title, '✅ Now confirmed by eBird: Yellow-browed Warbler')
  assert.equal(follow.body, 'Rancho Corral de Tierra · Oct 22, 12:50 PM · ABA Code 4')
  assert.match(follow.data.url, /\/sighting\/yebwar\/S9\?region=US-CA-081$/)
})
