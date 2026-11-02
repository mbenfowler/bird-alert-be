const crypto = require('crypto')
const { HttpError } = require('./http')

/**
 * The Big Day route: from the event page's scouting (lib/events eventScouting), the fewest places
 * that between them had reports of the most target birds this week, in the quickest driving order.
 * Places are chosen by greedy set cover (up to MAX_STOPS, to keep the OSRM demo server's load tiny),
 * ordered by OSRM's trip service, and each bird is credited to the first stop on the way where it
 * was reported. With OSRM down, the stops go nearest-first as the crow flies, with no times.
 */
const MAX_STOPS = 8
const ROUTE_SECONDS = 3600
const MAX_GEOMETRY_POINTS = 500

/** "34.123,-83.456" as { lat, lng } rounded to 2 decimals (about a kilometre: no one's doorstep); null when absent. */
const parseFrom = (value) => {
  if (value === undefined || value === null || value === '') return null
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(value))
  const lat = m && Number(m[1])
  const lng = m && Number(m[2])
  if (!m || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) throw new HttpError(400, 'from is lat,lng')
  return { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 }
}

/** Places from the reports: one per locId, its distinct species (in report order) and its newest report. */
const placesFrom = (reported) => {
  const byLoc = new Map()
  for (const r of reported || []) {
    if (!r || !r.locId || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) continue
    let place = byLoc.get(r.locId)
    if (!place) {
      place = { locId: r.locId, locName: r.locName, lat: r.lat, lng: r.lng, species: new Map(), latest: '' }
      byLoc.set(r.locId, place)
    }
    if (!place.species.has(r.speciesCode)) place.species.set(r.speciesCode, { code: r.speciesCode, speciesCode: r.speciesCode, comName: r.comName })
    if (String(r.obsDt || '') > place.latest) place.latest = String(r.obsDt || '')
  }
  return [...byLoc.values()]
}

/** Greedy set cover: the place adding the most uncovered species each time (tie: newest report, then locId). */
const coverPlaces = (places, max = MAX_STOPS) => {
  const covered = new Set()
  const left = [...places]
  const chosen = []
  while (chosen.length < max && left.length) {
    let best = -1
    let bestGain = 0
    left.forEach((p, i) => {
      const gain = [...p.species.keys()].filter((c) => !covered.has(c)).length
      const b = left[best]
      if (gain > bestGain || (gain === bestGain && gain > 0 && (p.latest > b.latest || (p.latest === b.latest && p.locId < b.locId)))) {
        best = i
        bestGain = gain
      }
    })
    if (best < 0) break
    const [place] = left.splice(best, 1)
    for (const c of place.species.keys()) covered.add(c)
    chosen.push(place)
  }
  return chosen
}

/** Each species credited to the first stop in visit order where it was reported; stops adding nothing are dropped. */
const creditInOrder = (ordered) => {
  const covered = new Set()
  const out = []
  for (const place of ordered) {
    const fresh = [...place.species.values()].filter((s) => !covered.has(s.speciesCode))
    if (!fresh.length) continue
    for (const s of fresh) covered.add(s.speciesCode)
    out.push({ place, new_birds: fresh })
  }
  return out
}

const RADIUS_MI = 3958.8
const crowMiles = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Nearest-neighbour order from `start` (a point not in `places`, or null to start at places[0]). */
const nearestOrder = (start, places) => {
  const left = [...places]
  const out = []
  let at = start
  if (!at) { at = left.shift(); out.push(at) }
  while (left.length) {
    let best = 0
    left.forEach((p, i) => { if (crowMiles(at, p) < crowMiles(at, left[best])) best = i })
    at = left.splice(best, 1)[0]
    out.push(at)
  }
  return out
}

/** The place to start from without a `from`: the most species (tie: newest report, then locId). */
const firstPlace = (places) => [...places].sort((a, b) => b.species.size - a.species.size || b.latest.localeCompare(a.latest) || a.locId.localeCompare(b.locId))[0]

const pointOf = (p) => [p.lat, p.lng]

/**
 * The plan from the scouting reports and an optional start. `trip(points)` is OSRM's trip
 * (lib/routing fetchTrip); `drive(points)` re-routes a fixed order when a stop is dropped after ordering
 * (lib/routing drive). Either failing gives routed: false.
 */
const planRoute = async (reported, from, { trip, drive, max = MAX_STOPS } = {}) => {
  const places = placesFrom(reported)
  const reportedCount = new Set((reported || []).filter((r) => r && r.speciesCode).map((r) => r.speciesCode)).size
  const chosen = coverPlaces(places, max)
  const finish = (credited, legs, total, geometry, routed) => ({
    from,
    stops: credited.map(({ place, new_birds }, i) => ({
      n: i + 1,
      locId: place.locId,
      locName: place.locName,
      lat: place.lat,
      lng: place.lng,
      new_birds,
      leg_min: legs ? Math.round(legs[i].minutes) : null,
      leg_mi: legs ? Math.round(legs[i].miles) : null
    })),
    total_min: total ? Math.round(total.minutes) : null,
    total_mi: total ? Math.round(total.miles) : null,
    covered: new Set(credited.flatMap((s) => s.new_birds.map((b) => b.speciesCode))).size,
    reported: reportedCount,
    skipped: places.length - credited.length,
    geometry,
    routed
  })
  const zero = { minutes: 0, miles: 0 }
  const legsFor = (credited, raw) => (from ? raw : [zero, ...raw]).slice(0, credited.length)
  const points = (credited) => [...(from ? [from] : []), ...credited.map((s) => s.place)]

  if (!chosen.length) return finish([], [], zero, [], true)
  const lead = from ? null : firstPlace(chosen)
  const rest = from ? chosen : chosen.filter((p) => p !== lead)
  if (!from && !rest.length) return finish(creditInOrder([lead]), [zero], zero, [pointOf(lead)], true)

  const fallback = () => {
    const ordered = from ? nearestOrder(from, chosen) : nearestOrder(null, [lead, ...rest])
    const credited = creditInOrder(ordered)
    return finish(credited, null, null, points(credited).map(pointOf), false)
  }

  const input = [...(from ? [from] : [lead]), ...rest]
  let found
  try {
    found = await trip(input)
  } catch (error) {
    console.error('Event route: trip failed:', error.message)
    return fallback()
  }
  const ordered = found.order.map((i) => input[i]).filter((p) => p !== from)
  const credited = creditInOrder(ordered)
  if (credited.length === ordered.length) {
    return finish(credited, legsFor(credited, found.legs), { minutes: found.minutes, miles: found.miles }, found.geometry, true)
  }
  // A stop added nothing once the order was known: route the rest again, in the same order.
  const again = credited.length + (from ? 1 : 0) >= 2 ? await drive(points(credited)).catch(() => null) : { legs: [], minutes: 0, miles: 0, geometry: points(credited).map(pointOf) }
  if (!again) return finish(credited, null, null, points(credited).map(pointOf), false)
  return finish(credited, legsFor(credited, again.legs), { minutes: again.minutes, miles: again.miles }, again.geometry, true)
}

/** A cache key for the plan: what it is made from (the stops' places and species) and the rounded start. */
const routeKey = (reported, from) => {
  const what = (reported || []).map((r) => `${r.locId}:${r.speciesCode}:${r.lat},${r.lng}`).sort().join('|')
  const at = from ? `${from.lat},${from.lng}` : '-'
  return `event-route:${crypto.createHash('sha1').update(what).digest('hex')}:${at}`
}

/**
 * GET /api/saved?kind=event-route: members only, exactly as the scouting it is made from. The plan
 * is kept for everyone asking about the same reports from the same rounded start for an hour; a
 * plan OSRM could not route is not kept, so the next ask tries again.
 */
const eventRoute = async (user, id, { from: rawFrom = null, now = new Date(), fetchFeed = null, trip = null, drive = null } = {}) => {
  const from = parseFrom(rawFrom)
  const events = require('./events')
  const routing = require('./routing')
  const { shared } = require('./apiGuard')
  const scouting = await events.eventScouting(user, id, { now, fetchFeed })
  const tools = { trip: trip || routing.fetchTrip, drive: drive || routing.drive }
  let fresh = null
  try {
    return await shared(routeKey(scouting.reported, from), ROUTE_SECONDS, async () => {
      fresh = await planRoute(scouting.reported, from, tools)
      if (!fresh.routed) throw new Error('not routed')
      return fresh
    })
  } catch (error) {
    if (fresh) return fresh
    throw error
  }
}

module.exports = { eventRoute, planRoute, parseFrom, placesFrom, coverPlaces, creditInOrder, nearestOrder, routeKey, MAX_STOPS, MAX_GEOMETRY_POINTS }
