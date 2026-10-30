const db = require('./db')
const { HttpError } = require('./http')

const PASSWORD_MIN_LENGTH = 8
// Plain addresses only: no quotes, brackets, commas, semicolons or angle brackets, which mail
// libraries' address parsers have been tricked by into sending somewhere else.
const EMAIL_PATTERN = /^[^\s@"(),:;<>[\]\\]+@[^\s@"(),:;<>[\]\\]+\.[^\s@"(),:;<>[\]\\]+$/

const normalizeEmail = (email) => String(email || '').trim().toLowerCase()

const assertValidEmail = (email) => {
  if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, 'Please enter a valid email address')
  return email
}

const assertValidPassword = (password) => {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    throw new HttpError(400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  }
  return password
}

const findUserByEmail = (email) => db('users').where({ email: normalizeEmail(email) }).first()
const findUserById = (id) => db('users').where({ id }).first()

/** Notes that someone is using the app, at most once an hour so a busy session doesn't write on every check. */
/** 'ios', 'android' or 'desktop' from a user agent; iPadOS Safari calls itself a Mac and counts as desktop. */
const platformOf = (userAgent) => {
  const ua = String(userAgent || '')
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return ua ? 'desktop' : null
}

const touchLastSeen = async (user, { platform = null, installed = null } = {}) => {
  if (!user?.id) return
  const device = {}
  if (platform && platform !== user.last_platform) device.last_platform = platform
  if (typeof installed === 'boolean' && installed !== user.last_installed) device.last_installed = installed
  const recent = user.last_seen_at && Date.now() - new Date(user.last_seen_at).getTime() < 3_600_000
  // At most hourly, except that a different device or install state is noted at once.
  if (recent && !Object.keys(device).length) return
  await db('users').where({ id: user.id }).update({ ...(recent ? {} : { last_seen_at: db.fn.now() }), ...device })
}

// Never let the password hash leave the server.
const sanitizeUser = (user) => {
  if (!user) return null
  // Where someone came from is for counting signups, not something the app sends back.
  const { password_hash, password, signup_source: signupSource, last_seen_at: lastSeenAt, last_platform: lastPlatform, last_installed: lastInstalled, ...safe } = user
  return safe
}

module.exports = {
  touchLastSeen,
  platformOf,
  PASSWORD_MIN_LENGTH,
  normalizeEmail,
  assertValidEmail,
  assertValidPassword,
  findUserByEmail,
  findUserById,
  sanitizeUser
}
