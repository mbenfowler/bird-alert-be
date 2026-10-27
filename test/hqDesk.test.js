const { test } = require('node:test')
const assert = require('node:assert/strict')
const { pickRarities, draftPost, isWholeSpecies } = require('../lib/hqDesk')

const rec = (over) => ({ speciesCode: 'anhing', comName: 'Anhinga', sciName: 'Anhinga anhinga', subnational1Code: 'US-NJ', subnational1Name: 'New Jersey', subnational2Name: 'Burlington', locId: 'L1', locName: 'Laurel Acres Park', lat: 39.9, lng: -74.9, obsDt: '2026-10-27 08:00', subId: 'S1', userDisplayName: 'A', obsValid: true, obsReviewed: true, locationPrivate: false, ...over })

test('a chased, confirmed bird notable in one state outranks a lone report and an irruption', () => {
  const records = [
    ...Array.from({ length: 12 }, (_, i) => rec({ subId: `S${i}`, userDisplayName: `Birder ${i}`, obsDt: `2026-10-27 0${i % 9}:00` })),
    // An irruption: the same finch notable in ten states, chased in one.
    ...Array.from({ length: 10 }, (_, i) => rec({ speciesCode: 'pinsis', comName: 'Pine Siskin', subnational1Code: `US-S${i}`, subnational1Name: `State ${i}`, subId: `P${i}` })),
    ...Array.from({ length: 11 }, (_, i) => rec({ speciesCode: 'pinsis', comName: 'Pine Siskin', subnational1Code: 'US-MD', subnational1Name: 'Maryland', subId: `M${i}`, userDisplayName: `B${i}` })),
    // One unreviewed report: not enough to pitch.
    rec({ speciesCode: 'ruff', comName: 'Ruff', subnational1Code: 'US-ME', subnational1Name: 'Maine', subId: 'R1', obsReviewed: false }),
    // Only ever seen in someone's yard: counted, but never posted.
    rec({ speciesCode: 'paibun', comName: 'Painted Bunting', subnational1Code: 'US-OH', subnational1Name: 'Ohio', subId: 'Y1', locationPrivate: true }),
    rec({ speciesCode: 'paibun', comName: 'Painted Bunting', subnational1Code: 'US-OH', subnational1Name: 'Ohio', subId: 'Y2', locationPrivate: true }),
    // Forms and hybrids are left to the experts.
    rec({ speciesCode: 'x1', comName: 'Mallard x American Black Duck (hybrid)', subId: 'H1' }), rec({ speciesCode: 'x1', comName: 'Mallard x American Black Duck (hybrid)', subId: 'H2' })
  ]
  const picks = pickRarities(records)
  assert.deepEqual(picks.map((p) => p.comName), ['Anhinga', 'Pine Siskin'])
  assert.equal(picks[0].checklists, 12)
  assert.equal(picks[0].observers, 12)
  assert.equal(picks[0].place.locName, 'Laurel Acres Park')
  assert.ok(picks[0].score > picks[1].score + 4)
})

test('drafts fit a post, say how solid the report is, and carry the link', () => {
  const [pick] = pickRarities(Array.from({ length: 5 }, (_, i) => rec({ subId: `S${i}`, userDisplayName: `B${i}` })))
  const text = draftPost(pick, 'https://bird-alert.vercel.app/share/s/AbCdEfGhJk', '2026-10-27')
  assert.ok(text.length <= 280)
  assert.match(text, /^🚨 Anhinga in New Jersey\n📍 Laurel Acres Park, Burlington Co\.\n🗓 reported today · 5 checklists, confirmed\nhttps:\/\/bird-alert.vercel.app\/share\/s\/AbCdEfGhJk\nvia eBird/)
  assert.equal(isWholeSpecies('Brant (Pale-bellied)'), false)
  assert.equal(isWholeSpecies('Greater/Lesser Yellowlegs'), false)
  assert.equal(isWholeSpecies('Ruff'), true)
})
