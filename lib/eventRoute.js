const crypto = require('crypto')
const { HttpError } = require('./http')
const { mergePrivateIntoHotspots, metresBetween } = require('./hotspots')

/**
 * The Big Day route: from the event page's scouting, a core of places worth the drive and the
 * optional extras that aren't, from every location each target was reported at this week.
 *
 * 1. Places: every report of a reported target in the scouting window (the area's feed has only each
 *    species' newest, so each species' own feed is read too, kept an hour like the feed). A personal
 *    location folds into the nearest public hotspot within MERGE_METRES (lib/hotspots), which gains
 *    its birds; one with no hotspot near stays, marked private.
 * 2. Candidates: up to MAX_CANDIDATES places by greedy set cover, and one OSRM table of driving
 *    minutes and miles between the start and them.
 * 3. The core: the place with the most birds, then greedily the best birds per added minute
 *    (cheapest insertion), each only while it costs at most MINUTES_PER_BIRD per new bird; up to
 *    MAX_STOPS. Ordered exactly (n <= 8) or by 2-opt, birds credited in visit order.
 * 4. One OSRM route call for the core's legs and road. Places still adding birds become extras,
 *    each with its cheapest detour, best value first.
 * With OSRM down, the same choices are made on straight lines at CROW_MPH and no times are sent.
 */
const MAX_STOPS = 8
const MAX_CANDIDATES = 15
const MINUTES_PER_BIRD = 15
const CROW_MPH = 35
const ROUTE_SECONDS = 3600
const SPECIES_SECONDS = 3600
const SPECIES_PARALLEL = 4
const BRUTE_FORCE_MAX = 8
const SPECIES_RETRY_MS = 500
const STAY_BASE_MIN = 15
const STAY_PER_TARGET_MIN = 7
const STAY_MAX_MIN = 90

/**
 * How long to give a place: 15 minutes and 7 more for each target reported there this week, to the
 * nearest 5, from 15 to 90. Shared with the group's saved route (lib/eventRoutePlan).
 */
const suggestStay = (targets) => {
  const n = Number.isFinite(targets) && targets > 0 ? targets : 0
  const rounded = Math.round((STAY_BASE_MIN + STAY_PER_TARGET_MIN * n) / 5) * 5
  return Math.min(STAY_MAX_MIN, Math.max(STAY_BASE_MIN, rounded))
}

/** "34.123,-83.456" as { lat, lng } rounded to 2 decimals (about a kilometre: no one's doorstep); null when absent. */
const parseFrom = (value) => {
  if (value === undefined || value === null || value === '') return null
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(value))
  const lat = m && Number(m[1])
  const lng = m && Number(m[2])
  if (!m || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) throw new HttpError(400, 'from is lat,lng')
  return roundPoint({ lat, lng })
}
const roundPoint = (p) => ({ lat: Math.round(p.lat * 100) / 100, lng: Math.round(p.lng * 100) / 100 })

/**
 * Places from reports ({ speciesCode, comName, locId, locName, lat, lng, obsDt, locationPrivate }),
 * personal ones folded into a hotspot within MERGE_METRES. `hotspots` are other public locations from
 * the area's feed (any species) that a personal one may fold into. Places with no target are left out.
 */
const buildPlaces = (reports, hotspots = []) => {
  const byLoc = new Map()
  const add = (r, withSpecies) => {
    if (!r || !r.locId || !Number.isFinite(r.lat) || !Number.isFinite(r.lng)) return
    let place = byLoc.get(r.locId)
    if (!place) {
      // The fields lib/hotspots mergePrivateIntoHotspots reads and folds; `species` is ours.
      place = { locId: r.locId, locName: r.locName, lat: r.lat, lng: r.lng, isHotspot: typeof r.locationPrivate === 'boolean' ? !r.locationPrivate : null, days: new Set(), times: [], subIds: new Set(), notes: [], last: { stamp: '' }, merged: [], species: new Map(), latest: '' }
      byLoc.set(r.locId, place)
    }
    if (typeof r.locationPrivate === 'boolean') place.isHotspot = place.isHotspot || !r.locationPrivate
    if (!withSpecies) return
    if (!place.species.has(r.speciesCode)) place.species.set(r.speciesCode, { code: r.speciesCode, speciesCode: r.speciesCode, comName: r.comName })
    const stamp = String(r.obsDt || '')
    if (stamp > place.latest) { place.latest = stamp; place.last = { stamp } }
  }
  for (const r of reports || []) add(r, true)
  for (const h of hotspots || []) if (h && h.locationPrivate === false) add(h, false)
  const before = new Map(byLoc)
  mergePrivateIntoHotspots(byLoc, new Map())
  for (const place of byLoc.values()) {
    for (const { locId } of place.merged) {
      const folded = before.get(locId)
      for (const [code, s] of folded.species) if (!place.species.has(code)) place.species.set(code, s)
      if (folded.latest > place.latest) place.latest = folded.latest
    }
  }
  return [...byLoc.values()].filter((p) => p.species.size).map((p) => ({
    locId: p.locId, locName: p.locName, lat: p.lat, lng: p.lng, private: p.isHotspot === false, merged: p.merged, species: p.species, latest: p.latest
  }))
}

/** Greedy set cover: the place adding the most uncovered species each time (tie: newest report, then locId); `covered` seeds what is already had. */
const coverPlaces = (places, max, covered = new Set()) => {
  const left = [...places]
  const chosen = []
  while (chosen.length < max && left.length) {
    let best = -1
    let bestGain = 0
    left.forEach((p, i) => {
      const gain = gainOf(p, covered)
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

const gainOf = (place, covered) => { let n = 0; for (const c of place.species.keys()) if (!covered.has(c)) n += 1; return n }

/**
 * Each species credited to the first stop in visit order where it was reported; stops adding nothing
 * are dropped, unless in `keep` (a stop the person asked for stays, even with no new bird).
 */
const creditInOrder = (ordered, keep = new Set()) => {
  const covered = new Set()
  const out = []
  for (const place of ordered) {
    const fresh = [...place.species.values()].filter((s) => !covered.has(s.speciesCode))
    if (!fresh.length && !keep.has(place)) continue
    for (const s of fresh) covered.add(s.speciesCode)
    out.push({ place, new_birds: fresh })
  }
  return out
}

const crowMiles = (a, b) => metresBetween(a, b) / 1609.344

/** Straight-line stand-in for OSRM's table: miles as the crow flies, minutes at CROW_MPH. */
const crowTable = (points) => {
  const miles = points.map((a) => points.map((b) => crowMiles(a, b)))
  return { miles, minutes: miles.map((row) => row.map((m) => (m / CROW_MPH) * 60)) }
}

const cost = (m, i, j) => (Number.isFinite(m[i]?.[j]) ? m[i][j] : Infinity)

/**
 * The cheapest place in `path` (node indexes) for node `p`: between two stops, before the first
 * (unless the first is fixed) or after the last. `{ pos, minutes, miles }`: insert before path[pos].
 */
const insertionCost = (path, p, table, { fixedFirst = true } = {}) => {
  if (!path.length) return { pos: 0, minutes: 0, miles: 0 }
  let best = { pos: -1, minutes: Infinity, miles: Infinity }
  for (let pos = fixedFirst ? 1 : 0; pos <= path.length; pos++) {
    const prev = path[pos - 1]
    const next = path[pos]
    const delta = (m) => (prev === undefined ? cost(m, p, next)
      : next === undefined ? cost(m, prev, p)
        : cost(m, prev, p) + cost(m, p, next) - cost(m, prev, next))
    const minutes = delta(table.minutes)
    // The quickest detour can be a shorter drive in miles than the leg it replaces: never below zero.
    if (minutes < best.minutes) best = { pos, minutes: Math.max(0, minutes), miles: Math.max(0, delta(table.miles)) }
  }
  return best
}

/** Driving minutes along an open path. */
const pathCost = (path, m) => path.slice(1).reduce((sum, node, i) => sum + cost(m, path[i], node), 0)

/** The quickest order of an open path with its first node kept first: every order (n <= 8). */
const bruteForce = (path, m) => {
  if (path.length <= 2) return [...path]
  const [first, ...rest] = path
  let best = [...path]
  let bestCost = pathCost(path, m)
  const permute = (done, left) => {
    if (!left.length) {
      const c = pathCost(done, m)
      if (c < bestCost) { bestCost = c; best = done }
      return
    }
    for (let i = 0; i < left.length; i++) permute([...done, left[i]], [...left.slice(0, i), ...left.slice(i + 1)])
  }
  permute([first], rest)
  return best
}

/** 2-opt on an open path with its first node kept first: reverse any stretch that makes it quicker, until none does. */
const twoOpt = (path, m) => {
  let best = [...path]
  let bestCost = pathCost(best, m)
  let improved = true
  while (improved) {
    improved = false
    for (let i = 1; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const next = [...best.slice(0, i), ...best.slice(i, k + 1).reverse(), ...best.slice(k + 1)]
        const c = pathCost(next, m)
        if (c + 1e-9 < bestCost) { best = next; bestCost = c; improved = true }
      }
    }
  }
  return best
}

const orderPath = (path, m) => (path.length <= BRUTE_FORCE_MAX + 1 ? bruteForce(path, m) : twoOpt(path, m))

/**
 * Pure: the core and extras from candidate places and a table over [start?, ...candidates]
 * (minutes and miles, OSRM's or straight-line). Returns the core in visit order with its credited
 * birds, and the extras with their detours. `picked` places (candidates) are always in the core, each
 * at its cheapest insertion before the per-bird greedy; `dropped` ones never are (they may be extras).
 */
const planCore = (candidates, table, { hasStart, minutesPerBird = MINUTES_PER_BIRD, max = MAX_STOPS, picked = new Set(), dropped = new Set() } = {}) => {
  const offset = hasStart ? 1 : 0
  const node = (i) => i + offset
  const covered = new Set()
  const path = hasStart ? [0] : []
  const inCore = new Set()
  const take = (i) => {
    const ins = insertionCost(path, node(i), table, { fixedFirst: path.length > 0 })
    path.splice(ins.pos, 0, node(i))
    inCore.add(i)
    for (const c of candidates[i].species.keys()) covered.add(c)
  }
  const forced = candidates.map((p, i) => i).filter((i) => picked.has(candidates[i]))
  // The best first place comes from all but the dropped; from the picked alone when they fill the core.
  const pool = candidates.map((p, i) => i).filter((i) => (forced.length >= max ? picked.has(candidates[i]) : !dropped.has(candidates[i])))
  if (pool.length) {
    // The best first place: the most birds, then the nearest (from the start), then the newest report.
    const firstCost = (i) => (hasStart ? cost(table.minutes, 0, node(i)) : 0)
    const first = pool.sort((a, b) => candidates[b].species.size - candidates[a].species.size ||
      (Number.isFinite(firstCost(b)) - Number.isFinite(firstCost(a))) || firstCost(a) - firstCost(b) || candidates[b].latest.localeCompare(candidates[a].latest))[0]
    take(first)
  }
  for (const i of forced) if (!inCore.has(i)) take(i)
  while (inCore.size < max) {
    let pick = null
    candidates.forEach((p, i) => {
      if (inCore.has(i) || dropped.has(p)) return
      const gain = gainOf(p, covered)
      if (!gain) return
      const ins = insertionCost(path, node(i), table, { fixedFirst: true })
      const perBird = Math.max(0, ins.minutes) / gain
      if (Number.isFinite(perBird) && (!pick || perBird < pick.perBird)) pick = { i, perBird }
    })
    if (!pick || pick.perBird > minutesPerBird) break
    // Without a start, the first place stays first (the route begins where the most birds are).
    take(pick.i)
  }
  const ordered = orderPath(path, table.minutes)
  const stops = creditInOrder(ordered.filter((n) => n >= offset).map((n) => candidates[n - offset]), picked)
  const kept = new Set(stops.map((s) => s.place))
  const finalPath = ordered.filter((n) => n < offset || kept.has(candidates[n - offset]))
  const coreCovered = new Set(stops.flatMap((s) => s.new_birds.map((b) => b.speciesCode)))
  const extras = candidates.map((p, i) => ({ p, i })).filter(({ p }) => !kept.has(p) && gainOf(p, coreCovered) > 0).map(({ p, i }) => {
    const ins = insertionCost(finalPath, node(i), table, { fixedFirst: true })
    return { place: p, new_birds: [...p.species.values()].filter((s) => !coreCovered.has(s.speciesCode)), add_min: ins.minutes, add_mi: ins.miles }
  }).sort((a, b) => a.add_min / a.new_birds.length - b.add_min / b.new_birds.length || b.new_birds.length - a.new_birds.length)
  return { stops, extras, path: finalPath, covered: coreCovered }
}

const pointOf = (p) => [p.lat, p.lng]

const MAX_PICKS = 20
const LOC_ID = /^L\d+$/

/** `add` or `drop` from the query: eBird locIds, comma-separated, up to MAX_PICKS; [] when absent. */
const parseIds = (value, name) => {
  if (value === undefined || value === null || value === '') return []
  const ids = [...new Set(String(value).split(',').map((v) => v.trim()).filter(Boolean))]
  if (ids.length > MAX_PICKS) throw new HttpError(400, `${name} takes up to ${MAX_PICKS} places`)
  if (!ids.every((v) => LOC_ID.test(v))) throw new HttpError(400, `${name} takes eBird location ids (like L123456)`)
  return ids
}

/**
 * The places `add` and `drop` name: a place's own locId or one folded into it; unknown ids are
 * ignored. More picked places than stops, or a place both added and dropped, is a 400.
 */
const applyPicks = (places, add, drop, max = MAX_STOPS) => {
  const byId = new Map()
  for (const p of places) {
    byId.set(p.locId, p)
    for (const m of p.merged || []) byId.set(m.locId, p)
  }
  const resolve = (ids) => [...new Set(ids.map((id) => byId.get(id)).filter(Boolean))]
  const picked = resolve(add)
  const dropped = resolve(drop)
  if (picked.length > max) throw new HttpError(400, `A route has up to ${max} stops: add fewer places`)
  if (picked.some((p) => dropped.includes(p))) throw new HttpError(400, 'A place can\'t be both added and dropped')
  return { picked, dropped, add: picked.map((p) => p.locId), drop: dropped.map((p) => p.locId) }
}
const whole = (v) => (Number.isFinite(v) ? Math.round(v) : null)

/**
 * The plan from the places and an optional start. `table(points)` is OSRM's table (lib/routing
 * fetchTable), `drive(points)` its route for the core (lib/routing drive). Either failing gives
 * routed: false: the choices made on straight lines, no times.
 */
const planRoute = async ({ places, reported, from = null, add = [], drop = [] }, { table, drive, minutesPerBird = MINUTES_PER_BIRD, max = MAX_STOPS } = {}) => {
  const applied = applyPicks(places, add, drop, max)
  // The picked places are candidates whatever their gain; the rest by set cover over what they don't have.
  const had = new Set(applied.picked.flatMap((p) => [...p.species.keys()]))
  const candidates = [...applied.picked, ...coverPlaces(places.filter((p) => !applied.picked.includes(p)), Math.max(0, MAX_CANDIDATES - applied.picked.length), had)]
  const points = [...(from ? [from] : []), ...candidates]
  let matrix = null
  if (points.length >= 2) {
    try { matrix = await table(points) } catch (error) { console.error('Event route: table failed:', error.message) }
  }
  let routed = points.length < 2 || Boolean(matrix)
  const picked = new Set(applied.picked)
  const dropped = new Set(applied.dropped)
  const plan = planCore(candidates, matrix || crowTable(points), { hasStart: Boolean(from), minutesPerBird, max, picked, dropped })
  const corePoints = [...(from ? [from] : []), ...plan.stops.map((s) => s.place)]
  let road = null
  if (routed && corePoints.length >= 2) {
    road = await drive(corePoints).catch(() => null)
    if (!road) routed = false
  }
  if (routed && !road) road = { legs: [], minutes: 0, miles: 0, geometry: plan.stops.length ? corePoints.map(pointOf) : [] }
  const legs = routed ? (from ? road.legs : [{ minutes: 0, miles: 0 }, ...road.legs]) : null
  // `species`: every target reported at the place this week (folded personal spots included), whatever the visit order credits.
  const placeFields = (p) => ({ locId: p.locId, locName: p.locName, lat: p.lat, lng: p.lng, species: [...p.species.keys()] })
  // Names for every species any stop or extra lists, so a route edited by hand can name them in any order.
  const names = {}
  for (const place of [...plan.stops, ...plan.extras].map((s) => s.place)) for (const b of place.species.values()) names[b.speciesCode] = b.comName
  const stays = plan.stops.map(({ place }) => suggestStay(place.species.size))
  const withExtras = new Set(plan.covered)
  for (const e of plan.extras) for (const b of e.new_birds) withExtras.add(b.speciesCode)
  return {
    from,
    stops: plan.stops.map(({ place, new_birds }, i) => ({
      n: i + 1, ...placeFields(place), new_birds, leg_min: legs ? whole(legs[i]?.minutes) : null, leg_mi: legs ? whole(legs[i]?.miles) : null, private: place.private, merged: place.merged, picked: picked.has(place),
      targets_here: place.species.size, suggested_stay_min: stays[i]
    })),
    extras: plan.extras.map(({ place, new_birds, add_min, add_mi }) => ({
      ...placeFields(place), new_birds, add_min: routed ? whole(add_min) : null, add_mi: routed ? whole(add_mi) : null, private: place.private, merged: place.merged, dropped: dropped.has(place)
    })),
    total_min: routed ? whole(road.minutes) : null,
    total_mi: routed ? whole(road.miles) : null,
    stay_min_total: stays.reduce((sum, m) => sum + m, 0),
    covered: plan.covered.size,
    covered_with_extras: withExtras.size,
    reported,
    skipped: places.length - plan.stops.length - plan.extras.length,
    geometry: routed ? road.geometry : plan.stops.length ? corePoints.map(pointOf) : [],
    routed,
    names,
    add: applied.add,
    drop: applied.drop
  }
}

/** A cache key for the plan: the places' reports, the start and the places added and dropped (sorted). */
const routeKey = (reports, from, { add = [], drop = [] } = {}) => {
  const what = (reports || []).map((r) => `${r.locId}:${r.speciesCode}:${r.lat},${r.lng}:${r.locationPrivate}`).sort().join('|')
  const at = from ? `${from.lat},${from.lng}` : '-'
  const picks = `+${[...add].sort().join(',')}-${[...drop].sort().join(',')}`
  return `event-route:v3:${crypto.createHash('sha1').update(what).digest('hex')}:${at}:${picks}`
}

const pause = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve())

/** A day `n` days before `day` ('YYYY-MM-DD'). */
const daysBefore = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)

/** Up to `limit` at a time. */
const pooled = async (items, limit, fn) => {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]) }
  }))
  return out
}

/**
 * GET /api/saved?kind=event-route: members only, exactly as the scouting it is made from. The start
 * is `from` (rounded), else the start saved with the group's route, else the event's own spot
 * (rounded), else none. Kept for everyone asking about the same reports from the same start for an
 * hour; a plan OSRM could not route, or one missing a species' feed (`incomplete: true`), is not kept.
 */
const eventRoute = async (user, id, { from: rawFrom = null, add: rawAdd = null, drop: rawDrop = null, now = new Date(), fetchFeed = null, fetchSpecies = null, table = null, drive = null, retryMs = SPECIES_RETRY_MS } = {}) => {
  const asked = parseFrom(rawFrom)
  const addIds = parseIds(rawAdd, 'add')
  const dropIds = parseIds(rawDrop, 'drop')
  const events = require('./events')
  const routing = require('./routing')
  const { shared } = require('./apiGuard')
  const { event, today, feed, records, view } = await events.scoutingFor(user, id, { now, fetchFeed })
  const own = Number.isFinite(event.home_lat) && Number.isFinite(event.home_lng) ? roundPoint({ lat: event.home_lat, lng: event.home_lng }) : null
  // The start the group saved with its route (lib/eventRoutePlan, already rounded) comes before the event's spot.
  const saved = asked ? null : await require('./eventRoutePlan').savedStart(event.id)
  const from = asked || (saved && roundPoint(saved)) || own
  const names = new Map(view.reported.map((r) => [r.speciesCode, r.comName]))
  const since = daysBefore(today, events.SCOUT_VIEW_DAYS - 1)
  const inWindow = (r) => r && names.has(r.speciesCode) && String(r.obsDt || '').slice(0, 10) >= since
  // Each species' feed, asked again once after a pause; one still failing leaves its bird to the area's
  // feed alone, and the plan says it is incomplete and isn't kept.
  let incomplete = false
  const speciesFeed = (code) => shared(`scout-species:${feed.key}:${code}:${events.SCOUT_VIEW_DAYS}`, SPECIES_SECONDS,
    () => (fetchSpecies ? fetchSpecies(feed.key, code) : feed.fetchSpecies(code, events.SCOUT_VIEW_DAYS)))
  const perSpecies = feed ? await pooled([...names.keys()], SPECIES_PARALLEL, (code) =>
    speciesFeed(code)
      .catch(async () => { await pause(retryMs); return speciesFeed(code) })
      .catch((error) => { console.error(`Event route: ${code} feed:`, error.message); incomplete = true; return [] })) : []
  const reports = [...(records || []), ...perSpecies.flat()].filter(inWindow).map((r) => ({ ...r, comName: names.get(r.speciesCode) }))
  const hotspots = [...(records || []), ...perSpecies.flat()].filter((r) => r && r.locationPrivate === false)
  const tools = { table: table || routing.fetchTable, drive: drive || routing.drive }
  const places = buildPlaces(reports, hotspots)
  // Resolved now, so a bad pick is a 400 before anything is routed, and equivalent asks share a plan.
  const { add, drop } = applyPicks(places, addIds, dropIds)
  const make = () => planRoute({ places, reported: names.size, from, add, drop }, tools)
  let fresh = null
  try {
    return await shared(routeKey(reports, from, { add, drop }), ROUTE_SECONDS, async () => {
      fresh = await make()
      if (incomplete) fresh = { ...fresh, incomplete: true }
      if (!fresh.routed || incomplete) throw new Error(incomplete ? 'incomplete' : 'not routed')
      return fresh
    })
  } catch (error) {
    if (fresh) return fresh
    throw error
  }
}

module.exports = {
  eventRoute, planRoute, suggestStay, planCore, parseFrom, parseIds, applyPicks, buildPlaces, coverPlaces, creditInOrder, insertionCost, pathCost, bruteForce, twoOpt, crowTable, routeKey,
  MAX_STOPS, MAX_CANDIDATES, MINUTES_PER_BIRD, CROW_MPH
}
