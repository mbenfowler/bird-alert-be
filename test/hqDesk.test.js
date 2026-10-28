const { test } = require('node:test')
const assert = require('node:assert/strict')
const { pickRarities, draftPost, isWholeSpecies, checkStillThere, stillLine } = require('../lib/hqDesk')

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
  const [dashed] = pickRarities(Array.from({ length: 3 }, (_, i) => rec({ subId: `D${i}`, locName: 'Fiesta Island--dog run' })))
  assert.match(draftPost(dashed, 'x', '2026-10-27'), /📍 Fiesta Island – dog run, Burlington Co\./)
  assert.equal(isWholeSpecies('Brant (Pale-bellied)'), false)
  assert.equal(isWholeSpecies('Greater/Lesser Yellowlegs'), false)
  assert.equal(isWholeSpecies('Ruff'), true)
})

test('a post says the bird is still being seen, only when the checklists since say so', () => {
  const [pick] = pickRarities(Array.from({ length: 5 }, (_, i) => rec({ subId: `S${i}`, userDisplayName: `B${i}` })))
  const url = 'https://bird-alert.vercel.app/share/s/AbCdEfGhJk'
  assert.match(draftPost({ ...pick, still: { checkedSince: 6, foundSince: 6, missesSince: 0 } }, url, '2026-10-27'), /👀 still there: on all 6 checklists since\n/)
  assert.match(draftPost({ ...pick, still: { checkedSince: 6, foundSince: 5, missesSince: 1 } }, url, '2026-10-27'), /👀 on 5 of 6 checklists since\n/)
  assert.equal(stillLine({ checkedSince: 3, foundSince: 0, missesSince: 3 }), null, 'misses only: say nothing rather than "0 of 3"')
  assert.equal(stillLine({ checkedSince: 0, foundSince: 0, missesSince: 0 }), null)
  assert.ok(!draftPost(pick, url, '2026-10-27').includes('👀'), 'unchecked: no line')
  // A long name and place still fit: hashtags go before the "still there" line does.
  const long = { ...pick, comName: 'Northern Rough-winged Swallow x Bank Swallow', place: { ...pick.place, locName: 'A'.repeat(150) }, still: { checkedSince: 2, foundSince: 2, missesSince: 0 } }
  const text = draftPost(long, url, '2026-10-27')
  assert.ok(text.length <= 280)
  assert.ok(text.includes(url))
})

test('still-there checks run in rank order and stop when the time is up, leaving the rest unchecked', async () => {
  const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map((code) => ({ speciesCode: code, place: { locId: 'L1' } }))
  const asked = []
  const slow = async ({ code, maxLooks }) => { asked.push([code, maxLooks]); await new Promise((r) => setTimeout(r, 30)); return { verdict: code === 'b' ? 'gone' : 'likely' } }
  const out = await checkStillThere(candidates, { check: slow, budgetMs: 10 })
  assert.deepEqual(asked.map((a) => a[0]), ['a', 'b', 'c', 'd'], 'four at a time, then the budget is spent')
  assert.equal(asked[0][1], 4)
  assert.deepEqual(out.map((p) => p.still?.verdict ?? null), ['likely', 'gone', 'likely', 'likely', null, null])
  const failing = await checkStillThere(candidates.slice(0, 1), { check: async () => { throw new Error('eBird down') } })
  assert.equal(failing[0].still, null, 'a failed check keeps the bird in')
})

test('ABA Checklist codes rank a rarity for the whole ABA Area above a local oddity, and drafts name them', () => {
  const { parseChecklist } = require('../lib/abaCodes')
  // The CSV's shape: family header rows, then "",English,French,Scientific,Alpha,Code.
  const codes = parseChecklist([
    ['Ducks, Geese, and Swans (Anatidae)', '', '', '', '', ''],
    ['', 'Ruff', 'Combattant varié', 'Calidris pugnax', 'RUFF', '3'],
    ['', 'Anhinga', "Anhinga d'Amérique", 'Anhinga anhinga', 'ANHI', '1'],
    ['', "Erckel's Spurfowl (Francolin)", '', 'Pternistis erckelii', 'ERSP', '2'],
    ['', 'Labrador Duck (extinct, 1858)', '', 'Camptorhynchus labradorius', 'LADU', '6']
  ])
  assert.deepEqual(codes.map((c) => [c.comName, c.code]), [['Ruff', 3], ['Anhinga', 1], ["Erckel's Spurfowl", 2], ['Labrador Duck', 6]])
  const bySci = new Map(codes.map((c) => [c.sciName, c.code]))
  const records = [
    ...Array.from({ length: 6 }, (_, i) => rec({ subId: `A${i}`, userDisplayName: `B${i}` })),
    ...Array.from({ length: 3 }, (_, i) => rec({ speciesCode: 'ruff', comName: 'Ruff', sciName: 'Calidris pugnax', subnational1Code: 'US-ME', subnational1Name: 'Maine', locId: 'L9', locName: 'Sebasticook Lake', subId: `R${i}`, userDisplayName: `M${i}` }))
  ]
  const without = pickRarities(records)
  assert.equal(without[0].comName, 'Anhinga', 'by the chase alone, the busier Anhinga leads')
  const withCodes = pickRarities(records, { codeOf: (g) => bySci.get(g.sciName) ?? null })
  assert.deepEqual(withCodes.map((p) => [p.comName, p.aba]), [['Ruff', 3], ['Anhinga', 1]])
  assert.match(draftPost(withCodes[0], 'https://x.example/s', '2026-10-27'), /^🚨 Ruff in Maine · ABA Code 3\n/)
  assert.match(draftPost(withCodes[1], 'https://x.example/s', '2026-10-27'), /^🚨 Anhinga in New Jersey\n/, 'codes 1-2 are not shown')
})
