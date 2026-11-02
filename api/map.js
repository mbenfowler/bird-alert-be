const { route, HttpError } = require('../lib/http')
const { renderMap } = require('../lib/staticMap')
const { renderShareCard } = require('../lib/shareCard')
const db = require('../lib/db')

const num = (value, min, max, label) => {
  const n = Number.parseFloat(value)
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Invalid ${label}`)
  return n
}

const MAX_PINS = 12

/** `pins=lat,lng,label;lat,lng,label` -> [{ lat, lng, label }]; labels are short and plain. */
const parsePins = (value) => {
  const pins = String(value).split(';').filter(Boolean).map((part) => {
    const [lat, lng, label = ''] = part.split(',')
    return { lat: Number(num(lat, -85, 85, 'pin latitude').toFixed(4)), lng: Number(num(lng, -180, 180, 'pin longitude').toFixed(4)), label: label.replace(/[^0-9A-Za-z]/g, '').slice(0, 3) }
  })
  if (!pins.length || pins.length > MAX_PINS) throw new HttpError(400, `Between 1 and ${MAX_PINS} pins`)
  return pins
}

// GET /api/map?lat=&lng=&zoom=14 -> JPEG map centred on the point with a pin: the picture on push
// notifications. GET /api/map?pins=lat,lng,1;lat,lng,2 -> one map framed around several labelled
// pins: the map in email digests. Cached hard: the same places always render the same map.
// GET /api/map?card=<share id> -> the 1200x630 picture for a shared sighting's preview card: the
// bird's photo whole, over a blurred copy of itself. Cached hard: a share never changes.
module.exports = route(['GET'], async (req, res) => {
  let jpeg
  if (req.query.card !== undefined) {
    const id = String(req.query.card)
    if (!/^[A-Za-z0-9]{6,12}$/.test(id)) throw new HttpError(404, 'Not found')
    const share = await db('shares').where({ id, kind: 'sighting' }).first('payload')
    if (!share?.payload?.birdImg) throw new HttpError(404, 'Not found')
    jpeg = await renderShareCard(share.payload)
  } else if (req.query.pins !== undefined) {
    jpeg = await renderMap({ pins: parsePins(req.query.pins) })
  } else {
    const lat = num(req.query.lat, -85, 85, 'lat')
    const lng = num(req.query.lng, -180, 180, 'lng')
    const zoom = Math.round(num(req.query.zoom ?? '14', 3, 17, 'zoom'))
    jpeg = await renderMap({ lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)), zoom })
  }
  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, immutable')
  res.status(200).send(jpeg)
})
