const db = require('./db')
const { HttpError } = require('./http')
const { findOrCreateBirds } = require('./enrich')

/**
 * A representative sound per species from xeno-canto (https://xeno-canto.org), a community library
 * of Creative Commons bird recordings. Each species is looked up once and the choice kept in
 * bird_sounds; the recording itself is streamed from xeno-canto by the browser.
 */
const BASE = 'https://xeno-canto.org/api/3/recordings'
const REFRESH_DAYS = 90
const USER_AGENT = 'bird-alert (https://github.com/mbenfowler/bird-alert)'

// Where the app's users are; a local dialect beats a distant one.
const NEARBY = new Set(['United States', 'Canada', 'Mexico'])

const configured = () => Boolean(process.env.XENO_CANTO_KEY)

/** "m:ss" or "h:mm:ss" -> seconds. */
const parseLength = (text) => {
  const parts = String(text || '').split(':').map(Number)
  if (parts.some(Number.isNaN) || !parts.length) return 0
  return parts.reduce((total, part) => total * 60 + part, 0)
}

/** "https://creativecommons.org/licenses/by-nc-sa/4.0/" -> "CC BY-NC-SA 4.0". */
const licenseName = (url) => {
  const match = /licenses\/([a-z-]+)\/([\d.]+)/i.exec(String(url || ''))
  return match ? `CC ${match[1].toUpperCase()} ${match[2]}` : 'CC'
}

/**
 * Higher is better: a song over a call, a clean short clip over a long one, an mp3 over a wav (a
 * minute of wav is megabytes), a recording from this continent over one from elsewhere.
 */
const score = (rec) => {
  const type = String(rec.type || '').toLowerCase()
  const seconds = parseLength(rec.length)
  if (seconds < 3 || seconds > 90) return -Infinity
  let points = 0
  if (/\bsong\b/.test(type)) points += 30
  else if (/\bcall\b/.test(type)) points += 20
  else if (type && !/unknown/.test(type)) points += 10
  points += rec.q === 'A' ? 20 : rec.q === 'B' ? 10 : 0
  if (/\.mp3$/i.test(String(rec['file-name'] || ''))) points += 15
  if (NEARBY.has(rec.cnt)) points += 10
  // 8-30 seconds is the sweet spot; shorter says little, longer is a wait.
  if (seconds >= 8 && seconds <= 30) points += 10
  else if (seconds > 60) points -= 10
  if (rec.auto === 'yes') points -= 5
  if (rec['playback-used'] === 'yes') points -= 3
  return points
}

/** The best of a page of recordings, or null when none is usable. */
const pick = (recordings) => {
  let best = null
  let bestScore = -Infinity
  for (const rec of recordings || []) {
    if (!rec || !rec.file) continue
    const points = score(rec)
    if (points > bestScore) { best = rec; bestScore = points }
  }
  return best
}

const search = async (sciName, quality) => {
  const url = new URL(BASE)
  url.searchParams.set('query', `sp:"${sciName}" q:${quality}`)
  url.searchParams.set('key', process.env.XENO_CANTO_KEY)
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) {
    console.error(`xeno-canto ${res.status} for ${sciName}`)
    throw new HttpError(502, `xeno-canto responded with ${res.status}`)
  }
  const data = await res.json()
  return Array.isArray(data.recordings) ? data.recordings : []
}

/** Searches xeno-canto for the species: A-quality first, then B when nothing there suits. */
const findRecording = async (sciName) => {
  for (const quality of ['A', 'B']) {
    const best = pick(await search(sciName, quality))
    if (best) return best
  }
  return null
}

const toRow = (speciesCode, rec) => ({
  species_code: speciesCode,
  xc_id: rec ? Number(rec.id) : null,
  url: rec ? rec.file : null,
  type: rec ? rec.type || null : null,
  quality: rec ? rec.q || null : null,
  length_s: rec ? parseLength(rec.length) : null,
  recordist: rec ? rec.rec || null : null,
  license: rec ? rec.lic || null : null,
  country: rec ? rec.cnt || null : null,
  fetched_at: db.fn.now()
})

const present = (row) => {
  if (!row.xc_id) return { speciesCode: row.species_code, found: false }
  return {
    speciesCode: row.species_code,
    found: true,
    xcId: row.xc_id,
    url: row.url,
    page: `https://xeno-canto.org/${row.xc_id}`,
    type: row.type,
    quality: row.quality,
    length: row.length_s,
    recordist: row.recordist,
    license: row.license,
    licenseName: licenseName(row.license),
    country: row.country
  }
}

const isFresh = (row) => row && Date.now() - new Date(row.fetched_at).getTime() < REFRESH_DAYS * 86400000

/** The species' representative sound, from the table or, once, from xeno-canto. */
const soundFor = async (speciesCode) => {
  const cached = await db('bird_sounds').where({ species_code: speciesCode }).first()
  if (isFresh(cached)) return present(cached)
  if (!configured()) {
    if (cached) return present(cached)
    throw new HttpError(503, 'Bird sounds are not configured')
  }
  const [bird] = await findOrCreateBirds([speciesCode])
  if (!bird || !bird.sciName) throw new HttpError(404, 'Unknown species')
  const row = toRow(speciesCode, await findRecording(bird.sciName))
  await db('bird_sounds').insert(row).onConflict('species_code').merge()
  return present({ ...row, fetched_at: new Date() })
}

module.exports = { soundFor, pick, score, parseLength, licenseName, configured }
