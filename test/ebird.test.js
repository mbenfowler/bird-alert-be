const { test } = require('node:test')
const assert = require('node:assert/strict')
const ebird = require('../lib/ebird')
const { withFetch, jsonResponse } = require('./helpers')

test('identifier validation blocks anything that is not eBird-shaped', () => {
  assert.equal(ebird.assertRegion('US-GA-139'), 'US-GA-139')
  assert.throws(() => ebird.assertRegion('../etc'), /Invalid region/)
  assert.equal(ebird.assertSpecies('cangoo'), 'cangoo')
  assert.throws(() => ebird.assertSpecies('DROP TABLE'), /Invalid species/)
  assert.equal(ebird.assertState('ga'), 'ga')
  assert.throws(() => ebird.assertState('GAA'), /Invalid state/)
})

test('requests carry the API key and encode parameters', async () => {
  process.env.EBIRD_API_KEY = 'k123'
  let seen
  await withFetch((url, init) => { seen = { url, init }; return jsonResponse(['cangoo']) }, async () => {
    const codes = await ebird.speciesList('US-GA-139')
    assert.deepEqual(codes, ['cangoo'])
  })
  assert.equal(seen.url, 'https://api.ebird.org/v2/product/spplist/US-GA-139')
  assert.equal(seen.init.headers['X-eBirdApiToken'], 'k123')

  await withFetch((url) => { seen = { url }; return jsonResponse([]) }, () => ebird.notableObservations('US-GA-139', 7))
  assert.equal(seen.url, 'https://api.ebird.org/v2/data/obs/US-GA-139/recent/notable?back=7')
})

test('a failing eBird call becomes a 502, not a crash', async () => {
  const quiet = console.error
  console.error = () => {}
  try {
    await withFetch(() => new Response('nope', { status: 500 }), async () => {
      await assert.rejects(ebird.speciesList('US-GA-139'), (error) => error.status === 502)
    })
  } finally { console.error = quiet }
})

test('the upstream status survives the 502 wrapper', async () => {
  const quiet = console.error
  console.error = () => {}
  try {
    await withFetch(() => new Response('slow down', { status: 429 }), async () => {
      await assert.rejects(ebird.historicObservations('US-GA-139', '2026-10-13'), (error) => error.status === 502 && error.upstream === 429)
    })
  } finally {
    console.error = quiet
  }
})
