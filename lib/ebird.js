const { HttpError } = require('./http')

const BASE = 'https://api.ebird.org/v2'

// eBird identifiers are short and alphanumeric; reject anything else before it reaches a URL.
const REGION = /^[A-Z]{2}(-[A-Z0-9]{1,5}){0,2}$/i
const SPECIES = /^[a-z0-9]{3,12}$/i
const STATE = /^[A-Z]{2}$/i
const SUB_ID = /^S\d{5,12}$/

const assert = (pattern, value, label) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new HttpError(400, `Invalid ${label}`)
  return value
}

const RETRY_AFTER_MS = 1500

const ebirdFetch = async (path, params = {}, attempt = 1) => {
  const url = new URL(`${BASE}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const res = await fetch(url, { headers: { 'X-eBirdApiToken': process.env.EBIRD_API_KEY } })
  // Throttled: one more try after a breath, since a single 429 is usually a burst elsewhere.
  if (res.status === 429 && attempt === 1) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS))
    return ebirdFetch(path, params, 2)
  }
  if (!res.ok) {
    console.error(`eBird ${res.status} for ${url.pathname}`)
    const error = new HttpError(res.status === 404 ? 404 : 502, `eBird responded with ${res.status}`)
    // Callers that pace themselves (the history backfill) need to know a 429 from any other failure.
    error.upstream = res.status
    throw error
  }
  return res.json()
}

const enc = encodeURIComponent

module.exports = {
  assertRegion: (value) => assert(REGION, value, 'region'),
  assertSpecies: (value) => assert(SPECIES, value, 'species code'),
  assertState: (value) => assert(STATE, value, 'state'),
  assertSubId: (value) => assert(SUB_ID, value, 'checklist id'),

  speciesList: (region) => ebirdFetch(`/product/spplist/${enc(region)}`),
  recentObservations: (region, back) => ebirdFetch(`/data/obs/${enc(region)}/recent`, back ? { back } : {}),
  notableObservations: (region, back = 30) => ebirdFetch(`/data/obs/${enc(region)}/recent/notable`, { back }),
  speciesObservations: (region, code, back = 30) => ebirdFetch(`/data/obs/${enc(region)}/recent/${enc(code)}`, { back }),
  /** Every species reported in the region on one day ('YYYY-MM-DD'), one record each. */
  historicObservations: (region, day) => {
    const [y, m, d] = String(day).split('-').map(Number)
    if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) throw new HttpError(400, 'Invalid day')
    return ebirdFetch(`/data/obs/${enc(region)}/historic/${y}/${m}/${d}`, { rank: 'mrec' })
  },
  subregions: (state) => ebirdFetch(`/ref/region/list/subnational2/US-${enc(state.toUpperCase())}`),
  /** The newest checklists in the region (up to 200): who birded where, when, and how many species. */
  recentChecklists: (region, maxResults = 200) => ebirdFetch(`/product/lists/${enc(region)}`, { maxResults }),
  /** One checklist in full: every species with its count, the observer's note and media counts. */
  checklistView: (subId) => ebirdFetch(`/product/checklist/view/${enc(subId)}`),
  taxonomy: (codes) => ebirdFetch('/ref/taxonomy/ebird', { species: codes.join(','), fmt: 'json' })
}
