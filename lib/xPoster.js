const crypto = require('node:crypto')

/**
 * Posting to X as @BirdAlertHQ, with OAuth 1.0a user-context keys (X_API_KEY, X_API_SECRET,
 * X_ACCESS_TOKEN, X_ACCESS_SECRET). Only the owner's approval ever calls this.
 */
const POST_URL = 'https://api.x.com/2/tweets'

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

const configured = () => Boolean(process.env.X_API_KEY && process.env.X_API_SECRET && process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_SECRET)

/** Posts `text`; answers the new post's id. */
const postToX = async (text) => {
  if (!configured()) throw new Error('X isn’t connected yet: add the four X_ keys in Vercel')
  const res = await fetch(POST_URL, {
    method: 'POST',
    headers: {
      Authorization: oauthHeader({ method: 'POST', url: POST_URL, consumerKey: process.env.X_API_KEY, consumerSecret: process.env.X_API_SECRET, token: process.env.X_ACCESS_TOKEN, tokenSecret: process.env.X_ACCESS_SECRET }),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`X said ${res.status}: ${data.detail || data.title || JSON.stringify(data).slice(0, 200)}`)
  return data.data?.id
}

module.exports = { postToX, oauthHeader, configured }
