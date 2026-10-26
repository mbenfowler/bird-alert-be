const db = require('./db')
const { HttpError } = require('./http')
const { assertRegion } = require('./ebird')

/**
 * A person's own route for a county (the stops in order) and where their day starts, kept on the
 * account so a route planned at the desk is there on the phone. The page keeps its own copy too
 * and works without these.
 */
const MAX_STOPS = 8
const text = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null)

/** One point, cleaned to the fields the page uses; anything malformed is refused. */
const cleanPoint = (p) => {
  if (!p || typeof p !== 'object') throw new HttpError(400, 'Invalid point')
  const lat = Number(p.lat)
  const lng = Number(p.lng)
  const name = text(p.name, 200)
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, 'Invalid point')
  const locId = text(p.locId, 20)
  if (locId && !/^L\d{1,12}$/.test(locId)) throw new HttpError(400, 'Invalid point')
  return { locId, name, lat, lng, note: text(p.note, 200) }
}

const cleanStops = (stops) => {
  if (stops === null) return null
  if (!Array.isArray(stops) || stops.length > MAX_STOPS) throw new HttpError(400, `stops must be a list of up to ${MAX_STOPS}`)
  return stops.map(cleanPoint)
}

const getRoute = async (userId, region) => {
  const row = await db('user_routes').where({ user_id: userId, region: assertRegion(region) }).first()
  const user = await db('users').where({ id: userId }).first('route_start')
  return { region, stops: row ? row.stops : null, start: user?.route_start ?? null, updatedAt: row ? row.updated_at : null }
}

/** `stops` (null clears the county's route) and `start` (null clears it) are each changed only when given. */
const putRoute = async (userId, { region, ...fields }) => {
  const code = assertRegion(String(region || ''))
  if ('stops' in fields) {
    const stops = cleanStops(fields.stops)
    if (stops === null) await db('user_routes').where({ user_id: userId, region: code }).del()
    else await db('user_routes').insert({ user_id: userId, region: code, stops: JSON.stringify(stops) }).onConflict(['user_id', 'region']).merge({ stops: JSON.stringify(stops), updated_at: db.fn.now() })
  }
  if ('start' in fields) {
    const start = fields.start === null ? null : cleanPoint(fields.start)
    await db('users').where({ id: userId }).update({ route_start: start === null ? null : JSON.stringify(start) })
  }
  return getRoute(userId, code)
}

module.exports = { getRoute, putRoute, cleanPoint, cleanStops, MAX_STOPS }
