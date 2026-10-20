const { test } = require('node:test')
const assert = require('node:assert/strict')
const { fetchWiki, isSpecies, lookupImage } = require('../lib/enrich')
const { withFetch, jsonResponse } = require('./helpers')

const wikiFetch = (searchHits) => (url) => {
  if (url.includes('/search/page')) {
    const q = new URL(url).searchParams.get('q')
    return jsonResponse({ pages: searchHits[q] ? [searchHits[q]] : [] })
  }
  if (url.includes('/page/summary/')) {
    return jsonResponse({ thumbnail: { source: 'https://thumb.wikimedia.org/x/330px-Bird.jpg?utm_source=api' } })
  }
  if (url.includes('nuthatch')) return jsonResponse({ entities: [] })
  throw new Error(`unexpected fetch ${url}`)
}

test('scientific name is searched before the common name', async () => {
  const hits = { 'Aythya americana': { id: 249872, key: 'Redhead_(bird)' }, Redhead: { id: 1, key: 'Red_hair' } }
  const wiki = await withFetch(wikiFetch(hits), () => fetchWiki({ comName: 'Redhead', sciName: 'Aythya americana' }))
  assert.equal(wiki.wikiURL, 'https://en.wikipedia.org/?curid=249872')
  assert.equal(wiki.wikiImage, 'https://thumb.wikimedia.org/x/330px-Bird.jpg', 'tracking params stripped, size untouched')
})

test('falls back to the common name when the scientific name finds nothing', async () => {
  const hits = { Emu: { id: 76894, key: 'Emu' } }
  const wiki = await withFetch(wikiFetch(hits), () => fetchWiki({ comName: 'Emu', sciName: 'Dromaius novaehollandiae' }))
  assert.equal(wiki.wikiURL, 'https://en.wikipedia.org/?curid=76894')
})

test('non-species taxa get no lookups at all', async () => {
  assert.equal(isSpecies({ category: 'species' }), true)
  assert.equal(isSpecies({ category: 'hybrid' }), false)
  let fetched = false
  const image = await withFetch(() => { fetched = true; return jsonResponse({}) }, () =>
    lookupImage({ comName: 'Mallard x Black Duck (hybrid)', sciName: 'Anas platyrhynchos x rubripes', category: 'hybrid' }))
  assert.equal(image, null)
  assert.equal(fetched, false)
})
