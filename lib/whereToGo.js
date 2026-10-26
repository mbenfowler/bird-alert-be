const db = require('./db')
const { whereToFindMany } = require('./hotspots')
const { today } = require('./seasonality')
const { drive } = require('./routing')
const { accuracy } = require('./grading')

/**
 * Where to go for a whole watch list. Each bird's ranked places are folded together per place:
 * a place's worth is the number of watch-list birds a visit can expect to turn up (the sum of the
 * chances), and a short route picks the stops that together give the most birds, counting a bird
 * only once however many stops might hold it.
 */
const MAX_SPECIES = 1000
const MAX_PLACES = 40
const MAX_STOPS = 3

/** Fold per-species rankings into one list of places, each with the birds it offers. */
const aggregatePlaces = (results, names = new Map()) => {
  const places = new Map()
  for (const result of results) {
    for (const p of result.places) {
      const place = places.get(p.locId) || { locId: p.locId, locName: p.locName, lat: p.lat, lng: p.lng, isHotspot: p.isHotspot ?? null, merged: p.merged || [], birds: [], own: [], windows: [] }
      place.locName = place.locName || p.locName
      if (place.lat === null && p.lat !== null) { place.lat = p.lat; place.lng = p.lng }
      if (place.isHotspot === null && typeof p.isHotspot === 'boolean') place.isHotspot = p.isHotspot
      place.birds.push({ speciesCode: result.speciesCode, comName: names.get(result.speciesCode) || result.speciesCode, chance: p.chance, band: p.band, lastSeen: p.lastSeen, note: p.notes && p.notes[0] ? p.notes[0] : null })
      // The place's own hours (from its timed reports) outrank the species' county-wide hours.
      if (p.bestTime?.label) place.own.push(p.bestTime.label)
      else if (result.bestTime?.source === 'reports') place.windows.push(result.bestTime.label)
      places.set(p.locId, place)
    }
  }
  const list = [...places.values()].map((place) => {
    place.birds.sort((a, b) => b.chance - a.chance)
    const vote = (list) => { const tally = new Map(); for (const w of list) tally.set(w, (tally.get(w) || 0) + 1); return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null }
    const bestTime = vote(place.own) || vote(place.windows)
    const expected = Math.round(place.birds.reduce((sum, b) => sum + b.chance / 100, 0) * 10) / 10
    const { own, windows, ...rest } = place
    return { ...rest, expected, bestTime, seenToday: place.birds.some((b) => b.lastSeen && b.lastSeen.daysAgo === 0) }
  })
  list.sort((a, b) => b.expected - a.expected || b.birds.length - a.birds.length)
  return list.slice(0, MAX_PLACES)
}

/** Kilometres between two points as the crow flies, times a typical road detour factor. */
const ROAD_FACTOR = 1.35
const roadKm = (a, b) => {
  const r = Math.PI / 180
  const dLat = (b.lat - a.lat) * r
  const dLng = (b.lng - a.lng) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h)) * ROAD_FACTOR
}

/** A bird of coverage is worth this many kilometres of driving between stops. */
const KM_PER_BIRD = 12
const CANDIDATES = 14

/** Birds expected to be seen at least once across a set of stops (each bird counted once). */
const coverage = (stops) => {
  const miss = new Map()
  for (const place of stops) for (const b of place.birds) miss.set(b.speciesCode, (miss.get(b.speciesCode) ?? 1) * (1 - b.chance / 100))
  return [...miss.values()].reduce((sum, m) => sum + (1 - m), 0)
}

const permutations = (items) => items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]))

/** Driving along the stops in order, from the starting point when there is one. */
const pathKm = (order, origin = null) => {
  const points = origin ? [origin, ...order] : order
  return points.slice(1).reduce((sum, p, i) => sum + roadKm(points[i], p), 0)
}

/** The visiting order of a set of stops with the least driving between them (and from the start). */
const bestOrder = (stops, origin = null) => permutations(stops).reduce((best, order) => {
  const km = pathKm(order, origin)
  return !best || km < best.km ? { order, km } : best
}, null)

/**
 * The route: of the strongest hotspots, every set of up to three stops is scored by the birds it
 * covers (each bird once, however many stops hold it) less the driving between them, so a stop
 * across the lake has to earn its detour; the chosen set is then visited in its shortest order.
 * Yards are never stops.
 */
const pickRoute = (places, { maxStops = MAX_STOPS, origin = null } = {}) => {
  const candidates = places.filter((p) => p.isHotspot !== false && p.lat !== null).sort((a, b) => b.expected - a.expected).slice(0, CANDIDATES)
  let best = null
  const consider = (set) => {
    const { order, km } = bestOrder(set, origin)
    const birds = coverage(set)
    const value = birds - km / KM_PER_BIRD
    if (!best || value > best.value + 1e-9) best = { order, km, birds, value }
  }
  const n = candidates.length
  for (let i = 0; i < n; i += 1) {
    consider([candidates[i]])
    if (maxStops < 2) continue
    for (let j = i + 1; j < n; j += 1) {
      consider([candidates[i], candidates[j]])
      if (maxStops < 3) continue
      for (let k = j + 1; k < n; k += 1) consider([candidates[i], candidates[j], candidates[k]])
    }
  }
  // A stop that adds almost nothing is not worth a stop at all.
  if (best && best.order.length > 1) {
    const trimmed = best.order.filter((p) => coverage(best.order) - coverage(best.order.filter((q) => q !== p)) >= 0.05)
    if (trimmed.length && trimmed.length < best.order.length) best = { ...best, order: bestOrder(trimmed, origin).order, birds: coverage(trimmed) }
  }
  const stops = best ? best.order : []
  return {
    stops: stops.map((p) => ({ locId: p.locId, locName: p.locName, lat: p.lat, lng: p.lng, expected: p.expected, bestTime: p.bestTime, birds: p.birds.slice(0, 6) })),
    covers: Math.round((best ? best.birds : 0) * 10) / 10,
    url: mapsRouteUrl(stops, origin)
  }
}

/** Google Maps directions through the stops (Apple Maps links take one destination only). */
const mapsRouteUrl = (stops, origin = null) => {
  if (!stops.length) return null
  const pt = (p) => `${p.lat},${p.lng}`
  const last = stops[stops.length - 1]
  const url = new URL('https://www.google.com/maps/dir/')
  url.searchParams.set('api', '1')
  // Without an origin, Maps starts from wherever the phone is.
  if (origin) url.searchParams.set('origin', pt(origin))
  url.searchParams.set('destination', pt(last))
  if (stops.length > 1) url.searchParams.set('waypoints', stops.slice(0, -1).map(pt).join('|'))
  url.searchParams.set('travelmode', 'driving')
  return url.toString()
}

const whereToGo = async (region, codes, { asOf = today(), origin = null } = {}) => {
  const wanted = [...new Set(codes)].slice(0, MAX_SPECIES)
  const results = await whereToFindMany(region, wanted, { asOf })
  const names = new Map(results.map((r) => [r.speciesCode, r.comName || r.speciesCode]))
  const places = aggregatePlaces(results, names)
  const route = pickRoute(places, { origin })
  // The drive through the stops (from the start, when given): legs with minutes, the total, and the road to draw on the map.
  const points = [...(origin ? [origin] : []), ...route.stops.map((s) => ({ lat: s.lat, lng: s.lng }))]
  route.drive = points.length >= 2 && route.stops.length ? await drive(points) : null
  route.origin = origin
  // How the chances have held up here lately: each band, once enough predictions have been graded.
  const grades = await accuracy(region, { asOf }).catch((error) => { console.error(`Grades for ${region}:`, error.message); return {} })
  return {
    region,
    asOf,
    grades,
    species: results.map((r) => ({ speciesCode: r.speciesCode, comName: names.get(r.speciesCode) || r.speciesCode, class: r.class, bestTime: r.bestTime, places: r.places.length, best: r.places[0] ? { locId: r.places[0].locId, locName: r.places[0].locName, chance: r.places[0].chance } : null })),
    places,
    route
  }
}

/** A starting point written `lat,lng`, rounded to about a kilometre so nearby starts share a cache entry. */
const parseOrigin = (value) => {
  if (!value) return null
  const [lat, lng] = String(value).split(',').map(Number)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 }
}

module.exports = { whereToGo, aggregatePlaces, pickRoute, mapsRouteUrl, roadKm, coverage, parseOrigin, MAX_SPECIES, MAX_STOPS }
