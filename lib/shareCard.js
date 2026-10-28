const { Jimp, JimpMime } = require('jimp')
const { cardImage } = require('./shares')

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

module.exports = { renderCard, WIDTH, HEIGHT, cardImage }
