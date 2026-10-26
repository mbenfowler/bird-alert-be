const db = require('./db')

/**
 * Driving routes from OSRM's public server (OpenStreetMap roads, free, fair use). Miles as the
 * crow flies mislead around a lake; the road and its minutes do not. Every point list is asked for
 * once a month and kept; a failure answers null, and the page falls back to a straight line.
 */
const BASE = 'https://router.project-osrm.org/route/v1/driving/'
const TTL_DAYS = 30
const TIMEOUT_MS = 6000
const USER_AGENT = 'bird-alert (https://github.com/mbenfowler/bird-alert)'
const MAX_GEOMETRY_POINTS = 400

const keyFor = (points) => points.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|')

/** Thin a polyline to at most `max` points, keeping its ends. */
const thin = (coords, max = MAX_GEOMETRY_POINTS) => {
  if (coords.length <= max) return coords
  const step = (coords.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => coords[Math.round(i * step)])
}

const fetchRoute = async (points) => {
  const path = points.map((p) => `${p.lng},${p.lat}`).join(';')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}${path}?overview=simplified&geometries=geojson&steps=false`, { headers: { 'User-Agent': USER_AGENT }, signal: ctl.signal })
    if (!res.ok) throw new Error(`OSRM ${res.status}`)
    const data = await res.json()
    const route = data.code === 'Ok' && data.routes && data.routes[0]
    if (!route) throw new Error(`OSRM ${data.code || 'no route'}`)
    return {
      minutes: Math.round(route.duration / 60),
      miles: Math.round((route.distance / 1609.344) * 10) / 10,
      legs: (route.legs || []).map((leg) => ({ minutes: Math.round(leg.duration / 60), miles: Math.round((leg.distance / 1609.344) * 10) / 10 })),
      // Leaflet wants [lat, lng]; GeoJSON gives [lng, lat].
      geometry: thin(route.geometry.coordinates.map(([lng, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]))
    }
  } finally { clearTimeout(timer) }
}

/** The drive through `points` (two or more), from the cache or OSRM; null when it cannot be had. */
const drive = async (points) => {
  const valid = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
  if (valid.length < 2) return null
  const key = keyFor(valid)
  const cached = await db('drive_cache').where({ key }).first()
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < TTL_DAYS * 86400000) return cached.detail
  try {
    const detail = await fetchRoute(valid)
    await db('drive_cache').insert({ key, detail }).onConflict('key').merge({ detail, fetched_at: db.fn.now() })
    return detail
  } catch (error) {
    console.error(`Drive ${key}:`, error.message)
    return cached ? cached.detail : null
  }
}

/** Drives from one origin to each target, a few at a time so OSRM is not hit with a burst. */
const drivesFrom = async (origin, targets, { concurrency = 3 } = {}) => {
  const out = new Array(targets.length).fill(null)
  let next = 0
  const worker = async () => {
    while (next < targets.length) {
      const i = next++
      out[i] = await drive([origin, targets[i]])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker))
  return out
}

module.exports = { drive, drivesFrom, thin, keyFor }
