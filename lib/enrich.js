const db = require('./db')
const ebird = require('./ebird')

const NUTHATCH_URL = 'https://nuthatch.lastelm.software/v2/birds'
const WIKI_URL = 'https://api.wikimedia.org/core/v1/wikipedia/en/search/page'
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

const fetchWikiUrl = async (comName) => {
  try {
    const url = new URL(WIKI_URL)
    url.search = new URLSearchParams({ q: comName, limit: '1' })
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
    if (!res.ok) return null
    const data = await res.json()
    const id = data.pages?.[0]?.id
    return id ? `https://en.wikipedia.org/?curid=${id}` : null
  } catch (error) {
    console.error(`Wikipedia lookup failed for ${comName}:`, error.message)
    return null
  }
}

const buildBird = async (taxon) => {
  const [birdImg, wikiURL] = await Promise.all([fetchImage(taxon.comName), fetchWikiUrl(taxon.comName)])
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
    birdImg,
    wikiURL
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

module.exports = { findOrCreateBirds }
