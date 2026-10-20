const path = require('path')
const { Jimp, JimpMime, loadFont, rgbaToInt } = require('jimp')

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

let fontPromise
const attributionFont = () => {
  if (!fontPromise) {
    const fontPath = path.join(require.resolve('@jimp/plugin-print/package.json'), '..', 'dist', 'fonts', 'open-sans', 'open-sans-10-black', 'open-sans-10-black.fnt')
    fontPromise = loadFont(fontPath).catch((error) => { console.error('Attribution font failed to load:', error.message); return null })
  }
  return fontPromise
}

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

/** A map-pin: a teardrop body with a white inner dot, plus a soft shadow underneath. */
const drawPin = (image, tipX, tipY) => {
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
  drawDot(image, tipX, headY, 5, white, red, 0)
}

/**
 * Renders a JPEG map centred on a point, stitched from OpenStreetMap tiles, with a pin and attribution.
 */
const renderMap = async ({ lat, lng, zoom = 14, width = 640, height = 360 }) => {
  const worldX = lonToX(lng, zoom) * TILE
  const worldY = latToY(lat, zoom) * TILE
  const left = Math.round(worldX - width / 2)
  const top = Math.round(worldY - height / 2)
  const n = 2 ** zoom

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

  drawPin(canvas, Math.round(width / 2), Math.round(height / 2))

  const font = await attributionFont()
  if (font) {
    const textWidth = ATTRIBUTION.length * 6 + 8
    const strip = new Jimp({ width: textWidth, height: 16, color: rgbaToInt(255, 255, 255, 190) })
    canvas.composite(strip, width - textWidth, height - 16)
    canvas.print({ font, x: width - textWidth + 4, y: height - 15, text: ATTRIBUTION })
  }

  return canvas.getBuffer(JimpMime.jpeg, { quality: 82 })
}

module.exports = { renderMap, lonToX, latToY }
