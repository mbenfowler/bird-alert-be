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

// Never let the password hash leave the server.
const sanitizeUser = (user) => {
  if (!user) return null
  // Where someone came from is for counting signups, not something the app sends back.
  const { password_hash, password, signup_source: signupSource, ...safe } = user
  return safe
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  normalizeEmail,
  assertValidEmail,
  assertValidPassword,
  findUserByEmail,
  findUserById,
  sanitizeUser
}
