const crypto = require('node:crypto')
const db = require('./db')
const { HttpError } = require('./http')
const { appUrl, APP_BASE_URL } = require('./appUrl')

/**
 * Shared links: a snapshot of a route or a sighting, readable by anyone with the link and shown
 * with a proper preview card where it is pasted (texts, Facebook, Slack). The snapshot is taken
 * from what the sharer's page already shows and cleaned here; the bird's name and photo come from
 * our own birds table. Nothing here calls eBird, so a link passed round a club costs nothing.
 * A route's starting point is never shared: it is often someone's home.
 */
const DAILY_LIMIT = 50
const MAX_STOPS = 8
const MAX_GEOMETRY = 400
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const newId = () => Array.from(crypto.randomBytes(10), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')
const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '') || null
const coord = (value, limit) => { const n = Number(value); if (!Number.isFinite(n) || Math.abs(n) > limit) throw new HttpError(400, 'Invalid point'); return Math.round(n * 1e5) / 1e5 }
const minutesMiles = (d) => (d && Number.isFinite(Number(d.minutes)) && Number.isFinite(Number(d.miles)) ? { minutes: Math.round(Number(d.minutes)), miles: Math.round(Number(d.miles) * 10) / 10 } : null)

const cleanRoute = (input) => {
  const stops = Array.isArray(input.stops) ? input.stops : []
  if (!stops.length || stops.length > MAX_STOPS) throw new HttpError(400, `A route has 1 to ${MAX_STOPS} stops`)
  const drive = input.drive && typeof input.drive === 'object' ? input.drive : null
  return {
    regionName: text(input.regionName, 60),
    title: text(input.title, 80),
    covers: text(input.covers, 120),
    stops: stops.map((s) => ({
      name: text(s.name, 120) || 'Stop',
      lat: coord(s.lat, 90),
      lng: coord(s.lng, 180),
      locId: /^L\d{1,12}$/.test(String(s.locId || '')) ? s.locId : null,
      detail: text(s.detail, 120),
      birds: (Array.isArray(s.birds) ? s.birds : []).slice(0, 4).map((b) => text(b, 60)).filter(Boolean)
    })),
    drive: drive ? {
      ...minutesMiles(drive),
      legs: (Array.isArray(drive.legs) ? drive.legs : []).slice(0, MAX_STOPS).map(minutesMiles),
      geometry: (Array.isArray(drive.geometry) ? drive.geometry : []).slice(0, MAX_GEOMETRY).map((p) => [coord(p?.[0], 90), coord(p?.[1], 180)])
    } : null
  }
}

const cleanSighting = async (input) => {
  const code = String(input.speciesCode || '')
  if (!/^[a-z0-9]{3,12}$/i.test(code)) throw new HttpError(400, 'Invalid species')
  const bird = await db('birds').where({ speciesCode: code }).first('comName', 'sciName', 'birdImg', 'wikiURL')
  if (!bird) throw new HttpError(404, 'Unknown bird')
  const obsDt = String(input.obsDt || '')
  return {
    speciesCode: code,
    comName: bird.comName,
    sciName: bird.sciName,
    birdImg: bird.birdImg && /^https:\/\//.test(bird.birdImg) ? bird.birdImg : null,
    locName: text(input.locName, 120) || 'A reported location',
    lat: coord(input.lat, 90),
    lng: coord(input.lng, 180),
    obsDt: /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(obsDt) ? obsDt : null,
    howMany: Number.isFinite(Number(input.howMany)) && Number(input.howMany) > 0 ? Math.min(9999, Math.round(Number(input.howMany))) : null,
    subId: /^S\d{5,12}$/.test(String(input.subId || '')) ? input.subId : null,
    regionName: text(input.regionName, 60)
  }
}

/** Makes a share link; a person can make fifty a day. */
const createShare = async (userId, input = {}) => {
  const kind = input.kind
  if (kind !== 'route' && kind !== 'sighting') throw new HttpError(400, 'kind must be route or sighting')
  const today = await db('shares').where({ user_id: userId }).where('created_at', '>', db.raw("now() - interval '1 day'")).count('* as n').first()
  if (Number(today.n) >= DAILY_LIMIT) throw new HttpError(429, 'That’s a lot of sharing for one day. Try again tomorrow.')
  const payload = kind === 'route' ? cleanRoute(input) : await cleanSighting(input)
  const id = newId()
  await db('shares').insert({ id, kind, user_id: userId, payload: JSON.stringify(payload) })
  return { id, kind, url: appUrl(`/share/${kind === 'route' ? 'r' : 's'}/${id}`) }
}

const getShare = async (id) => {
  if (!/^[A-Za-z0-9]{6,12}$/.test(String(id || ''))) throw new HttpError(404, 'Not found')
  const row = await db('shares').where({ id }).first('id', 'kind', 'payload', 'created_at')
  if (!row) throw new HttpError(404, 'This link has expired or never existed')
  db('shares').where({ id }).increment('views', 1).catch(() => {})
  return { id: row.id, kind: row.kind, createdAt: row.created_at, ...row.payload }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const when = (obsDt) => {
  if (!obsDt) return null
  const d = new Date(`${obsDt.slice(0, 10)}T12:00:00Z`)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** What a preview card says for a share: title, description, picture. */
const previewFor = (share) => {
  if (share.kind === 'route') {
    const names = share.stops.map((s) => s.name.replace(/^Lake Lanier--/, ''))
    const drive = share.drive?.minutes ? ` · ${share.drive.minutes} min, ${share.drive.miles} mi` : ''
    const pins = share.stops.map((s, i) => `${s.lat.toFixed(4)},${s.lng.toFixed(4)},${i + 1}`).join(';')
    return {
      title: share.title || `A birding route${share.regionName ? ` in ${share.regionName}` : ''}: ${share.stops.length} ${share.stops.length === 1 ? 'stop' : 'stops'}`,
      description: `${names.join(' → ')}${drive}.${share.covers ? ` ${share.covers}` : ''}`,
      image: `${APP_BASE_URL}/api/map?pins=${encodeURIComponent(pins)}`
    }
  }
  const day = when(share.obsDt)
  return {
    title: `${share.comName} reported at ${share.locName}`,
    description: `${share.howMany && share.howMany > 1 ? `${share.howMany} seen` : 'Seen'}${day ? ` on ${day}` : ''}${share.regionName ? ` in ${share.regionName}` : ''}. Shared from Bird Alert!`,
    image: share.birdImg || `${APP_BASE_URL}/api/map?lat=${share.lat.toFixed(4)}&lng=${share.lng.toFixed(4)}&zoom=13`
  }
}

/** The app's page with the share's own title and preview tags in its head. */
const injectMeta = (html, share, url) => {
  const p = previewFor(share)
  const tags = [
    `<title>${esc(p.title)} · Bird Alert!</title>`,
    `<meta name="description" content="${esc(p.description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Bird Alert!" />`,
    `<meta property="og:title" content="${esc(p.title)}" />`,
    `<meta property="og:description" content="${esc(p.description)}" />`,
    `<meta property="og:image" content="${esc(p.image)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`
  ].join('\n    ')
  return html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta (name="description"|property="og:[a-z_:]+"|name="twitter:[a-z]+")[^>]*>/gi, '')
    .replace(/<link rel="canonical"[^>]*>/i, '')
    .replace(/<\/head>/i, `    ${tags}\n  </head>`)
}

// The page shell, fetched from the front end that asked (a preview or production), kept briefly.
const shells = new Map()
const FRONT_END = /^bird-alert(-[a-z0-9-]+)?\.vercel\.app$/
const shellFor = async (host) => {
  const origin = host && FRONT_END.test(host) ? `https://${host}` : APP_BASE_URL
  const hit = shells.get(origin)
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return { origin, html: hit.html }
  const res = await fetch(`${origin}/index.html`, { headers: { 'User-Agent': 'bird-alert-share' } })
  if (!res.ok) throw new Error(`Shell ${res.status}`)
  const html = await res.text()
  shells.set(origin, { at: Date.now(), html })
  return { origin, html }
}

/** The HTML for /share/r/:id or /share/s/:id: the app, with the share's preview card in its head. */
const sharePage = async ({ kind, id }, req) => {
  const host = String(req?.headers?.['x-forwarded-host'] || '').split(',')[0].trim()
  const { origin, html } = await shellFor(host)
  const path = `/share/${kind === 'r' ? 'r' : 's'}/${encodeURIComponent(String(id || ''))}`
  try {
    const share = await getShare(id)
    return injectMeta(html, share, `${origin}${path}`)
  } catch (error) {
    if (error.status === 404) return html
    throw error
  }
}

module.exports = { createShare, getShare, sharePage, previewFor, injectMeta, cleanRoute, newId }
