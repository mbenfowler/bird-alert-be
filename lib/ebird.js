const { HttpError } = require('./http')

const BASE = 'https://api.ebird.org/v2'

// eBird identifiers are short and alphanumeric; reject anything else before it reaches a URL.
const REGION = /^[A-Z]{2}(-[A-Z0-9]{1,5}){0,2}$/i
const SPECIES = /^[a-z0-9]{3,12}$/i
const STATE = /^[A-Z]{2}$/i

const assert = (pattern, value, label) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new HttpError(400, `Invalid ${label}`)
  return value
}

const ebirdFetch = async (path, params = {}) => {
  const url = new URL(`${BASE}${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const res = await fetch(url, { headers: { 'X-eBirdApiToken': process.env.EBIRD_API_KEY } })
  if (!res.ok) {
    console.error(`eBird ${res.status} for ${url.pathname}`)
    throw new HttpError(res.status === 404 ? 404 : 502, `eBird responded with ${res.status}`)
  }
  return res.json()
}

const enc = encodeURIComponent

module.exports = {
  assertRegion: (value) => assert(REGION, value, 'region'),
  assertSpecies: (value) => assert(SPECIES, value, 'species code'),
  assertState: (value) => assert(STATE, value, 'state'),

  speciesList: (region) => ebirdFetch(`/product/spplist/${enc(region)}`),
  recentObservations: (region, back) => ebirdFetch(`/data/obs/${enc(region)}/recent`, back ? { back } : {}),
  notableObservations: (region, back = 30) => ebirdFetch(`/data/obs/${enc(region)}/recent/notable`, { back }),
  speciesObservations: (region, code, back = 30) => ebirdFetch(`/data/obs/${enc(region)}/recent/${enc(code)}`, { back }),
  subregions: (state) => ebirdFetch(`/ref/region/list/subnational2/US-${enc(state.toUpperCase())}`),
  taxonomy: (codes) => ebirdFetch('/ref/taxonomy/ebird', { species: codes.join(','), fmt: 'json' })
}
