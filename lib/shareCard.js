const path = require('path')
const { Jimp, JimpMime, loadFont, measureText, rgbaToInt } = require('jimp')
const { cardImage } = require('./shares')
const { renderMap } = require('./staticMap')
const { t } = require('./i18n')

/**
 * The picture under a shared sighting on X or Facebook: 1200x630, the bird's photo whole in the
 * middle (never cropped, so a tall photo keeps its head), over the same photo blurred and dimmed
 * to fill the sides. Built once per share and cached at the edge for a month.
 */
const WIDTH = 1200
const HEIGHT = 630
const SOURCE_HOSTS = /^(images\.unsplash\.com|upload\.wikimedia\.org|[a-z0-9-]+\.wikimedia\.org|nuthatch\.lastelm\.software)$/

const fetchPhoto = async (src) => {
  const url = new URL(src)
  if (url.protocol !== 'https:' || !SOURCE_HOSTS.test(url.hostname)) throw new Error('Photo host not allowed')
  // Unsplash serves any size: ask for one big enough to fill the card's height sharply.
  if (url.hostname === 'images.unsplash.com') { url.searchParams.set('h', String(HEIGHT * 2)); url.searchParams.delete('w'); url.searchParams.set('fit', 'max') }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 8000)
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'bird-alert (https://github.com/mbenfowler/bird-alert)' } })
    if (!res.ok) throw new Error(`Photo ${res.status}`)
    return Jimp.read(Buffer.from(await res.arrayBuffer()))
  } finally { clearTimeout(timer) }
}

const renderCard = async (photoUrl) => {
  const photo = await fetchPhoto(photoUrl)
  // The backdrop: the photo stretched to cover, shrunk to a few pixels and back (a cheap, smooth blur), then dimmed.
  const back = photo.clone().cover({ w: WIDTH, h: HEIGHT }).resize({ w: 48, h: 25 }).resize({ w: WIDTH, h: HEIGHT }).brightness(0.82)
  // The bird, whole: as large as fits.
  const front = photo.clone().scaleToFit({ w: WIDTH, h: HEIGHT })
  back.composite(front, Math.round((WIDTH - front.bitmap.width) / 2), Math.round((HEIGHT - front.bitmap.height) / 2))
  return back.getBuffer(JimpMime.jpeg, { quality: 84 })
}

/**
 * The mega card: an ABA Code 4 or 5 bird, the card that stops a feed. The photo large on a darker
 * blurred backdrop, a red "ABA CODE 5" badge on its corner, a map of where in the state, a green
 * "confirmed" strip when eBird's reviewers have accepted it, and the bird's name across the bottom
 * with the state, county and date. The map is a bonus: if its tiles are slow, the card goes without.
 */
const fonts = new Map()
const font = (name) => {
  if (!fonts.has(name)) fonts.set(name, loadFont(path.join(require.resolve('@jimp/plugin-print/package.json'), '..', 'dist', 'fonts', 'open-sans', name, `${name}.fnt`)))
  return fonts.get(name)
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const shortDate = (obsDt) => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(obsDt || ''); return m ? `${MONTHS[Number(m[1]) - 1]} ${Number(m[2])}` : '' }

/** Pure: the card layout a share gets. */
const cardLayout = (payload) => ([4, 5].includes(payload?.card?.aba) ? 'mega' : 'plain')

const RED = rgbaToInt(200, 16, 46, 255)
const GREEN = rgbaToInt(22, 120, 60, 255)
const MAP_TIMEOUT_MS = 6000
const box = (w, h, color) => new Jimp({ width: w, height: h, color })

/** A tick, drawn (the bitmap fonts have no ✓): two thick strokes. */
const drawTick = (image, x, y, size = 16) => {
  const white = 0xffffffff
  const dot = (px, py) => { for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) image.setPixelColor(white, Math.round(px + dx), Math.round(py + dy)) }
  for (let i = 0; i <= size * 0.35; i++) dot(x + i, y + size * 0.55 + i)
  for (let i = 0; i <= size * 0.65; i++) dot(x + size * 0.35 + i, y + size * 0.9 - i * 1.3)
}

const renderMegaCard = async (payload) => {
  const { card } = payload
  const mapJob = Number.isFinite(payload.lat) && Number.isFinite(payload.lng)
    ? Promise.race([renderMap({ lat: payload.lat, lng: payload.lng, zoom: 6, width: 300, height: 300 }), new Promise((resolve) => setTimeout(() => resolve(null), MAP_TIMEOUT_MS))]).catch(() => null)
    : Promise.resolve(null)
  const [photo, mapJpeg, big, mid, small] = await Promise.all([fetchPhoto(payload.birdImg), mapJob, font('open-sans-64-white'), font('open-sans-32-white'), font('open-sans-16-white')])

  const canvas = photo.clone().cover({ w: WIDTH, h: HEIGHT }).resize({ w: 48, h: 25 }).resize({ w: WIDTH, h: HEIGHT }).brightness(0.45)
  // The photo, as large as fits beside the map, above the name band.
  const PHOTO = { x: 30, y: 30, w: mapJpeg ? 800 : 1140, h: 430 }
  const front = photo.clone().scaleToFit({ w: PHOTO.w, h: PHOTO.h })
  const fx = PHOTO.x + Math.round((PHOTO.w - front.bitmap.width) / 2)
  const fy = PHOTO.y + Math.round((PHOTO.h - front.bitmap.height) / 2)
  canvas.composite(box(front.bitmap.width + 8, front.bitmap.height + 8, 0xffffffff), fx - 4, fy - 4)
  canvas.composite(front, fx, fy)

  // The badge on the photo's corner.
  const badge = t('en', 'card.abaCode', { code: card.aba })
  const badgeW = measureText(mid, badge) + 36
  canvas.composite(box(badgeW, 58, RED), fx - 4, fy - 4)
  canvas.print({ font: mid, x: fx - 4 + 18, y: fy - 4 + 11, text: badge })

  // Where in the state, and the confirmed strip under it.
  if (mapJpeg) {
    const map = await Jimp.read(Buffer.from(mapJpeg))
    canvas.composite(box(308, 308, 0xffffffff), 856, 30)
    canvas.composite(map, 860, 34)
  }
  if (card.confirmed) {
    const words = t('en', 'card.confirmed')
    // As wide as its words (and at least the map), right-aligned under the map.
    const w = Math.max(mapJpeg ? 308 : 0, measureText(small, words) + 52)
    const x = mapJpeg ? 856 + 308 - w : 30
    const y = mapJpeg ? 350 : 418
    canvas.composite(box(w, 34, GREEN), x, y)
    drawTick(canvas, x + 12, y + 8)
    canvas.print({ font: small, x: x + 34, y: y + 8, text: words })
  }

  // The name across the bottom, with the state, county and date.
  canvas.composite(box(WIDTH, 150, rgbaToInt(0, 0, 0, 200)), 0, HEIGHT - 150)
  const name = payload.comName || ''
  const nameFont = measureText(big, name) <= WIDTH - 80 ? big : mid
  canvas.print({ font: nameFont, x: 40, y: HEIGHT - 150 + (nameFont === big ? 6 : 24), text: name })
  const date = shortDate(payload.obsDt)
  const where = card.county
    ? t('en', 'card.where', { state: card.stateName, county: card.county, date })
    : t('en', 'card.whereNoCounty', { state: card.stateName, date })
  canvas.print({ font: mid, x: 42, y: HEIGHT - 58, text: where })
  return canvas.getBuffer(JimpMime.jpeg, { quality: 86 })
}

/**
 * A finished event's recap card, in the in-app share card's colours (the front end's
 * Recap/shareCard.ts): near-black, gold for the big number and the lifers, the event's name and
 * area, then lifers, stops and miles in boxes. Words only from the recap's public view (no names,
 * no personal spots). Bitmap fonts: the text is folded to plain ASCII.
 */
const INK = rgbaToInt(17, 17, 17, 255)
const GOLD_RGB = [255, 215, 0]
const QUIET_RGB = [201, 196, 182]
const ascii = (value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e\u00b7]/g, '').replace(/\s+/g, ' ').trim()
/** Pure: `text` cut (with ...) to fit `width` in `fnt`. */
const fitText = (fnt, text, width) => {
  if (measureText(fnt, text) <= width) return text
  let cut = text
  while (cut.length > 1 && measureText(fnt, `${cut}...`) > width) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}...`
}
/** Text in a colour: the white bitmap font printed on a clear layer, then every pixel given the colour (its edges keep their softness). */
const inked = (fnt, text, rgb) => {
  const w = Math.max(1, measureText(fnt, text) + 4)
  const layer = new Jimp({ width: w, height: fnt.common.lineHeight, color: 0x00000000 })
  layer.print({ font: fnt, x: 0, y: 0, text })
  const data = layer.bitmap.data
  for (let i = 0; i < data.length; i += 4) { data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2] }
  return layer
}
const outline = (canvas, x, y, w, h, color, weight = 3) => {
  canvas.composite(box(w, weight, color), x, y)
  canvas.composite(box(w, weight, color), x, y + h - weight)
  canvas.composite(box(weight, h, color), x, y)
  canvas.composite(box(weight, h, color), x + w - weight, y)
}

const renderRecapCard = async (recap) => {
  const [huge, big, mid] = await Promise.all([font('open-sans-128-white'), font('open-sans-64-white'), font('open-sans-32-white')])
  const canvas = box(WIDTH, HEIGHT, INK)
  const left = 60
  const right = WIDTH - 60
  const width = right - left
  const gold = rgbaToInt(...GOLD_RGB, 255)

  // The masthead: the app's name, and what kind of event, in gold on the right.
  canvas.print({ font: mid, x: left, y: 36, text: 'Bird Alert!' })
  const kind = inked(mid, t('en', recap.eventKind === 'big_day' ? 'card.recapBigDay' : 'card.recapTrip'), GOLD_RGB)
  canvas.composite(kind, right - kind.bitmap.width, 36)

  // The event's name, and where.
  canvas.print({ font: big, x: left - 2, y: 86, text: fitText(big, ascii(recap.name) || 'Bird Alert!', width) })
  const area = ascii(recap.area).toUpperCase()
  if (area) canvas.composite(inked(mid, fitText(mid, area, width), QUIET_RGB), left, 172)

  // The count, big and gold, with "species" after it.
  const count = inked(huge, String(recap.species), GOLD_RGB)
  const countW = Math.round(count.bitmap.width * 1.4)
  const countH = Math.round(count.bitmap.height * 1.4)
  count.resize({ w: countW, h: countH })
  const countY = 200
  canvas.composite(count, left - 8, countY)
  canvas.print({ font: big, x: left - 8 + countW + 8, y: countY + countH - big.common.lineHeight - 38, text: t('en', 'card.recapSpecies') })

  // Lifers, stops, miles.
  const boxes = [
    { value: recap.lifers, label: t('en', recap.lifers === 1 ? 'card.recapLifer' : 'card.recapLifers'), gold: true },
    { value: recap.stops, label: t('en', recap.stops === 1 ? 'card.recapStop' : 'card.recapStops') },
    ...(Number.isFinite(recap.miles) ? [{ value: recap.miles, label: t('en', recap.miles === 1 ? 'card.recapMile' : 'card.recapMiles') }] : [])
  ]
  const gap = 24
  const boxW = Math.floor((width - gap * (boxes.length - 1)) / boxes.length)
  const boxH = 130
  const boxY = HEIGHT - boxH - 40
  boxes.forEach((b, i) => {
    const x = left + i * (boxW + gap)
    outline(canvas, x, boxY, boxW, boxH, b.gold ? gold : rgbaToInt(...QUIET_RGB, 255))
    const value = String(b.value)
    if (b.gold) canvas.composite(inked(big, value, GOLD_RGB), x + 24, boxY + 4)
    else canvas.print({ font: big, x: x + 24, y: boxY + 4, text: value })
    canvas.composite(inked(mid, fitText(mid, b.label, boxW - 48), b.gold ? GOLD_RGB : QUIET_RGB), x + 26, boxY + 82)
  })
  return canvas.getBuffer(JimpMime.jpeg, { quality: 88 })
}

/** The card for a share's payload: the mega layout for a Code 4 or 5 the HQ desk shared, else the plain one. */
const renderShareCard = (payload) => (cardLayout(payload) === 'mega' ? renderMegaCard(payload) : renderCard(payload.birdImg))

module.exports = { renderCard, renderMegaCard, renderRecapCard, ascii, fitText, renderShareCard, cardLayout, WIDTH, HEIGHT, cardImage }
