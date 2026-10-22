const path = require('path')
const { Jimp, JimpMime, loadFont, rgbaToInt, HorizontalAlign, VerticalAlign } = require('jimp')

const TILE = 256
const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
// OSM's tile policy requires an identifying User-Agent and attribution on the rendered map.
const USER_AGENT = 'bird-alert/1.0 (+https://github.com/mbenfowler/bird-alert)'
const ATTRIBUTION = '(c) OpenStreetMap contributors'

const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z
const latToY = (lat, z) => {
  const rad = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z
}

const fonts = new Map()
const font = (name) => {
  if (!fonts.has(name)) {
    const fontPath = path.join(require.resolve('@jimp/plugin-print/package.json'), '..', 'dist', 'fonts', 'open-sans', name, `${name}.fnt`)
    fonts.set(name, loadFont(fontPath).catch((error) => { console.error(`Font ${name} failed to load:`, error.message); return null }))
  }
  return fonts.get(name)
}
const attributionFont = () => font('open-sans-10-black')
const labelFont = () => font('open-sans-16-white')

const fetchTile = async (z, x, y) => {
  const res = await fetch(TILE_URL(z, x, y), { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y} returned ${res.status}`)
  return Jimp.read(Buffer.from(await res.arrayBuffer()))
}

/** Draws a filled circle with an outline ring; coordinates are the circle's centre. */
const drawDot = (image, cx, cy, radius, fill, ring, ringWidth) => {
  const outer = radius + ringWidth
  image.scan(Math.floor(cx - outer), Math.floor(cy - outer), Math.ceil(outer * 2) + 1, Math.ceil(outer * 2) + 1, (x, y, idx) => {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
    const color = d <= radius ? fill : d <= outer ? ring : null
    if (color === null) return
    image.bitmap.data.writeUInt32BE(color, idx)
  })
}

/** A map-pin: a teardrop body with a white inner dot (or a label), plus a soft shadow underneath. */
const drawPin = (image, tipX, tipY, { label = '', labelFont: digits = null } = {}) => {
  const shadow = rgbaToInt(0, 0, 0, 70)
  const red = rgbaToInt(214, 40, 40, 255)
  const dark = rgbaToInt(120, 16, 16, 255)
  const white = rgbaToInt(255, 255, 255, 255)
  // Shadow ellipse under the tip.
  image.scan(tipX - 14, tipY - 4, 28, 9, (x, y, idx) => {
    const dx = (x + 0.5 - tipX) / 13, dy = (y + 0.5 - tipY) / 3.5
    if (dx * dx + dy * dy <= 1) image.bitmap.data.writeUInt32BE(shadow, idx)
  })
  const headY = tipY - 26
  // Teardrop: the head circle plus a triangle down to the tip.
  image.scan(tipX - 16, headY - 16, 33, 44, (x, y, idx) => {
    const px = x + 0.5, py = y + 0.5
    const inHead = Math.hypot(px - tipX, py - headY) <= 14
    const t = (py - headY) / (tipY - headY)
    const inTail = py >= headY && py <= tipY && Math.abs(px - tipX) <= 14 * (1 - t) * 0.95
    if (inHead || inTail) image.bitmap.data.writeUInt32BE(red, idx)
  })
  // Outline pass: darken the rim of the head for definition.
  image.scan(tipX - 16, headY - 16, 33, 33, (x, y, idx) => {
    const d = Math.hypot(x + 0.5 - tipX, y + 0.5 - headY)
    if (d > 12.5 && d <= 14) image.bitmap.data.writeUInt32BE(dark, idx)
  })
  if (label && digits) {
    image.print({ font: digits, x: tipX - 16, y: headY - 15, maxWidth: 33, maxHeight: 30, text: { text: String(label), alignmentX: HorizontalAlign.CENTER, alignmentY: VerticalAlign.MIDDLE } })
  } else {
    drawDot(image, tipX, headY, 5, white, red, 0)
  }
}

// Room the pins need inside the frame: the pin stands 30px above its tip, half a head wide.
const PAD_X = 24
const PAD_TOP = 40
const PAD_BOTTOM = 16
const MAX_FIT_ZOOM = 15
const MIN_ZOOM = 3

/** The largest zoom at which every pin fits inside the frame with room for the pin graphics. */
const fitZoom = (pins, width, height) => {
  for (let zoom = MAX_FIT_ZOOM; zoom > MIN_ZOOM; zoom -= 1) {
    const xs = pins.map((p) => lonToX(p.lng, zoom) * TILE)
    const ys = pins.map((p) => latToY(p.lat, zoom) * TILE)
    if (Math.max(...xs) - Math.min(...xs) <= width - 2 * PAD_X && Math.max(...ys) - Math.min(...ys) <= height - PAD_TOP - PAD_BOTTOM) return zoom
  }
  return MIN_ZOOM
}

/** Pins at the same spot (to four decimals) become one pin whose label lists them all. */
const mergePins = (pins) => {
  const merged = new Map()
  for (const pin of pins) {
    const key = `${pin.lat.toFixed(4)},${pin.lng.toFixed(4)}`
    const existing = merged.get(key)
    if (existing) existing.labels.push(pin.label)
    else merged.set(key, { lat: pin.lat, lng: pin.lng, labels: [pin.label] })
  }
  return [...merged.values()].map((pin) => ({ lat: pin.lat, lng: pin.lng, label: pin.labels.filter(Boolean).join(',') }))
}

/**
 * Renders a JPEG map stitched from OpenStreetMap tiles, with attribution. Either one pin at the
 * centre (`lat`, `lng`, `zoom`) or several labelled `pins`, framed to fit them all.
 */
const renderMap = async ({ lat, lng, zoom = 14, width = 640, height = 360, pins = null }) => {
  const placed = pins && pins.length ? mergePins(pins) : [{ lat, lng, label: '' }]
  const fitted = pins && pins.length ? fitZoom(placed, width, height) : zoom
  // Centre on the pins' bounding box; the pins stand above their tips, so the frame sits a little low.
  const centreX = (Math.min(...placed.map((p) => lonToX(p.lng, fitted))) + Math.max(...placed.map((p) => lonToX(p.lng, fitted)))) / 2 * TILE
  const centreY = (Math.min(...placed.map((p) => latToY(p.lat, fitted))) + Math.max(...placed.map((p) => latToY(p.lat, fitted)))) / 2 * TILE
  const left = Math.round(centreX - width / 2)
  const top = Math.round(centreY - height / 2 - (pins && pins.length ? (PAD_TOP - PAD_BOTTOM) / 2 : 0))
  const n = 2 ** fitted
  zoom = fitted

  const canvas = new Jimp({ width, height, color: 0xe8e8e8ff })
  const jobs = []
  for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + width - 1) / TILE); tx += 1) {
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + height - 1) / TILE); ty += 1) {
      if (ty < 0 || ty >= n) continue
      const wrappedX = ((tx % n) + n) % n
      jobs.push(fetchTile(zoom, wrappedX, ty).then((tile) => canvas.composite(tile, tx * TILE - left, ty * TILE - top)))
    }
  }
  await Promise.all(jobs)

  const digits = placed.some((p) => p.label) ? await labelFont() : null
  // Northern pins first so a southern pin's head overlaps a northern pin's tail, not the other way round.
  for (const pin of [...placed].sort((a, b) => a.lat === b.lat ? 0 : a.lat > b.lat ? -1 : 1)) {
    drawPin(canvas, Math.round(lonToX(pin.lng, zoom) * TILE - left), Math.round(latToY(pin.lat, zoom) * TILE - top), { label: pin.label, labelFont: digits })
  }

  const font = await attributionFont()
  if (font) {
    const textWidth = ATTRIBUTION.length * 6 + 8
    const strip = new Jimp({ width: textWidth, height: 16, color: rgbaToInt(255, 255, 255, 190) })
    canvas.composite(strip, width - textWidth, height - 16)
    canvas.print({ font, x: width - textWidth + 4, y: height - 15, text: ATTRIBUTION })
  }

  return canvas.getBuffer(JimpMime.jpeg, { quality: 82 })
}

module.exports = { renderMap, fitZoom, mergePins, lonToX, latToY }
