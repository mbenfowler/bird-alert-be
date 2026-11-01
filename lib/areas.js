const db = require('./db')
const ebird = require('./ebird')
const { HttpError } = require('./http')
const { keptState, subnational1, stateOfRegion, countyWord, countryOf } = require('./regions')
const placeSearch = require('./placeSearch')

/**
 * Finding where someone birds, anywhere eBird covers. The lists of countries, provinces and their
 * county-level areas come from eBird and are kept a month (they barely change), so a country nobody
 * has picked before works with no change to the app. A point (the phone's location, or a town found
 * by name) becomes an area by the hotspots eBird has near it, which carry their county; the point
 * itself is never kept, only the area it falls in, and only in memory.
 */
const LIST_TTL_DAYS = 30
const NEAR_KM = [5, 15, 50] // eBird's distance searches stop at 50 km
const POINTS_KEPT = 500

const cached = async (key, ttlDays, load) => {
  const row = await db('nearby_cache').where({ key }).first()
  const value = row && (typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail)
  if (row && Date.now() - new Date(row.fetched_at).getTime() < ttlDays * 86400000) return value
  try {
    const fresh = await load()
    await db('nearby_cache').insert({ key, detail: JSON.stringify(fresh) }).onConflict('key').merge({ detail: JSON.stringify(fresh), fetched_at: db.fn.now() })
    return fresh
  } catch (error) {
    // A stale list still answers.
    if (row) return value
    throw error
  }
}

/** Every country eBird covers: [{ code, name }]. */
const countries = () => cached('areas:countries', LIST_TTL_DAYS, async () =>
  (await ebird.countries()).map((c) => ({ code: c.code, name: c.name })))

/** A country's provinces, each with the code the app keeps for it ('GA', 'ON', 'GB-ENG'). Empty where eBird has none. */
const provincesOf = (country) => cached(`areas:provinces:${country}`, LIST_TTL_DAYS, async () =>
  (await ebird.provinces(country)).map((p) => ({ code: keptState(p.code), region: p.code, name: p.name })))

/**
 * A province's county-level areas: eBird's subnational2 regions, or, where it has none, the province
 * itself as the one area ('whole').
 */
const areasOf = async (state) => {
  const code = subnational1(state)
  const list = await cached(`areas:counties:${code}`, LIST_TTL_DAYS, async () => (await ebird.subregions(state)).map((r) => ({ code: r.code, name: r.name })))
  if (list.length) return list
  const province = (await provincesOf(code.slice(0, 2))).find((p) => p.region === code)
  return [{ code, name: province?.name || code, whole: true }]
}

/** What the app shows for an area: its code, kept state, country, name and full label from eBird. */
const describe = async (location) => {
  const state = stateOfRegion(location)
  if (!state) return null
  const info = await cached(`areas:info:${location}`, LIST_TTL_DAYS * 3, () => ebird.regionInfo(location))
  const label = String(info?.result || location)
  return { location, state, country: countryOf(state), name: label.split(',')[0].trim(), label, countyWord: countyWord(state) }
}

// Points already placed, by their rounding to about a kilometre: in this instance's memory only.
const placed = new Map()

/** The area a point falls in, from the nearest eBird hotspot; null when none is within 50 km. */
const areaAt = async (lat, lng) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'A point needs a latitude and longitude')
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`
  if (placed.has(key)) return placed.get(key)
  let near = []
  for (const km of NEAR_KM) {
    near = await ebird.hotspotsNear(lat, lng, km)
    if (Array.isArray(near) && near.length) break
  }
  const nearest = (near || [])
    .filter((h) => h.subnational1Code)
    .map((h) => ({ h, d: (h.lat - lat) ** 2 + ((h.lng - lng) * Math.cos((lat * Math.PI) / 180)) ** 2 }))
    .sort((a, b) => a.d - b.d)[0]?.h
  const area = nearest ? await describe(nearest.subnational2Code || nearest.subnational1Code) : null
  if (placed.size >= POINTS_KEPT) placed.delete(placed.keys().next().value)
  placed.set(key, area)
  return area
}

/** Areas for a town, address or county typed by name, anywhere: each with the place it was found by. */
const areaSearch = async (q) => {
  if (String(q || '').length > 120) throw new HttpError(400, 'Search is too long')
  const found = await placeSearch.searchAddresses(q, { countries: null })
  const areas = await Promise.all(found.map(async (p) => {
    try { const area = await areaAt(p.lat, p.lng); return area && { ...area, place: p.name } } catch { return null }
  }))
  const seen = new Set()
  return areas.filter((a) => a && !seen.has(a.location) && seen.add(a.location))
}

/**
 * The check before an area is saved: the county must sit in the state it's saved with. Then, when
 * eBird's list can be read, the county must be on it; if it can't, the shape is trusted.
 */
const assertArea = async (state, location) => {
  if (stateOfRegion(location) !== String(state || '').toUpperCase()) throw new HttpError(400, 'That area is not in that state or province')
  if (!process.env.EBIRD_API_KEY) return
  let list
  try { list = await areasOf(state) } catch { return }
  if (!list.some((a) => a.code === location)) throw new HttpError(400, 'eBird has no such area')
}

module.exports = { countries, provincesOf, areasOf, describe, areaAt, areaSearch, assertArea }
