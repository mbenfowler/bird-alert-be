const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseCsv, parseDay, exportRows, planImport } = require('../lib/lifeList')

// Shaped like eBird's life list export, with the awkward rows a real one has.
const CSV = `﻿Row #,Taxon Order,Category,Common Name,Scientific Name,Count,Location,S/P,Date,LocID,SubID,Exotic,Countable
1,34211,species,Tennessee Warbler,Leiothlypis peregrina,,Riverside Home!,US-GA,13 Oct 2026,L1,S1,,1
2,100,species,House Sparrow,Passer domesticus,,"Barr Lake, east side",US-CO,10 Mar 2024,L2,S2,N,1
3,200,species,Muscovy Duck,Cairina moschata,,Chicopee Lake!,US-GA,14 Sep 2025,L3,S3,X,0
4,300,slash,Eastern/Western Warbling Vireo,Vireo gilvus/swainsoni,,Walden Ponds,US-CO,25 May 2024,L4,S4,,0
5,400,issf,Dark-eyed Junco (Slate-colored),Junco hyemalis hyemalis/carolinensis,,Home,US-GA,01 Jan 2020,L5,S5,,1
6,401,species,Dark-eyed Junco,Junco hyemalis,,Home,US-GA,05 Feb 2019,L5,S6,,1
7,500,species,Old Name Bird,Oldus namus,,Home,US-GA,01 Jan 2018,L5,S7,,1
8,600,spuh,warbler sp.,Parulidae sp.,,Home,US-GA,01 Jan 2018,L5,S8,,1
9,700,species,"Bird, With Comma",Commaria test,,Home,US-GA,02 Jan 2018,L5,S9,,1
10,6190,species,Saltmarsh/Prairie Willet,Tringa semipalmata/inornata,,Jekyll Island,US-GA,01 Jun 2021,L6,S10,,1
`

const TAXA = [
  { species_code: 'tenwar', sci_name: 'Leiothlypis peregrina', com_name: 'Tennessee Warbler', category: 'species', report_as: null },
  { species_code: 'houspa', sci_name: 'Passer domesticus', com_name: 'House Sparrow', category: 'species', report_as: null },
  { species_code: 'musduc', sci_name: 'Cairina moschata', com_name: 'Muscovy Duck', category: 'species', report_as: null },
  { species_code: 'daejun', sci_name: 'Junco hyemalis', com_name: 'Dark-eyed Junco', category: 'species', report_as: null },
  { species_code: 'slcjun', sci_name: 'Junco hyemalis hyemalis/carolinensis', com_name: 'Dark-eyed Junco (Slate-colored)', category: 'issf', report_as: 'daejun' },
  { species_code: 'willet1', sci_name: 'Tringa semipalmata/inornata', com_name: 'Saltmarsh/Prairie Willet', category: 'slash', report_as: null },
  { species_code: 'willet2', sci_name: 'Tringa semipalmata', com_name: 'Saltmarsh Willet', category: 'species', report_as: null },
  { species_code: 'willet3', sci_name: 'Tringa inornata', com_name: 'Prairie Willet', category: 'species', report_as: null },
  { species_code: 'comtes', sci_name: 'Commaria test', com_name: 'Bird, With Comma', category: 'species', report_as: null }
]
const lookup = async () => TAXA

test('CSV fields may be quoted, with commas and doubled quotes inside', () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,2,3\n'), [['a', 'b, c', 'say "hi"'], ['1', '2', '3']])
})

test('a slash names its species', () => {
  const { slashParts } = require('../lib/lifeList')
  assert.deepEqual(slashParts('Tringa semipalmata/inornata'), ['Tringa semipalmata', 'Tringa inornata'])
  assert.deepEqual(slashParts('Passer domesticus'), [])
})

test('eBird dates become ISO days', () => {
  assert.equal(parseDay('13 Oct 2026'), '2026-10-13')
  assert.equal(parseDay('5 May 2024'), '2024-05-05')
  assert.equal(parseDay('2024-05-05'), '2024-05-05')
  assert.equal(parseDay('sometime'), null)
})

test('an export becomes species codes, earliest day kept, and every row left out says why', async () => {
  const { species, skipped } = await planImport(exportRows(CSV), lookup)
  const byCode = Object.fromEntries(species.map((s) => [s.speciesCode, s.day]))
  assert.deepEqual(Object.keys(byCode).sort(), ['comtes', 'daejun', 'houspa', 'tenwar'])
  // The subspecies group counts as its species, and the earlier of the two days wins.
  assert.equal(byCode.daejun, '2019-02-05')
  assert.equal(byCode.houspa, '2024-03-10', 'naturalized birds count')
  const reasons = Object.fromEntries(skipped.map((s) => [s.name, s.reason]))
  assert.match(reasons['Muscovy Duck'], /escapee/)
  assert.match(reasons['Eastern/Western Warbling Vireo'], /yours to say which/)
  // A sighting from before a split: still countable in the export, but which species is the person's call.
  const willet = skipped.find((s) => s.name === 'Saltmarsh/Prairie Willet')
  assert.deepEqual(willet.choices.map((c) => c.speciesCode), ['willet2', 'willet3'])
  assert.deepEqual(skipped.find((s) => s.name === 'Muscovy Duck').choices, [{ speciesCode: 'musduc', comName: 'Muscovy Duck' }], 'an escapee can still be marked by hand')
  assert.match(reasons['warbler sp.'], /not identified/)
  assert.match(reasons['Old Name Bird'], /not found/)
})

test('a file that is not an eBird export is refused', () => {
  assert.throws(() => exportRows('foo,bar\n1,2\n'), /eBird life list export/)
  assert.throws(() => exportRows(''), /empty/)
})

test('the daily prediction budget walks the whole list over the days', () => {
  const { dailySlice } = require('../lib/grading')
  const codes = Array.from({ length: 100 }, (_, i) => `sp${String(i).padStart(3, '0')}`)
  const covered = new Set()
  for (let d = 1; d <= 5; d += 1) {
    const slice = dailySlice(codes, `2026-11-0${d}`)
    assert.equal(slice.length, 40)
    slice.forEach((c) => covered.add(c))
  }
  assert.equal(covered.size, 100, 'three days already cover a hundred')
  assert.deepEqual(dailySlice(codes.slice(0, 5), '2026-11-01'), codes.slice(0, 5))
})
