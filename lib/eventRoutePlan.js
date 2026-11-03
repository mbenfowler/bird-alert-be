const db = require('./db')
const { HttpError } = require('./http')

/**
 * The route saved to an event (event_routes): what the group settled on, edited by anyone in it.
 * A start (rounded to 2 decimals, as the suggestion's `from`: no one's doorstep) and up to MAX_STOPS
 * stops, each a hotspot (locId) or any other point (locId null), rounded to 5 decimals. Each save
 * names the version it was made from; a save from an older copy is a conflict, answered with the
 * current route so the app can say who changed it. No saved route: the suggestion (lib/eventRoute).
 */
const MAX_STOPS = 8
const MAX_NAME = 200
const LOC_ID = /^L\d+$/

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
    return { locId, ...point }
  })
  const start = body.start === undefined || body.start === null ? null : cleanPoint(body.start, 2, 'start')
  return { start, stops, version: cleanVersion(body.version) }
}

const cleanVersion = (value) => {
  const v = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isInteger(v) || v < 0) throw new HttpError(400, 'version is the version the route was read at (0 when none was saved)')
  return v
}

const NONE = { start: null, stops: null, version: 0 }

/** A saved row as the API sends it: who changed it last by the name they go by in the event (as the members list), never an email. */
const present = async (row, user) => {
  if (!row) return { ...NONE }
  const by = row.updated_by ? await db('event_members').where({ event_id: row.event_id, user_id: row.updated_by }).first('display_name') : null
  return {
    start: row.start ?? null,
    stops: row.stops,
    version: Number(row.version),
    updated_at: row.updated_at,
    updated_by_name: by?.display_name || null,
    updated_by_you: Boolean(user && row.updated_by === user.id)
  }
}

const memberOf = (user, id) => require('./events').memberOf(user, id)

/** GET: members only (404 otherwise), exactly as the scouting. */
const getPlan = async (user, id) => {
  const event = await memberOf(user, id)
  return present(await db('event_routes').where({ event_id: event.id }).first(), user)
}

/**
 * PUT { start, stops, version }: saved when `version` is the one stored (0: none yet), as version + 1.
 * Returns { ok: true, plan } or { ok: false, current } (a conflict: someone saved or cleared it since).
 */
const putPlan = async (user, id, input) => {
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
  if (row) return { ok: true, plan: await present(row, user) }
  return { ok: false, current: await present(await db('event_routes').where({ event_id: event.id }).first(), user) }
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

module.exports = { getPlan, putPlan, deletePlan, cleanPlan, savedStart, viewPlan, MAX_STOPS }
