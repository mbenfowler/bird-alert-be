const db = require('./db')
const ebird = require('./ebird')

const NUTHATCH_URL = 'https://nuthatch.lastelm.software/v2/birds'
const WIKI_SEARCH_URL = 'https://api.wikimedia.org/core/v1/wikipedia/en/search/page'
const WIKI_SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary'
const USER_AGENT = 'bird-alert (https://github.com/mbenfowler/bird-alert)'

// Both lookups are best-effort decoration: a failure yields null, never an error.
const fetchImage = async (comName) => {
  if (!process.env.NUTHATCH_API_KEY) return null
  try {
    const url = new URL(NUTHATCH_URL)
    url.search = new URLSearchParams({ page: '1', pageSize: '25', name: comName, operator: 'AND' })
    const res = await fetch(url, { headers: { 'API-Key': process.env.NUTHATCH_API_KEY } })
    if (!res.ok) return null
    const data = await res.json()
    const image = data.entities?.[0]?.images?.[0]
    return image ? `${image}?q=75&fm=jpg&w=400&fit=max` : null
  } catch (error) {
    console.error(`Nuthatch lookup failed for ${comName}:`, error.message)
    return null
  }
}

const wikiHeaders = { headers: { 'User-Agent': USER_AGENT } }

const searchWikiPage = async (term) => {
  const url = new URL(WIKI_SEARCH_URL)
  url.search = new URLSearchParams({ q: term, limit: '1' })
  const res = await fetch(url, wikiHeaders)
  if (!res.ok) return null
  return (await res.json()).pages?.[0] || null
}

// Wikipedia: the article link, plus its lead image as a fallback when Nuthatch has none.
// Scientific names are unambiguous ("Aythya americana" finds the duck; "Redhead" finds hair colour),
// so they are tried first.
const fetchWiki = async ({ comName, sciName }) => {
  const none = { wikiURL: null, wikiImage: null }
  try {
    const page = (sciName && await searchWikiPage(sciName)) || await searchWikiPage(comName)
    if (!page?.id) return none
    const wikiURL = `https://en.wikipedia.org/?curid=${page.id}`

    const summaryRes = await fetch(`${WIKI_SUMMARY_URL}/${encodeURIComponent(page.key)}`, wikiHeaders)
    if (!summaryRes.ok) return { wikiURL, wikiImage: null }
    const thumb = (await summaryRes.json()).thumbnail?.source
    // Thumbnails come back around 320px wide; the same path at 400px matches our card size.
    const wikiImage = thumb ? thumb.replace(/\/(\d+)px-/, '/400px-') : null
    return { wikiURL, wikiImage }
  } catch (error) {
    console.error(`Wikipedia lookup failed for ${comName}:`, error.message)
    return none
  }
}

/** Best available picture for a bird: Nuthatch first, then Wikipedia's lead image. */
const lookupImage = async ({ comName, sciName }) => (await fetchImage(comName)) || (await fetchWiki({ comName, sciName })).wikiImage

const buildBird = async (taxon) => {
  const [nuthatchImage, wiki] = await Promise.all([fetchImage(taxon.comName), fetchWiki(taxon)])
  return {
    comName: taxon.comName,
    sciName: taxon.sciName,
    speciesCode: taxon.speciesCode,
    category: taxon.category,
    order: taxon.order,
    familyCode: taxon.familyCode,
    familyComName: taxon.familyComName,
    familySciName: taxon.familySciName,
    taxonOrder: Number.isFinite(taxon.taxonOrder) ? Math.round(taxon.taxonOrder) : null,
    birdImg: nuthatchImage || wiki.wikiImage,
    wikiURL: wiki.wikiURL
  }
}

/**
 * Returns bird rows for the given species codes, in request order. Codes we have not seen
 * before are resolved from eBird taxonomy, decorated with an image and a Wikipedia link,
 * and stored so the next request is a single database read.
 */
const findOrCreateBirds = async (codes) => {
  const unique = [...new Set(codes)]
  const known = await db('birds').whereIn('speciesCode', unique)
  const byCode = new Map(known.map((bird) => [bird.speciesCode, bird]))

  const missing = unique.filter((code) => !byCode.has(code))
  if (missing.length) {
    const taxa = await ebird.taxonomy(missing)
    const birds = await Promise.all(taxa.map(buildBird))
    if (birds.length) {
      await db('birds').insert(birds).onConflict('speciesCode').ignore()
      const stored = await db('birds').whereIn('speciesCode', birds.map((bird) => bird.speciesCode))
      for (const bird of stored) byCode.set(bird.speciesCode, bird)
    }
  }

  return codes.map((code) => byCode.get(code)).filter(Boolean)
}

module.exports = { findOrCreateBirds, lookupImage }
