const db = require('./db')
const ebird = require('./ebird')

const WIKI_SEARCH_URL = 'https://api.wikimedia.org/core/v1/wikipedia/en/search/page'
const WIKI_SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary'
const USER_AGENT = 'bird-alert (https://github.com/mbenfowler/bird-alert)'

const wikiHeaders = { headers: { 'User-Agent': USER_AGENT } }

const searchWikiPage = async (term) => {
  const url = new URL(WIKI_SEARCH_URL)
  url.search = new URLSearchParams({ q: term, limit: '1' })
  const res = await fetch(url, wikiHeaders)
  if (!res.ok) { console.error(`Wikipedia search ${res.status} for ${term}`); return null }
  return (await res.json()).pages?.[0] || null
}

const plain = (text) => String(text || '').toLowerCase().replace(/[’‘]/g, "'").replace(/-/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * Whether an article is about this bird: its title is the bird's name (or the name with a qualifier
 * in front, "American yellow warbler" for Yellow Warbler, after a split), or Wikidata files the
 * article under the bird's scientific name. A search can land on a relative (Scaly-naped Pigeon
 * found White-crowned Pigeon's page), and a wrong photo is worse than none.
 */
const titled = (summary, comName) => {
  const title = plain(summary.title)
  const name = plain(comName)
  return Boolean(name) && (title === name || title.endsWith(` ${name}`))
}

const namesBird = (summary, { comName, sciName }, taxonNames = []) => {
  if (!summary || summary.type === 'disambiguation') return false
  if (titled(summary, comName)) return true
  return Boolean(sciName) && taxonNames.some((name) => plain(name) === plain(sciName))
}

const WIKIDATA_URL = 'https://www.wikidata.org/w/api.php'

/** The scientific names Wikidata gives an article's subject (property P225, taxon name). */
const taxonNamesOf = async (item) => {
  if (!item) return []
  const url = new URL(WIKIDATA_URL)
  url.search = new URLSearchParams({ action: 'wbgetclaims', format: 'json', property: 'P225', entity: item })
  const res = await fetch(url, wikiHeaders)
  if (!res.ok) { console.error(`Wikidata ${res.status} for ${item}`); return [] }
  return ((await res.json()).claims?.P225 || []).map((claim) => claim.mainsnak?.datavalue?.value).filter(Boolean)
}

const readSummary = async (page) => {
  const res = await fetch(`${WIKI_SUMMARY_URL}/${encodeURIComponent(page.key)}`, wikiHeaders)
  if (!res.ok) { console.error(`Wikipedia summary ${res.status} for ${page.key}`); return null }
  return res.json()
}

// Wikipedia: the bird's article and its lead photo, the one picture editors chose for the species.
// The scientific name is searched first ("Aythya americana" finds the duck; "Redhead" finds hair
// colour), then the common name; a page counts only if it is about the bird (namesBird).
// Best-effort decoration: a failure yields nulls, never an error.
const fetchWiki = async ({ comName, sciName }) => {
  const none = { wikiURL: null, wikiImage: null }
  try {
    for (const term of [sciName, comName].filter(Boolean)) {
      const page = await searchWikiPage(term)
      if (!page?.id) continue
      const summary = await readSummary(page)
      if (!summary) continue
      const taxa = titled(summary, comName) ? [] : await taxonNamesOf(summary.wikibase_item)
      if (!namesBird(summary, { comName, sciName }, taxa)) continue
      const thumb = summary.thumbnail?.source
      // Use the thumbnail exactly as served (about 330px wide, enough for a 200px card). Asking for a
      // larger size than the original image is rejected, and the utm tracking params are just noise.
      return { wikiURL: `https://en.wikipedia.org/?curid=${page.id}`, wikiImage: thumb ? thumb.split('?')[0] : null }
    }
    return none
  } catch (error) {
    console.error(`Wikipedia lookup failed for ${comName}:`, error.message)
    return none
  }
}

/** A bird's picture: its Wikipedia article's lead photo. */
const lookupImage = async (bird) => (isSpecies(bird) ? (await fetchWiki(bird)).wikiImage : null)

// Only true species have articles and photos; hybrids, spuhs and slashes would match random pages.
const isSpecies = (taxon) => taxon.category === 'species'

const buildBird = async (taxon) => {
  const wiki = isSpecies(taxon) ? await fetchWiki(taxon) : { wikiURL: null, wikiImage: null }
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
    birdImg: wiki.wikiImage,
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

module.exports = { findOrCreateBirds, lookupImage, fetchWiki, isSpecies, namesBird }
