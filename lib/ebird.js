const { HttpError } = require('./http')
const { subnational1 } = require('./regions')

const BASE = 'https://api.ebird.org/v2'

// eBird identifiers are short and alphanumeric; reject anything else before it reaches a URL.
const REGION = /^[A-Z]{2}(-[A-Z0-9]{1,5}){0,2}$/i
const SPECIES = /^[a-z0-9]{3,12}$/i
// A kept state code: bare for the US, Canada and Mexico ('GA', 'ON', 'JAL'), or any other country's
// province with its country ('ZA-WC', 'GB-ENG', 'JP-23').
const STATE = /^(?:[A-Z]{2,3}|[A-Z]{2}-[A-Z0-9]{1,3})$/i
const SUB_ID = /^S\d{5,12}$/

const assert = (pattern, value, label) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new HttpError(400, `Invalid ${label}`)
  return value
}

const RETRY_AFTER_MS = 1500

// An answer that never comes: the background jobs pass a time limit (eBird can hang for a minute
// in the small hours), and a call past it fails like an upstream error rather than holding the job.
const timedOut = (pathname) => {
  console.error(`eBird timed out for ${pathname}`)
  const error = new HttpError(504, 'eBird took too long to answer')
  error.upstream = 'timeout'
  return error
}

const ebirdFetch = async (path, params = {}, { attempt = 1, timeoutMs = null, until = timeoutMs ? Date.now() + timeoutMs : null } = {}) => {
  const url = new URL(`${BASE}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const signal = until ? AbortSignal.timeout(Math.max(1, until - Date.now())) : undefined
  try {
    const res = await fetch(url, { headers: { 'X-eBirdApiToken': process.env.EBIRD_API_KEY }, ...(signal ? { signal } : {}) })
    // Throttled: one more try after a breath, since a single 429 is usually a burst elsewhere.
    if (res.status === 429 && attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS))
      if (until && Date.now() >= until) throw timedOut(url.pathname)
      return ebirdFetch(path, params, { attempt: 2, until })
    }
    if (!res.ok) {
      console.error(`eBird ${res.status} for ${url.pathname}`)
      // Still throttled after the retry: a 503 in plain words, which the app retries for a while on its own.
      const error = res.status === 429
        ? new HttpError(503, 'eBird is busy right now. Trying again in a moment.')
        : new HttpError(res.status === 404 ? 404 : 502, `eBird responded with ${res.status}`)
      // Callers that pace themselves (the history backfill) need to know a 429 from any other failure.
      error.upstream = res.status
      throw error
    }
    return await res.json()
  } catch (error) {
    if (signal?.aborted && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw timedOut(url.pathname)
    throw error
  }
}

const enc = encodeURIComponent

// eBird's limit on one notable answer; and how many state calls run at once when a country's is full.
const NOTABLE_CAP = 10_000
const STATE_PARALLEL = 6

module.exports = {
  assertRegion: (value) => assert(REGION, value, 'region'),
  assertSpecies: (value) => assert(SPECIES, value, 'species code'),
  assertState: (value) => assert(STATE, value, 'state'),
  assertSubId: (value) => assert(SUB_ID, value, 'checklist id'),

  speciesList: (region) => ebirdFetch(`/product/spplist/${enc(region)}`),
  recentObservations: (region, back, { detail } = {}) => ebirdFetch(`/data/obs/${enc(region)}/recent`, { ...(back ? { back } : {}), ...(detail ? { detail } : {}) }),
  /** A region's name, bounds and center ({ latitude, longitude }). */
  regionInfo: (region) => ebirdFetch(`/ref/region/info/${enc(region)}`),
  // The lists of places eBird keeps: every country, a country's provinces, and hotspots near a point.
  countries: () => ebirdFetch('/ref/region/list/country/world'),
  provinces: (country) => ebirdFetch(`/ref/region/list/subnational1/${enc(country)}`),
  hotspotsNear: (lat, lng, dist) => ebirdFetch('/ref/hotspot/geo', { lat, lng, dist, fmt: 'json' }),
  /** Notable reports within dist km (eBird allows up to 50) of a point, with county and observer. */
  geoNotable: (lat, lng, dist, back = 1) => ebirdFetch('/data/obs/geo/recent/notable', { lat, lng, dist, back, detail: 'full' }),
  /** Every species reported within dist km of a point, newest report of each. */
  geoRecent: (lat, lng, dist, back = 1) => ebirdFetch('/data/obs/geo/recent', { lat, lng, dist, back }),
  /** One species' reports within dist km of a point: the newest at each location. */
  geoSpecies: (lat, lng, dist, code, back = 1) => ebirdFetch(`/data/obs/geo/recent/${enc(code)}`, { lat, lng, dist, back }),
  /**
   * A country's notable reports ('US', 'CA', 'MX', 'ZA'), with the observer and review detail.
   * eBird returns at most NOTABLE_CAP of them, the newest: two days of the US runs past that and the
   * oldest reports (often the ones submitted late, like a rarity seen at dusk and logged the next
   * day) were silently cut. A full answer is asked again state by state, which is never capped.
   */
  countryNotable: async (country, back = 2) => {
    const all = await ebirdFetch(`/data/obs/${enc(country)}/recent/notable`, { back, detail: 'full' })
    if (!Array.isArray(all) || all.length < NOTABLE_CAP) return all
    const states = await module.exports.provinces(country)
    const parts = []
    for (let i = 0; i < states.length; i += STATE_PARALLEL) {
      const batch = await Promise.all(states.slice(i, i + STATE_PARALLEL).map((st) =>
        ebirdFetch(`/data/obs/${enc(st.code)}/recent/notable`, { back, detail: 'full' })))
      parts.push(...batch.flat())
    }
    return parts
  },
  /** A region's notable reports, every one of them, with review status, media and observer (the evidence behind each). */
  notableObservations: (region, back = 30, { timeoutMs } = {}) => ebirdFetch(`/data/obs/${enc(region)}/recent/notable`, { back, detail: 'full' }, { timeoutMs }),
  // `provisional` asks for reports still awaiting review too, which eBird leaves out by default.
  speciesObservations: (region, code, back = 30, { detail, provisional } = {}) =>
    ebirdFetch(`/data/obs/${enc(region)}/recent/${enc(code)}`, { back, ...(detail ? { detail } : {}), ...(provisional ? { includeProvisional: 'true' } : {}) }),
  /** Every species reported in the region on one day ('YYYY-MM-DD'), one record each. */
  historicObservations: (region, day) => {
    const [y, m, d] = String(day).split('-').map(Number)
    if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) throw new HttpError(400, 'Invalid day')
    return ebirdFetch(`/data/obs/${enc(region)}/historic/${y}/${m}/${d}`, { rank: 'mrec' })
  },
  /** One hotspot's details (its county among them); personal locations answer 404. */
  hotspotInfo: (locId) => ebirdFetch(`/ref/hotspot/info/${enc(locId)}`, { fmt: 'json' }),
  stateHotspots: (state) => ebirdFetch(`/ref/hotspot/${enc(subnational1(state))}`, { fmt: 'json' }),
  subregions: (state) => ebirdFetch(`/ref/region/list/subnational2/${enc(subnational1(state))}`),
  /** The newest checklists in the region (up to 200): who birded where, when, and how many species. */
  recentChecklists: (region, maxResults = 200, { timeoutMs } = {}) => ebirdFetch(`/product/lists/${enc(region)}`, { maxResults }, { timeoutMs }),
  /** One checklist in full: every species with its count, the observer's note and media counts. */
  checklistView: (subId, { timeoutMs } = {}) => ebirdFetch(`/product/checklist/view/${enc(subId)}`, {}, { timeoutMs }),
  fullTaxonomy: (locale) => ebirdFetch('/ref/taxonomy/ebird', locale && locale !== 'en' ? { fmt: 'json', locale } : { fmt: 'json' }),
  taxonomy: (codes) => ebirdFetch('/ref/taxonomy/ebird', { species: codes.join(','), fmt: 'json' })
}
