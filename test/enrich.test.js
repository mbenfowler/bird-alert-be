const { test } = require('node:test')
const assert = require('node:assert/strict')
const { fetchWiki, isSpecies, lookupImage, namesBird } = require('../lib/enrich')
const { withFetch, jsonResponse } = require('./helpers')

// Each search hit is a page { id, key, title, taxon }; Wikidata files it under its taxon; its summary serves those back with a photo.
const wikiFetch = (searchHits) => (url) => {
  const pages = Object.values(searchHits)
  if (url.includes('/search/page')) {
    const q = new URL(url).searchParams.get('q')
    return jsonResponse({ pages: searchHits[q] ? [searchHits[q]] : [] })
  }
  if (url.includes('/page/summary/')) {
    const page = pages.find((p) => url.endsWith(`/${encodeURIComponent(p.key)}`))
    return jsonResponse({ title: page.title, wikibase_item: `Q${page.id}`, thumbnail: { source: `https://thumb.wikimedia.org/x/330px-${page.key}.jpg?utm_source=api` } })
  }
  if (url.includes('wikidata.org')) {
    const page = pages.find((p) => `Q${p.id}` === new URL(url).searchParams.get('entity'))
    return jsonResponse({ claims: { P225: page?.taxon ? [{ mainsnak: { datavalue: { value: page.taxon } } }] : [] } })
  }
  throw new Error(`unexpected fetch ${url}`)
}

test('scientific name is searched before the common name', async () => {
  const hits = {
    'Aythya americana': { id: 249872, key: 'Redhead_(bird)', title: 'Redhead (bird)', taxon: 'Aythya americana' },
    Redhead: { id: 1, key: 'Red_hair', title: 'Red hair' }
  }
  const wiki = await withFetch(wikiFetch(hits), () => fetchWiki({ comName: 'Redhead', sciName: 'Aythya americana' }))
  assert.equal(wiki.wikiURL, 'https://en.wikipedia.org/?curid=249872')
  assert.equal(wiki.wikiImage, 'https://thumb.wikimedia.org/x/330px-Redhead_(bird).jpg', 'tracking params stripped, size untouched')
})

test('falls back to the common name when the scientific name finds nothing', async () => {
  const hits = { Emu: { id: 76894, key: 'Emu', title: 'Emu' } }
  const wiki = await withFetch(wikiFetch(hits), () => fetchWiki({ comName: 'Emu', sciName: 'Dromaius novaehollandiae' }))
  assert.equal(wiki.wikiURL, 'https://en.wikipedia.org/?curid=76894')
})

test('a page that is a relative, not the bird, is passed over for one that names it, and none at all is better than a wrong photo', async () => {
  // Searching the scientific name landed on the related White-crowned Pigeon; the common name finds the right page.
  const hits = {
    'Patagioenas squamosa': { id: 10, key: 'White-crowned_pigeon', title: 'White-crowned pigeon', taxon: 'Patagioenas leucocephala' },
    'Scaly-naped Pigeon': { id: 11, key: 'Scaly-naped_pigeon', title: 'Scaly-naped pigeon', taxon: 'Patagioenas squamosa' }
  }
  const wiki = await withFetch(wikiFetch(hits), () => fetchWiki({ comName: 'Scaly-naped Pigeon', sciName: 'Patagioenas squamosa' }))
  assert.equal(wiki.wikiURL, 'https://en.wikipedia.org/?curid=11')
  const wrongOnly = { 'Patagioenas squamosa': hits['Patagioenas squamosa'] }
  assert.deepEqual(await withFetch(wikiFetch(wrongOnly), () => fetchWiki({ comName: 'Scaly-naped Pigeon', sciName: 'Patagioenas squamosa' })), { wikiURL: null, wikiImage: null })
})

test('an article is the bird by its title, or by the scientific name Wikidata files it under', () => {
  const bird = { comName: "Ross's Goose", sciName: 'Anser rossii' }
  assert.equal(namesBird({ title: 'Ross’s goose' }, bird), true, 'case and curly apostrophes do not matter')
  assert.equal(namesBird({ title: 'Snow goose' }, bird, ['Anser caerulescens']), false)
  assert.equal(namesBird({ title: 'Rock dove' }, { comName: 'Rock Pigeon', sciName: 'Columba livia' }, ['Columba livia']), true, 'a different English name is fine when the taxon matches')
  assert.equal(namesBird({ title: "Ross's Goose", type: 'disambiguation' }, bird), false)
  assert.equal(namesBird({ title: 'Geese' }, bird), false)
  assert.equal(namesBird({ title: 'American yellow warbler' }, { comName: 'Yellow Warbler', sciName: 'Setophaga petechia' }), true, 'a qualifier in front, after a split')
  assert.equal(namesBird({ title: 'Yellow warbler finch' }, { comName: 'Yellow Warbler', sciName: 'Setophaga petechia' }), false, 'but not a different bird that starts the same')
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
