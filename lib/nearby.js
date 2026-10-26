const db = require('./db')
const { HttpError } = require('./http')
const { metresBetween } = require('./hotspots')

/**
 * Public land near a point, for when the best place for a bird is someone's yard: eBird's own
 * hotspots nearby, with how much they have been birded (a park with five checklists all time is
 * a sneaky pick), and named parks from OpenStreetMap that eBird does not list. Looked up once a
 * month per point; a source that fails just contributes nothing.
 */
const HOTSPOT_KM = 10
const PARK_DEG = 0.045 // about 5 km of latitude
const TTL_DAYS = 30
const LIGHTLY_BIRDED = 10
const USER_AGENT = 'bird-alert (https://github.com/mbenfowler/bird-alert)'

const miles = (m) => Math.round((m / 1609.344) * 10) / 10
const keyFor = (lat, lng) => `${lat.toFixed(3)},${lng.toFixed(3)}`
const normalize = (name) => String(name || '').toLowerCase().replace(/^lake lanier--/, '').replace(/[^a-z0-9]+/g, ' ').trim()

const fetchHotspots = async (lat, lng) => {
  const url = `https://api.ebird.org/v2/ref/hotspot/geo?lat=${lat}&lng=${lng}&dist=${HOTSPOT_KM}&fmt=json`
  const res = await fetch(url, { headers: { 'X-eBirdApiToken': process.env.EBIRD_API_KEY } })
  if (!res.ok) throw new Error(`eBird hotspots ${res.status}`)
  return (await res.json()).map((h) => ({
    locId: h.locId,
    name: h.locName,
    lat: h.lat,
    lng: h.lng,
    miles: miles(metresBetween({ lat, lng }, { lat: h.lat, lng: h.lng })),
    checklists: h.numChecklistsAllTime ?? null,
    species: h.numSpeciesAllTime ?? null,
    latest: h.latestObsDt ? String(h.latestObsDt).slice(0, 10) : null,
    lightlyBirded: (h.numChecklistsAllTime ?? 0) < LIGHTLY_BIRDED
  })).sort((a, b) => a.miles - b.miles)
}

const fetchParks = async (lat, lng) => {
  const box = [lng - PARK_DEG, lat + PARK_DEG, lng + PARK_DEG, lat - PARK_DEG].join(',')
  const url = `https://nominatim.openstreetmap.org/search?q=park&format=jsonv2&limit=15&bounded=1&viewbox=${box}`
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 6000)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: ctl.signal })
    if (!res.ok) throw new Error(`Nominatim ${res.status}`)
    return (await res.json())
      .filter((r) => (r.category === 'leisure' || r.class === 'leisure') && (r.name || r.display_name))
      .map((r) => ({ name: r.name || String(r.display_name).split(',')[0], lat: Number(r.lat), lng: Number(r.lon), miles: miles(metresBetween({ lat, lng }, { lat: Number(r.lat), lng: Number(r.lon) })), type: r.type }))
      .sort((a, b) => a.miles - b.miles)
  } finally { clearTimeout(timer) }
}

/** Nearby public land, from the cache or the sources. Hotspots and parks that are the same place appear once. */
const nearbyPublic = async (lat, lng) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'lat and lng are required')
  const key = keyFor(lat, lng)
  const cached = await db('nearby_cache').where({ key }).first()
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < TTL_DAYS * 86400000) return cached.detail
  const [hotspots, parks] = await Promise.all([
    fetchHotspots(lat, lng).catch((error) => { console.error(`Hotspots near ${key}:`, error.message); return [] }),
    fetchParks(lat, lng).catch((error) => { console.error(`Parks near ${key}:`, error.message); return [] })
  ])
  const known = new Set(hotspots.map((h) => normalize(h.name)))
  const detail = {
    hotspots: hotspots.slice(0, 5),
    parks: parks.filter((p) => !known.has(normalize(p.name)) && !hotspots.some((h) => metresBetween(h, p) < 300)).slice(0, 5),
    fetchedAt: new Date().toISOString()
  }
  if (hotspots.length || parks.length) await db('nearby_cache').insert({ key, detail }).onConflict('key').merge({ detail, fetched_at: db.fn.now() })
  return detail
}

module.exports = { nearbyPublic, normalize, LIGHTLY_BIRDED }
