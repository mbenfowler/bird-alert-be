const { route, HttpError } = require('../lib/http')
const { renderMap } = require('../lib/staticMap')

const num = (value, min, max, label) => {
  const n = Number.parseFloat(value)
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `Invalid ${label}`)
  return n
}

// GET /api/map?lat=&lng=&zoom=14 -> JPEG map centred on the point with a pin. Used as the picture on
// push notifications. Cached hard: the same sighting always renders the same map.
module.exports = route(['GET'], async (req, res) => {
  const lat = num(req.query.lat, -85, 85, 'lat')
  const lng = num(req.query.lng, -180, 180, 'lng')
  const zoom = Math.round(num(req.query.zoom ?? '14', 3, 17, 'zoom'))
  const jpeg = await renderMap({ lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)), zoom })
  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000, immutable')
  res.status(200).send(jpeg)
})
