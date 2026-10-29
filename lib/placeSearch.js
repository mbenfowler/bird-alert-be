const db = require('./db')
const ebird = require('./ebird')
const { HttpError } = require('./http')

/**
 * Finding a stop or a starting point by name. Hotspots come from our own copy of the state's eBird
 * hotspot list (one eBird call a week per state), so typing can search as it goes. Addresses and
 * towns come from OpenStreetMap's Nominatim, which allows no search-as-you-type: it is asked only
 * when the person submits, and each query is kept for a month.
 */
const REFRESH_DAYS = 7
const ADDRESS_TTL_DAYS = 30
const MAX_HOTSPOTS = 8
const MAX_ADDRESSES = 5
const USER_AGENT = 'bird-alert (https://github.com/mbenfowler/bird-alert)'

const refreshing = new Map()

/** Make sure the state's hotspots are on hand and no more than a week old. */
const ensureHotspots = async (state) => {
  const row = await db('hotspot_ref').where({ state }).max('fetched_at as at').first()
  if (row?.at && Date.now() - new Date(row.at).getTime() < REFRESH_DAYS * 86400000) return
  if (!refreshing.has(state)) {
    refreshing.set(state, (async () => {
      const started = new Date()
      const list = await ebird.stateHotspots(state)
      const rows = list.filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lng) && h.locId && h.locName).map((h) => ({
        loc_id: h.locId,
        state,
        county: h.subnational2Code || null,
        name: h.locName,
        lat: h.lat,
        lng: h.lng,
        species: h.numSpeciesAllTime ?? null,
        checklists: h.numChecklistsAllTime ?? null,
        latest: h.latestObsDt ? String(h.latestObsDt).slice(0, 10) : null,
        fetched_at: started
      }))
      for (let i = 0; i < rows.length; i += 500) await db('hotspot_ref').insert(rows.slice(i, i + 500)).onConflict('loc_id').merge()
      // Hotspots eBird has since merged or removed.
      if (rows.length) await db('hotspot_ref').where({ state }).andWhere('fetched_at', '<', started).del()
    })().finally(() => refreshing.delete(state)))
  }
  try { await refreshing.get(state) } catch (error) {
    // A stale list still answers; only an empty one has nothing to say.
    console.error(`Hotspots for ${state}:`, error.message)
    if (!row?.at) throw new HttpError(502, 'Could not load hotspots')
  }
}

const words = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(' ').filter(Boolean).slice(0, 6)

/** Hotspots in `state` whose names hold every word typed; the most-birded first, names that start with the query before others. */
const searchHotspots = async (state, q) => {
  const terms = words(q)
  if (!terms.length) return []
  await ensureHotspots(state)
  let query = db('hotspot_ref').where({ state })
  for (const term of terms) query = query.andWhereRaw('name ilike ?', [`%${term.replace(/[\\%_]/g, '\\$&')}%`])
  const rows = await query
    .orderByRaw('case when name ilike ? then 0 else 1 end', [`${terms[0]}%`])
    .orderByRaw('checklists desc nulls last')
    .limit(MAX_HOTSPOTS)
    .select('loc_id', 'name', 'county', 'lat', 'lng', 'species', 'checklists', 'latest')
  return rows.map((r) => ({ kind: 'hotspot', locId: r.loc_id, name: r.name, county: r.county, lat: r.lat, lng: r.lng, species: r.species, checklists: r.checklists, latest: r.latest ? new Date(r.latest).toISOString().slice(0, 10) : null }))
}

/** A short label from Nominatim's long one: the first parts, without the county, state and country. */
const shortLabel = (display) => String(display || '').split(',').map((s) => s.trim()).filter((s) => s && !/county$/i.test(s) && !/^\d{5}(-\d{4})?$/.test(s) && !/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/i.test(s) && !['United States', 'Canada', 'México', 'Mexico'].includes(s)).slice(0, 3).join(', ')

const searchAddresses = async (q) => {
  const text = String(q || '').trim().replace(/\s+/g, ' ')
  if (text.length < 3) return []
  const key = `search:${text.toLowerCase()}`
  const cached = await db('nearby_cache').where({ key }).first()
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < ADDRESS_TTL_DAYS * 86400000) return cached.detail
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('q', text)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', String(MAX_ADDRESSES))
  url.searchParams.set('countrycodes', 'us,ca,mx')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 6000)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: ctl.signal })
    if (!res.ok) throw new Error(`Nominatim ${res.status}`)
    const detail = (await res.json()).map((r) => ({ kind: 'address', name: shortLabel(r.display_name) || r.name, lat: Number(r.lat), lng: Number(r.lon) }))
      .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lng))
    await db('nearby_cache').insert({ key, detail: JSON.stringify(detail) }).onConflict('key').merge({ detail: JSON.stringify(detail), fetched_at: db.fn.now() })
    return detail
  } catch (error) {
    console.error(`Address search:`, error.message)
    return cached ? cached.detail : []
  } finally { clearTimeout(timer) }
}

/** Hotspots by name, and (when asked) addresses and towns. */
const placeSearch = async ({ state, q, addresses = false }) => {
  if (String(q || '').length > 120) throw new HttpError(400, 'Search is too long')
  const [hotspots, places] = await Promise.all([searchHotspots(state, q), addresses ? searchAddresses(q) : []])
  return { hotspots, addresses: places }
}

/** Points written `lat,lng;lat,lng`, two to ten of them. */
const parsePoints = (value) => {
  const points = String(value || '').split(';').filter(Boolean).map((pair) => {
    const [lat, lng] = pair.split(',').map(Number)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'Invalid point')
    return { lat, lng }
  })
  if (points.length < 2 || points.length > 10) throw new HttpError(400, 'Between 2 and 10 points')
  return points
}

module.exports = { placeSearch, searchHotspots, shortLabel, parsePoints, words }
