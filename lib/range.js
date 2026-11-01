const db = require('./db')
const ebird = require('./ebird')
const { metresBetween } = require('./hotspots')
const { withEvidence, withoutEscapees } = require('./evidence')
const { stateOfRegion, subnational1 } = require('./regions')

/**
 * The alert range: watch-list, rare-bird and lifer alerts reach past a person's county to everything
 * within range_mi of their home spot, so a bird one county over (somewhere they could still go) or
 * one moving their way reaches them; or to their whole state or province (RANGE_WHOLE_STATE).
 */
const RANGE_WHOLE_STATE = -1
const RANGE_CHOICES = [0, 15, 30, RANGE_WHOLE_STATE]
const MAX_KM = 50 // eBird's distance searches stop at 50 km
const MILE_KM = 1.609344

const wholeState = (user) => Number(user.range_mi) === RANGE_WHOLE_STATE
/** Whether alerts reach past the county at all. */
const reachesPast = (user) => wholeState(user) || Number(user.range_mi) > 0
/** The distance searched around home; none for the whole state, which is asked for by region. */
const rangeKm = (user) => (Number(user.range_mi) > 0 ? Math.min(MAX_KM, Math.round(Number(user.range_mi) * MILE_KM)) : 0)
/** eBird's code for the state or province a county sits in ('US-GA-139' -> 'US-GA'). */
const stateCodeOf = (region) => {
  const state = stateOfRegion(region)
  return state ? subnational1(state) : null
}

/** A county's center, from eBird once and from the cache after. */
const regionCenter = async (region) => {
  const key = `center:${region}`
  const cached = await db('nearby_cache').where({ key }).first()
  if (cached) return typeof cached.detail === 'string' ? JSON.parse(cached.detail) : cached.detail
  const info = await ebird.regionInfo(region)
  const b = info.bounds || {}
  const center = Number.isFinite(info.latitude) && info.latitude !== 0
    ? { lat: info.latitude, lng: info.longitude }
    : { lat: (b.minY + b.maxY) / 2, lng: (b.minX + b.maxX) / 2 }
  if (!Number.isFinite(center.lat) || !Number.isFinite(center.lng)) return null
  await db('nearby_cache').insert({ key, detail: JSON.stringify(center) }).onConflict('key').merge({ detail: JSON.stringify(center), fetched_at: db.fn.now() })
  return center
}

/** Where a person's range is measured from: their own spot, or their county's center. */
const homeOf = async (user) => (Number.isFinite(user.home_lat) && Number.isFinite(user.home_lng)
  ? { lat: user.home_lat, lng: user.home_lng }
  : regionCenter(user.location))

const miles = (a, b) => Math.round(metresBetween(a, b) / 1609.344)

/**
 * One run's eBird lookups for ranges, shared: people whose ranges match (same spot to about a
 * kilometre, same distance) cost one call, which is everyone in a county who kept its center.
 */
const rangeFeeds = () => {
  const calls = new Map()
  const once = (key, fetch) => {
    if (!calls.has(key)) calls.set(key, fetch().catch((error) => { console.error(`Range feed ${key} failed:`, error.message); return [] }))
    return calls.get(key)
  }
  const keyOf = (home, km) => `${home.lat.toFixed(2)},${home.lng.toFixed(2)},${km}`
  // A whole state's reports, one call per state per run, each given the county it's in where that
  // can be found (eBird's state feed doesn't say), else the state's own name.
  const stateRecent = (state) => once(`sr:${state}`, async () => withCounties(await ebird.recentObservations(state, 1), state))
  return {
    /**
     * Notable reports in range but outside the county, each with how far and which county, and the
     * evidence behind it. Escapees eBird marks are left out, from the same area's recent feed (only
     * asked for when there are notable reports to check, and shared with lifer lookups).
     */
    notable: async (user, home) => {
      if (wholeState(user)) {
        const state = stateCodeOf(user.location)
        if (!state) return []
        const rows = await once(`sn:${state}`, async () => {
          const notable = await ebird.notableObservations(state, 1)
          if (!notable.length) return []
          return withoutEscapees(withEvidence(notable), await stateRecent(state))
        })
        return awayFrom(user, home, rows.filter((o) => o.subnational2Code !== user.location))
      }
      const km = rangeKm(user)
      if (!km || !home) return []
      const rows = await once(`n:${keyOf(home, km)}`, async () => {
        const notable = await ebird.geoNotable(home.lat, home.lng, km, 1)
        if (!notable.length) return []
        const recent = await once(`r:${keyOf(home, km)}`, () => ebird.geoRecent(home.lat, home.lng, km, 1))
        return withoutEscapees(withEvidence(notable), recent)
      })
      return awayFrom(user, home, rows.filter((o) => o.subnational2Code && o.subnational2Code !== user.location))
    },
    /** Every species reported in range; the caller keeps those the county feed lacks. */
    recent: async (user, home) => {
      if (wholeState(user)) {
        const state = stateCodeOf(user.location)
        if (!state) return []
        // A report with no county found may still be in the person's own; the caller keeps only
        // species the county feed lacks (beyondCounty), so the county's own birds never repeat.
        return awayFrom(user, home, (await stateRecent(state)).filter((o) => o.subnational2Code !== user.location))
      }
      const km = rangeKm(user)
      if (!km || !home) return []
      return awayFrom(user, home, await once(`r:${keyOf(home, km)}`, () => ebird.geoRecent(home.lat, home.lng, km, 1)))
    }
  }
}

/**
 * Reports from eBird's state feed, which names no county, given the county each is in where that's
 * known without asking eBird again: a hotspot's county from the hotspot list (for states whose
 * hotspots are on hand), named from the state's cached county list. Otherwise the place is said to be
 * in the state ("in Alberta"), or, failing that too, nothing more than its own name.
 */
const withCounties = async (rows, state) => {
  if (!rows.length) return rows
  const { areasOf, provincesOf } = require('./areas')
  const locIds = [...new Set(rows.map((o) => o.locId).filter(Boolean))]
  const [hotspots, counties, provinces] = await Promise.all([
    db('hotspot_ref').whereIn('loc_id', locIds).whereNotNull('county').select('loc_id', 'county').catch(() => []),
    areasOf(state).catch(() => []),
    provincesOf(state.slice(0, 2)).catch(() => [])
  ])
  const countyOf = new Map(hotspots.map((h) => [h.loc_id, h.county]))
  const nameOf = new Map(counties.filter((c) => !c.whole).map((c) => [c.code, c.name]))
  const stateName = provinces.find((p) => p.region === state)?.name || null
  return rows.map((o) => {
    if (o.subnational2Code) return o
    const code = countyOf.get(o.locId) || null
    const name = code ? nameOf.get(code) || null : null
    return { ...o, subnational2Code: code || undefined, subnational2Name: name || undefined, ...(name ? {} : { stateName }) }
  })
}

/** Marks each report with how far it is from home (when home is known) and its county, when eBird gives it. */
const awayFrom = (user, home, rows) => rows
  .filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lng))
  .map((o) => ({ ...o, away: { miles: home ? miles(home, o) : null, county: o.subnational2Name || o.stateName || null, region: o.subnational2Code || null } }))

/** Pure: the reports of species the county feed didn't bring, newest first per species, so range never repeats the county. */
const beyondCounty = (rangeRows, countyRows) => {
  const local = new Set(countyRows.map((o) => o.speciesCode))
  const seen = new Set()
  return rangeRows.filter((o) => !local.has(o.speciesCode) && !seen.has(o.speciesCode) && seen.add(o.speciesCode))
}

module.exports = { RANGE_CHOICES, RANGE_WHOLE_STATE, rangeKm, reachesPast, wholeState, stateCodeOf, regionCenter, homeOf, rangeFeeds, beyondCounty, awayFrom, MAX_KM }
