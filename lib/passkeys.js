const {
  generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse
} = require('@simplewebauthn/server')
const db = require('./db')
const { HttpError } = require('./http')
const { signToken, verifyToken } = require('./tokens')

/**
 * Passkeys. A passkey belongs to the site it was made on (its "RP ID"): production, a preview, or
 * localhost, each its own. The challenge travels to the browser and back inside a short-lived
 * signed token, so nothing needs storing between the two steps.
 */
const RP_NAME = 'Bird Alert!'
const CHALLENGE_SECONDS = 300
const ALLOWED_HOSTS = /^(bird-alert(-[a-z0-9-]+)?\.vercel\.app|localhost)$/

/** The page's origin and the site a passkey is bound to, from the request; anything else is refused. */
const siteOf = (req) => {
  const origin = String(req.headers.origin || '')
  let host
  try { host = new URL(origin).hostname } catch { throw new HttpError(400, 'Unknown origin') }
  if (!ALLOWED_HOSTS.test(host)) throw new HttpError(400, 'Unknown origin')
  return { origin, rpID: host }
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64url')
const unb64 = (text) => new Uint8Array(Buffer.from(text, 'base64url'))

/** A friendly name from the browser's user agent: "iPhone", "Mac", "Android phone", "Windows PC". */
const deviceName = (ua = '') => /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone'
  : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /CrOS/.test(ua) ? 'Chromebook' : 'This device'

const registrationOptions = async (user, req) => {
  const { rpID } = siteOf(req)
  const existing = await db('passkeys').where({ user_id: user.id, rp_id: rpID }).select('id', 'transports')
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.email,
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports || undefined })),
    // Discoverable, so signing in needs no email typed first.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
  })
  return { options, token: signToken('passkey-register', { sub: user.id, challenge: options.challenge, rpID }, CHALLENGE_SECONDS) }
}

const register = async (user, req, { response, token }) => {
  const { origin, rpID } = siteOf(req)
  const claim = verifyToken(token, 'passkey-register')
  if (!claim || claim.sub !== user.id || claim.rpID !== rpID) throw new HttpError(400, 'That took too long. Try again.')
  let verification
  try {
    verification = await verifyRegistrationResponse({ response, expectedChallenge: claim.challenge, expectedOrigin: origin, expectedRPID: rpID })
  } catch (error) { throw new HttpError(400, `The passkey couldn’t be checked: ${error.message}`) }
  if (!verification.verified) throw new HttpError(400, 'The passkey couldn’t be checked')
  const { credential, credentialBackedUp } = verification.registrationInfo
  await db('passkeys').insert({
    id: credential.id,
    user_id: user.id,
    public_key: b64(credential.publicKey),
    counter: credential.counter,
    transports: JSON.stringify(credential.transports || []),
    rp_id: rpID,
    name: deviceName(req.headers['user-agent']),
    backed_up: credentialBackedUp
  }).onConflict('id').ignore()
  return listFor(user.id)
}

const authenticationOptions = async (req) => {
  const { rpID } = siteOf(req)
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred', allowCredentials: [] })
  return { options, token: signToken('passkey-login', { challenge: options.challenge, rpID }, CHALLENGE_SECONDS) }
}

/** Checks a passkey sign-in; answers the user it belongs to. */
const authenticate = async (req, { response, token }) => {
  const { origin, rpID } = siteOf(req)
  const claim = verifyToken(token, 'passkey-login')
  if (!claim || claim.rpID !== rpID) throw new HttpError(400, 'That took too long. Try again.')
  const stored = response?.id ? await db('passkeys').where({ id: response.id, rp_id: rpID }).first() : null
  if (!stored) throw new HttpError(401, 'That passkey isn’t on any account here. Sign in with your password, then add it again.')
  let verification
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: claim.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: stored.id, publicKey: unb64(stored.public_key), counter: Number(stored.counter), transports: stored.transports || undefined }
    })
  } catch (error) { throw new HttpError(401, `The passkey couldn’t be checked: ${error.message}`) }
  if (!verification.verified) throw new HttpError(401, 'The passkey couldn’t be checked')
  await db('passkeys').where({ id: stored.id }).update({ counter: verification.authenticationInfo.newCounter, last_used_at: db.fn.now() })
  return stored.user_id
}

const listFor = (userId) => db('passkeys').where({ user_id: userId }).orderBy('created_at')
  .select('id', 'name', 'rp_id as site', 'created_at as createdAt', 'last_used_at as lastUsedAt')

const remove = (userId, id) => db('passkeys').where({ user_id: userId, id: String(id || '') }).del()

module.exports = { registrationOptions, register, authenticationOptions, authenticate, listFor, remove, deviceName, siteOf }
