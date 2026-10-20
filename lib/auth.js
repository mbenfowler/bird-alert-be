const bcrypt = require('bcryptjs')
const { signToken, verifyToken, passwordVersion } = require('./tokens')
const { findUserById } = require('./users')
const { HttpError } = require('./http')

const COOKIE_NAME = 'bird_alert_session'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
const BCRYPT_ROUNDS = 10

const isProduction = process.env.NODE_ENV === 'production'

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS)
const verifyPassword = (password, hash) => (hash ? bcrypt.compare(password, hash) : Promise.resolve(false))

const serializeCookie = (value, maxAge) => {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ]
  if (isProduction) parts.push('Secure')
  return parts.join('; ')
}

const parseCookies = (req) => {
  const header = req.headers.cookie || ''
  return Object.fromEntries(
    header.split(';').map((pair) => {
      const index = pair.indexOf('=')
      if (index === -1) return [pair.trim(), '']
      return [pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim())]
    })
  )
}

const createSession = (res, user) => {
  // Binding the session to the current password hash logs every device out when the password changes.
  const token = signToken('session', { sub: user.id, pv: passwordVersion(user.password_hash) }, SESSION_TTL_SECONDS)
  res.setHeader('Set-Cookie', serializeCookie(token, SESSION_TTL_SECONDS))
}

const clearSession = (res) => {
  res.setHeader('Set-Cookie', serializeCookie('', 0))
}

// Returns the full user row for the current session, or null.
const getSessionUser = async (req) => {
  const token = parseCookies(req)[COOKIE_NAME]
  if (!token) return null
  try {
    const { sub, pv } = verifyToken(token, 'session')
    const user = await findUserById(sub)
    if (!user || pv !== passwordVersion(user.password_hash)) return null
    return user
  } catch (error) {
    return null
  }
}

const requireUser = async (req) => {
  const user = await getSessionUser(req)
  if (!user) throw new HttpError(401, 'Please log in')
  return user
}

module.exports = { hashPassword, verifyPassword, createSession, clearSession, getSessionUser, requireUser }
