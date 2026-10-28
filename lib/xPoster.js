const crypto = require('node:crypto')

/**
 * Posting to X as @BirdAlertHQ, with OAuth 1.0a user-context keys (X_API_KEY, X_API_SECRET,
 * X_ACCESS_TOKEN, X_ACCESS_SECRET). Only the owner's approval ever calls this.
 */
const POST_URL = 'https://api.x.com/2/tweets'

// Keys pasted into a dashboard often carry a stray space, line break or quotes; none of those is ever part of a key.
const key = (name) => String(process.env[name] || '').trim().replace(/^["']|["']$/g, '').trim()
const keys = () => ({ consumerKey: key('X_API_KEY'), consumerSecret: key('X_API_SECRET'), token: key('X_ACCESS_TOKEN'), tokenSecret: key('X_ACCESS_SECRET') })

/** What each key looks like, never what it is: lengths, and whether the access token has its usual "number-letters" form. */
const keyShapes = () => {
  const k = keys()
  const raw = (n) => String(process.env[n] || '')
  const padded = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'].filter((n) => raw(n) && raw(n) !== key(n))
  return {
    apiKey: k.consumerKey.length, apiSecret: k.consumerSecret.length, accessToken: k.token.length, accessSecret: k.tokenSecret.length,
    tokenLooksRight: /^\d+-[A-Za-z0-9]+$/.test(k.token),
    padded
  }
}

const enc = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** The OAuth 1.0a Authorization header for a request (a JSON body is not part of the signature). */
const oauthHeader = ({ method, url, params = {}, consumerKey, consumerSecret, token, tokenSecret, nonce = crypto.randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000) }) => {
  const oauth = { oauth_consumer_key: consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(timestamp), oauth_token: token, oauth_version: '1.0' }
  const all = { ...params, ...oauth }
  const paramString = Object.keys(all).sort().map((k) => `${enc(k)}=${enc(all[k])}`).join('&')
  const base = `${method.toUpperCase()}&${enc(url)}&${enc(paramString)}`
  const signature = crypto.createHmac('sha1', `${enc(consumerSecret)}&${enc(tokenSecret)}`).update(base).digest('base64')
  return 'OAuth ' + Object.entries({ ...oauth, oauth_signature: signature }).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ')
}

const configured = () => { const k = keys(); return Boolean(k.consumerKey && k.consumerSecret && k.token && k.tokenSecret) }

/** Posts `text`; answers the new post's id. */
const postToX = async (text) => {
  if (!configured()) throw new Error('X isn’t connected yet: add the four X_ keys in Vercel')
  const res = await fetch(POST_URL, {
    method: 'POST',
    headers: {
      Authorization: oauthHeader({ method: 'POST', url: POST_URL, ...keys() }),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`X said ${res.status}: ${data.detail || data.title || JSON.stringify(data).slice(0, 200)}`)
  return data.data?.id
}

// Which account the keys belong to, asked at most every ten minutes.
let whoCache = null
const whoAmI = async () => {
  if (!configured()) return { ok: false, reason: 'X isn’t connected yet: add the four X_ keys in Vercel' }
  if (whoCache && Date.now() - whoCache.at < 10 * 60 * 1000) return whoCache.result
  const url = 'https://api.x.com/2/users/me'
  let result
  try {
    const res = await fetch(url, { headers: { Authorization: oauthHeader({ method: 'GET', url, ...keys() }) } })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.data?.username) result = { ok: true, username: data.data.username }
    else {
      const s = keyShapes()
      const hints = []
      if (s.padded.length) hints.push(`${s.padded.join(', ')} had spaces or quotes around ${s.padded.length === 1 ? 'it' : 'them'} (now ignored)`)
      if (!s.tokenLooksRight) hints.push('X_ACCESS_TOKEN doesn’t look like an access token (those start with a long number and a dash): it may be swapped with another key')
      if (s.apiSecret && s.apiKey && s.apiKey > s.apiSecret) hints.push('X_API_KEY is longer than X_API_SECRET: they may be swapped')
      result = { ok: false, reason: `X said ${res.status}${data.detail ? `: ${data.detail}` : ''}. Key lengths: API key ${s.apiKey}, API secret ${s.apiSecret}, access token ${s.accessToken}, access secret ${s.accessSecret} (usually about 25, 50, 50 and 45).${hints.length ? ' ' + hints.join('. ') + '.' : ''} If they all look right, regenerate the access token and secret (after the API key, and with Read and write), update both in Vercel, and redeploy.` }
    }
  } catch (error) { result = { ok: false, reason: `Couldn’t reach X: ${error.message}` } }
  // Only a success is remembered, so a fixed key shows up on the very next load.
  if (result.ok) whoCache = { at: Date.now(), result }
  return result
}

module.exports = { postToX, oauthHeader, configured, whoAmI, keyShapes, keys }
