const crypto = require('crypto')
const db = require('./db')
const { HttpError } = require('./http')

/**
 * Keeps the eBird data behind the API for the Bird Alert app alone. eBird's terms make us
 * responsible for every use of our key and bar publishing its records as they come, so the
 * endpoints that hand them out must not work as an open proxy for anyone on the internet.
 *
 * - The app marks every request with X-Bird-Alert: 1. A page on another site can't send that
 *   header: it isn't a simple header, so the browser asks first (a CORS preflight), and this API
 *   answers no site but its own. A browser elsewhere is turned away; a script can copy the header,
 *   which is what the rate limit is for.
 * - An Origin, when the browser sends one, must be the app's (production, previews, local).
 * - Each address gets PER_MINUTE requests a minute: plenty for the app, a brake on scraping.
 * - Responses are cached here (shared by everyone, so eBird is asked no more often than before)
 *   and only privately in the browser: a copy kept at Vercel's edge would be served to any
 *   request for the same URL without running these checks at all.
 *
 * While API_LOCKDOWN isn't 'on', nothing is refused: requests without the header are only logged,
 * so the app can ship the header first and the switch can follow.
 */
const APP_HEADER = 'x-bird-alert'
const APP_ORIGIN = /^(?:https:\/\/bird-alert\.vercel\.app|https:\/\/bird-alert-git-[a-z0-9-]+-mben\.vercel\.app|http:\/\/localhost(?::\d+)?)$/
const PER_MINUTE = 300

const lockdownOn = () => process.env.API_LOCKDOWN === 'on'

const fromApp = (req) => {
  const origin = req.headers.origin
  return req.headers[APP_HEADER] === '1' && (!origin || APP_ORIGIN.test(String(origin)))
}

const clientAddress = (req) =>
  String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() || 'unknown'

/** Turns away a request that isn't the app's (once the lockdown is on), and one address asking too often. */
const guard = async (req) => {
  if (!fromApp(req)) {
    if (lockdownOn()) throw new HttpError(403, 'This data is only for the Bird Alert app.')
    console.warn(`API guard: no app header on ${String(req.url).split('?')[0]}`)
  }
  if (!lockdownOn()) return
  const key = `api:${clientAddress(req)}`
  const cutoff = new Date(Date.now() - 60_000)
  const [row] = await db('auth_throttle')
    .insert({ key, attempts: 1, window_start: db.fn.now() })
    .onConflict('key')
    .merge({
      attempts: db.raw('case when auth_throttle.window_start < ? then 1 else auth_throttle.attempts + 1 end', [cutoff]),
      window_start: db.raw('case when auth_throttle.window_start < ? then now() else auth_throttle.window_start end', [cutoff])
    })
    .returning('attempts')
  if (Number(row?.attempts ?? row) > PER_MINUTE) throw new HttpError(429, 'Too many requests. Please try again in a minute.')
}

/** A response kept for everyone for ttlSeconds (keyed by what was asked); a stale copy answers if a refresh fails. */
const shared = async (what, ttlSeconds, load) => {
  const key = `api:${crypto.createHash('sha1').update(what).digest('hex')}`
  // The cache is a saving, not a dependency: if the database can't be read or written, answer anyway.
  const row = await db('nearby_cache').where({ key }).first().catch(() => null)
  const value = row && (typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail)
  if (row && Date.now() - new Date(row.fetched_at).getTime() < ttlSeconds * 1000) return value
  let fresh
  try {
    fresh = await load()
  } catch (error) {
    if (row) return value
    throw error
  }
  const detail = JSON.stringify(fresh === undefined ? null : fresh)
  await db('nearby_cache').insert({ key, detail }).onConflict('key').merge({ detail, fetched_at: db.fn.now() }).catch(() => {})
  return fresh
}

/** What a request asks, as a cache key: the path and its parameters in order, less the language (names are put in after). */
const requestKey = (name, query) => `${name}?${Object.keys(query).filter((k) => k !== 'resource' && k !== 'locale').sort()
  .map((k) => `${k}=${Array.isArray(query[k]) ? query[k].join(',') : query[k]}`).join('&')}`

/** "public, max-age=300, s-maxage=…" becomes "private, max-age=300": the browser keeps it, Vercel's edge doesn't. */
const privately = (cacheControl) => {
  const maxAge = /(?:^|,\s*)max-age=(\d+)/.exec(String(cacheControl))
  return maxAge ? `private, max-age=${maxAge[1]}` : 'no-store'
}

/** How long a shared copy lasts: the old edge lifetime (s-maxage); 0 for responses that were never cached. */
const sharedSeconds = (cacheControl) => {
  const m = /s-maxage=(\d+)/.exec(String(cacheControl))
  return m ? Number(m[1]) : 0
}

module.exports = { guard, shared, requestKey, privately, sharedSeconds, fromApp, clientAddress, APP_HEADER, PER_MINUTE }
