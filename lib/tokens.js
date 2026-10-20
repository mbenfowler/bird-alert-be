const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const { HttpError } = require('./http')

const secret = process.env.SESSION_SECRET
if (!secret || secret.length < 32) {
  throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters')
}

// Every token carries a purpose so a session cookie can never be replayed as a reset link, and vice versa.
const signToken = (purpose, payload, expiresIn) => jwt.sign({ ...payload, purpose }, secret, { expiresIn })

const verifyToken = (token, purpose) => {
  try {
    const payload = jwt.verify(String(token || ''), secret)
    if (payload.purpose !== purpose) throw new Error('wrong purpose')
    return payload
  } catch (error) {
    throw new HttpError(400, 'This link is invalid or has expired')
  }
}

// Fingerprint of the current password hash. Baked into reset tokens so each one works exactly once.
const passwordVersion = (passwordHash) =>
  crypto.createHash('sha256').update(String(passwordHash || '')).digest('hex').slice(0, 16)

module.exports = { signToken, verifyToken, passwordVersion }
