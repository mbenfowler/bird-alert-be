const db = require('./db')
const { HttpError } = require('./http')

/**
 * The route saved to an event (event_routes): what the group settled on, edited by anyone in it.
 * A start (rounded to 2 decimals, as the suggestion's `from`: no one's doorstep) and up to MAX_STOPS
 * stops, each a hotspot (locId) or any other point (locId null), rounded to 5 decimals. Each save
 * names the version it was made from; a save from an older copy is a conflict, answered with the
 * current route so the app can say who changed it. No saved route: the suggestion (lib/eventRoute).
 *
 * Each stop may carry `stay_min` (whole minutes, 0 to MAX_STAY_MIN; absent or null: the suggestion).
 * As read (GET, PUT, the scouting email: routeDetails), each stop also has its targets_here (target
 * birds reported there this week, personal spots folded into it included, from the event's hour-kept
 * scouting feed: no eBird call of its own) and suggested_stay_min (lib/eventRoute suggestStay), with
 * the drive into each stop (one cached OSRM route, lib/routing drive) and the day's totals.
 *
 * The start may carry `time`, the meeting time: 'HH:MM', 24-hour, the event's own clock (absent or
 * null: none). Where the group is on the route (the day view's "We're here") is shared too, apart
 * from `version` so it never conflicts with an edit: current_stop (0-based in stops, -1 the meeting
 * point), the tap's time and who tapped it; the latest tap by its own time wins (postPosition).
 */
const MAX_STOPS = 8
const MAX_NAME = 200
const LOC_ID = /^L\d+$/
const MAX_STAY_MIN = 480
const MEET_TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const AT_MEETING_POINT = -1

const round = (v, places) => { const k = 10 ** places; return Math.round(v * k) / k }
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const cleanPoint = (p, places, what) => {
  if (!isObject(p)) throw new HttpError(400, `Each ${what} needs a name, lat and lng`)
  const lat = typeof p.lat === 'number' ? p.lat : NaN
  const lng = typeof p.lng === 'number' ? p.lng : NaN
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, `Each ${what} needs a name, lat and lng`)
  if (typeof p.name !== 'string' || p.name.length > MAX_NAME) throw new HttpError(400, `A ${what}'s name is text, up to ${MAX_NAME} characters`)
  return { name: p.name, lat: round(lat, places), lng: round(lng, places) }
}

/** The body of a PUT, checked and rounded: { start, stops, version }. */
const cleanPlan = (input) => {
  const body = isObject(input) ? input : {}
  if (!Array.isArray(body.stops)) throw new HttpError(400, 'stops is a list')
  if (body.stops.length > MAX_STOPS) throw new HttpError(400, `A route has up to ${MAX_STOPS} stops`)
  const stops = body.stops.map((s) => {
    const point = cleanPoint(s, 5, 'stop')
    const locId = s.locId === undefined || s.locId === null ? null : s.locId
    if (locId !== null && !(typeof locId === 'string' && LOC_ID.test(locId))) throw new HttpError(400, 'A stop\'s locId is an eBird location id (like L123456) or null')
    // Locked: Shortest route keeps this stop at its place in the order. Only kept when true.
    if (s.locked !== undefined && s.locked !== null && typeof s.locked !== 'boolean') throw new HttpError(400, 'A stop\'s locked is true or false')
    const lock = s.locked === true ? { locked: true } : {}
    const stay = s.stay_min
    if (stay === undefined || stay === null) return { locId, ...point, ...lock }
    if (typeof stay !== 'number' || !Number.isFinite(stay) || stay < 0 || stay > MAX_STAY_MIN) throw new HttpError(400, `A stop's stay_min is minutes from 0 to ${MAX_STAY_MIN}, or null for the suggestion`)
    return { locId, ...point, stay_min: Math.round(stay), ...lock }
  })
  const start = body.start === undefined || body.start === null ? null : { ...cleanPoint(body.start, 2, 'start'), ...cleanTime(body.start.time) }
  return { start, stops, version: cleanVersion(body.version) }
}

/** The start's meeting time: { time: 'HH:MM' }, or nothing when absent or null. */
const cleanTime = (value) => {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'string' || !MEET_TIME.test(value)) throw new HttpError(400, 'A start\'s time is HH:MM (24-hour), or null for none')
  return { time: value }
}

const cleanVersion = (value) => {
  const v = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isInteger(v) || v < 0) throw new HttpError(400, 'version is the version the route was read at (0 when none was saved)')
  return v
}

const NONE = { start: null, stops: null, version: 0, position: null }

const nameIn = async (eventId, userId) => (userId ? (await db('event_members').where({ event_id: eventId, user_id: userId }).first('display_name'))?.display_name || null : null)

/** True when `stop` is somewhere on the route as saved: a stop's index, or -1 with a start (the meeting point). */
const onRoute = (stop, { start, stops }) => (stop === AT_MEETING_POINT ? Boolean(start) : Number.isInteger(stop) && stop >= 0 && stop < (stops || []).length)

/**
 * Where the group is, as the API sends it: { stop, at, by_name, by_you }, or null when none is set or
 * the stop is no longer on the route (the stops changed since). by_name: their display_name, never an email.
 */
const positionOf = async (row, user) => {
  if (!row || row.current_stop === null || row.current_stop === undefined || !onRoute(row.current_stop, row)) return null
  return {
    stop: row.current_stop,
    at: new Date(row.current_stop_at).toISOString(),
    by_name: await nameIn(row.event_id, row.current_stop_by),
    by_you: Boolean(user && row.current_stop_by === user.id)
  }
}

/** A saved row as the API sends it: who changed it last by the name they go by in the event (as the members list), never an email. */
const present = async (row, user) => {
  if (!row) return { ...NONE }
  return {
    start: row.start ?? null,
    stops: row.stops,
    version: Number(row.version),
    updated_at: row.updated_at,
    updated_by_name: await nameIn(row.event_id, row.updated_by),
    updated_by_you: Boolean(user && row.updated_by === user.id),
    position: await positionOf(row, user)
  }
}

const memberOf = (user, id) => require('./events').memberOf(user, id)

/** A day `n` days before `day` ('YYYY-MM-DD'). */
const daysBefore = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10)

/**
 * Pure: for each stop, how many of `targets` were reported there in the scouting window up to
 * `today`, from the area's feed `records`: its own locId and any personal spot folded into it (as the
 * suggestion folds them, lib/eventRoute buildPlaces). A point with no locId: 0.
 */
const targetsAt = (stops, { records = [], targets = [], today = null } = {}) => {
  const { buildPlaces } = require('./eventRoute')
  const wanted = new Set(targets || [])
  const since = today ? daysBefore(today, require('./events').SCOUT_VIEW_DAYS - 1) : ''
  const reports = (records || []).filter((r) => r && wanted.has(r.speciesCode) && String(r.obsDt || '').slice(0, 10) >= since)
  const hotspots = (records || []).filter((r) => r && r.locationPrivate === false)
  const byId = new Map()
  for (const place of buildPlaces(reports, hotspots)) {
    byId.set(place.locId, place.species.size)
    for (const m of place.merged || []) if (!byId.has(m.locId)) byId.set(m.locId, place.species.size)
  }
  return stops.map((s) => (s.locId && byId.get(s.locId)) || 0)
}

const whole = (v) => (Number.isFinite(v) ? Math.round(v) : null)
const tenth = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null)

/**
 * The saved route as the app and the scouting email read it: { start, stops } with each stop's
 * stay_min (null: use the suggestion), targets_here and suggested_stay_min; legs, one a stop, the
 * drive into it ({ min, mi }; the first null without a start); totals { drive_min, stay_min, total_min }
 * (stay_min counts each stop's own stay, else the suggestion); routed (false: OSRM failed, legs and
 * drive_min null, total_min the stays alone). `scouting` is { records, targets, today } (lib/events
 * scoutingFor); `drive` lib/routing drive, cached there.
 */
const routeDetails = async ({ start = null, stops = [] }, scouting = {}, { drive = null } = {}) => {
  const counts = targetsAt(stops, scouting)
  const { suggestStay } = require('./eventRoute')
  const detailed = stops.map((s, i) => ({ ...s, stay_min: Number.isInteger(s.stay_min) ? s.stay_min : null, targets_here: counts[i], suggested_stay_min: suggestStay(counts[i]) }))
  const points = [...(start ? [start] : []), ...detailed]
  let routed = true
  let road = null
  if (points.length >= 2) {
    road = await (drive || require('./routing').drive)(points).catch(() => null)
    if (!road || !Array.isArray(road.legs) || road.legs.length !== points.length - 1) routed = false
  }
  const raw = road?.legs || []
  const legs = routed ? detailed.map((s, i) => {
    const leg = start ? raw[i] : i === 0 ? null : raw[i - 1]
    return leg ? { min: whole(leg.minutes), mi: tenth(leg.miles) } : null
  }) : null
  const stay = detailed.reduce((sum, s) => sum + (s.stay_min ?? s.suggested_stay_min), 0)
  const driveMin = routed ? legs.reduce((sum, l) => sum + (l?.min || 0), 0) : null
  return {
    start,
    stops: detailed,
    legs,
    totals: { drive_min: driveMin, stay_min: stay, total_min: stay + (driveMin || 0) },
    routed
  }
}

/** The event's scouting, for routeDetails: { records, targets, today }; none when the feed can't be had. */
const scoutingOf = async (user, eventId, { now = new Date(), fetchFeed = null } = {}) => {
  try {
    const { records, targets, today } = await require('./events').scoutingFor(user, eventId, { now, fetchFeed })
    return { records, targets, today }
  } catch (error) {
    console.error(`Route plan ${eventId}: scouting:`, error.message)
    return { records: [], targets: [], today: null }
  }
}

/** A presented plan with routeDetails' fields; none saved: as it is. */
const detail = async (plan, user, eventId, opts = {}) => {
  if (!plan.stops) return plan
  const details = await routeDetails(plan, await scoutingOf(user, eventId, opts), opts)
  return { ...plan, ...details }
}

/** GET: members only (404 otherwise), exactly as the scouting. `opts`: { now, fetchFeed, drive } for tests. */
const getPlan = async (user, id, opts = {}) => {
  const event = await memberOf(user, id)
  return detail(await present(await db('event_routes').where({ event_id: event.id }).first(), user), user, event.id, opts)
}

/**
 * PUT { start, stops, version }: saved when `version` is the one stored (0: none yet), as version + 1.
 * Returns { ok: true, plan } or { ok: false, current } (a conflict: someone saved or cleared it since).
 */
const putPlan = async (user, id, input, opts = {}) => {
  const event = await memberOf(user, id)
  const { start, stops, version } = cleanPlan(input)
  const values = { start: start ? JSON.stringify(start) : null, stops: JSON.stringify(stops), updated_by: user.id, updated_at: db.fn.now() }
  const row = await db.transaction(async (trx) => {
    if (version === 0) {
      const [made] = await trx('event_routes').insert({ event_id: event.id, ...values, version: 1 }).onConflict('event_id').ignore().returning('*')
      return made || null
    }
    const [changed] = await trx('event_routes').where({ event_id: event.id, version }).update({ ...values, version: version + 1 }).returning('*')
    return changed || null
  })
  if (row) return { ok: true, plan: await detail(await present(row, user), user, event.id, opts) }
  return { ok: false, current: await detail(await present(await db('event_routes').where({ event_id: event.id }).first(), user), user, event.id, opts) }
}

/** DELETE ?version=: back to the suggestion, under the same rule. Clearing what is already clear is fine. */
const deletePlan = async (user, id, rawVersion) => {
  const event = await memberOf(user, id)
  const version = cleanVersion(rawVersion)
  const gone = await db.transaction(async (trx) => {
    if (version === 0) return !(await trx('event_routes').where({ event_id: event.id }).first())
    return (await trx('event_routes').where({ event_id: event.id, version }).del()) > 0
  })
  if (gone) return { ok: true, plan: { ...NONE } }
  return { ok: false, current: await present(await db('event_routes').where({ event_id: event.id }).first(), user) }
}

/** The body of a position POST: { stop: int|null, at: Date } with `at` (default now) no later than now. */
const cleanPosition = (input, now = new Date()) => {
  const body = isObject(input) ? input : {}
  const stop = body.stop === undefined ? null : body.stop
  if (stop !== null && !(Number.isInteger(stop) && stop >= AT_MEETING_POINT)) throw new HttpError(400, 'stop is a stop\'s place in the route (0 the first, -1 the meeting point), or null')
  let at = now
  if (body.at !== undefined && body.at !== null) {
    const parsed = typeof body.at === 'string' ? new Date(body.at) : new Date(NaN)
    if (Number.isNaN(parsed.getTime())) throw new HttpError(400, 'at is a date and time')
    at = parsed > now ? now : parsed
  }
  return { stop, at }
}

/**
 * POST { stop, at }: where the group is ("We're here"), for every member. Leaves `version` alone, so it
 * never conflicts with an edit. The latest `at` wins, whatever order taps arrive in (a tap from an
 * offline phone synced late doesn't undo a newer one); null clears it, by the same rule. A stop not on
 * the route as saved now is a 400; no saved route, a 409. Returns { position, applied } (position as
 * GET gives it; applied false: a newer one was already there).
 */
const postPosition = async (user, id, input, { now = new Date() } = {}) => {
  const event = await memberOf(user, id)
  const { stop, at } = cleanPosition(input, now)
  const result = await db.transaction(async (trx) => {
    const row = await trx('event_routes').where({ event_id: event.id }).forUpdate().first()
    if (!row) throw new HttpError(409, 'The route isn\'t saved yet')
    if (stop !== null && !onRoute(stop, row)) throw new HttpError(400, 'That stop isn\'t on the route')
    if (row.current_stop_at && new Date(row.current_stop_at) >= at) return { row, applied: false }
    const [changed] = await trx('event_routes').where({ event_id: event.id })
      .update({ current_stop: stop, current_stop_at: at, current_stop_by: user.id }).returning('*')
    return { row: changed, applied: true }
  })
  return { position: await positionOf(result.row, user), applied: result.applied }
}

/** The saved start, for the suggestion's default `from`; null when none. */
const savedStart = async (eventId) => {
  const row = await db('event_routes').where({ event_id: eventId }).first('start')
  const s = row?.start
  return s && Number.isFinite(s.lat) && Number.isFinite(s.lng) ? { lat: s.lat, lng: s.lng } : null
}

/** For the view-only link: the stops only, never the start. Null when nothing is saved. */
const viewPlan = async (eventId) => {
  const row = await db('event_routes').where({ event_id: eventId }).first('stops')
  return row ? { start: null, stops: row.stops } : null
}

module.exports = { getPlan, putPlan, deletePlan, postPosition, cleanPlan, cleanPosition, savedStart, viewPlan, routeDetails, targetsAt, MAX_STOPS, MAX_STAY_MIN }
