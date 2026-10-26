const db = require('./db')
const { whereToFindMany } = require('./hotspots')
const { today } = require('./seasonality')

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

/**
 * Greedy route: each stop is the place that adds the most to the chance of seeing each bird at
 * least once across the stops so far (1 - product of misses), so three stops that all hold the
 * same cardinal lose to three that cover different birds. Hotspots only; a yard is not a stop.
 */
const pickRoute = (places, { maxStops = MAX_STOPS } = {}) => {
  const candidates = places.filter((p) => p.isHotspot !== false && p.lat !== null)
  const miss = new Map() // species -> probability of missing it across chosen stops
  const stops = []
  while (stops.length < maxStops) {
    let best = null
    let bestGain = 0.05
    for (const place of candidates) {
      if (stops.includes(place)) continue
      let gain = 0
      for (const b of place.birds) gain += (miss.get(b.speciesCode) ?? 1) * (b.chance / 100)
      if (gain > bestGain) { best = place; bestGain = gain }
    }
    if (!best) break
    for (const b of best.birds) miss.set(b.speciesCode, (miss.get(b.speciesCode) ?? 1) * (1 - b.chance / 100))
    stops.push(best)
  }
  const covers = Math.round([...miss.values()].reduce((sum, m) => sum + (1 - m), 0) * 10) / 10
  return { stops: stops.map((p) => ({ locId: p.locId, locName: p.locName, lat: p.lat, lng: p.lng, expected: p.expected, bestTime: p.bestTime, birds: p.birds.slice(0, 6) })), covers, url: mapsRouteUrl(stops) }
}

/** Google Maps directions through the stops (Apple Maps links take one destination only). */
const mapsRouteUrl = (stops) => {
  if (!stops.length) return null
  const pt = (p) => `${p.lat},${p.lng}`
  const last = stops[stops.length - 1]
  const url = new URL('https://www.google.com/maps/dir/')
  url.searchParams.set('api', '1')
  url.searchParams.set('destination', pt(last))
  if (stops.length > 1) url.searchParams.set('waypoints', stops.slice(0, -1).map(pt).join('|'))
  url.searchParams.set('travelmode', 'driving')
  return url.toString()
}

const whereToGo = async (region, codes, { asOf = today() } = {}) => {
  const wanted = [...new Set(codes)].slice(0, MAX_SPECIES)
  const results = await whereToFindMany(region, wanted, { asOf })
  const names = new Map(results.map((r) => [r.speciesCode, r.comName || r.speciesCode]))
  const places = aggregatePlaces(results, names)
  return {
    region,
    asOf,
    species: results.map((r) => ({ speciesCode: r.speciesCode, comName: names.get(r.speciesCode) || r.speciesCode, class: r.class, bestTime: r.bestTime, places: r.places.length, best: r.places[0] ? { locId: r.places[0].locId, locName: r.places[0].locName, chance: r.places[0].chance } : null })),
    places,
    route: pickRoute(places)
  }
}

module.exports = { whereToGo, aggregatePlaces, pickRoute, mapsRouteUrl, MAX_SPECIES, MAX_STOPS }
