const { route, body, HttpError } = require('../../lib/http')
const db = require('../../lib/db')
const {
  normalizeEmail, assertValidEmail, assertValidPassword, findUserByEmail, findUserById, sanitizeUser
} = require('../../lib/users')
const {
  hashPassword, verifyPassword, createSession, clearSession, getSessionUser, requireUser
} = require('../../lib/auth')
const { verifyToken, passwordVersion } = require('../../lib/tokens')
const { sendConfirmationEmail, sendPasswordResetEmail } = require('../../lib/mailer')
const { assertNotThrottled, recordAttempt, clearAttempts } = require('../../lib/throttle')
const passkeys = require('../../lib/passkeys')
const { assertRegion } = require('../../lib/ebird')

/** A signup may bring the county the visitor was looking at, so they land on their birds. */
const signupPlace = (state, location) => {
  if (!location) return { state: '', location: '' }
  const code = assertRegion(String(location))
  const m = code.match(/^US-([A-Z]{2})-[A-Z0-9]{1,5}$/)
  if (!m || (state && String(state).toUpperCase() !== m[1])) return { state: '', location: '' }
  return { state: m[1], location: code }
}
/** The user as the app sees them, with whether they have a passkey yet. */
const withPasskeys = async (user) => ({ ...sanitizeUser(user), hasPasskey: Boolean(await db('passkeys').where({ user_id: user.id }).first('id')) })

const EMAIL_PREFERENCES = ['alert_digest_email_enabled', 'rare_sightings_email_enabled', 'migration_email_enabled']

const actions = {
  // GET /api/auth/exists?email= -> { userExists }
  exists: {
    methods: ['GET'],
    handler: async (req, res) => {
      const email = assertValidEmail(normalizeEmail(req.query.email))
      const user = await findUserByEmail(email)
      res.status(200).json({ userExists: Boolean(user) })
    }
  },

  // POST /api/auth/signup { email, password } -> user (sets session cookie)
  signup: {
    methods: ['POST'],
    handler: async (req, res) => {
      const { email: rawEmail, password, state, location } = body(req)
      const email = assertValidEmail(normalizeEmail(rawEmail))
      assertValidPassword(password)
      if (await findUserByEmail(email)) throw new HttpError(409, 'An account with that email already exists')

      const [user] = await db('users')
        .insert({ email, password_hash: await hashPassword(password), ...signupPlace(state, location) })
        .returning('*')

      createSession(res, user)
      sendConfirmationEmail(user).catch((error) => console.error('Confirmation email failed:', error))
      res.status(201).json(await withPasskeys(user))
    }
  },

  // POST /api/auth/login { email, password } -> user (sets session cookie)
  login: {
    methods: ['POST'],
    handler: async (req, res) => {
      const email = normalizeEmail(body(req).email)
      const { password } = body(req)
      await assertNotThrottled('login', email)
      const user = await findUserByEmail(email)
      const ok = user && (await verifyPassword(String(password || ''), user.password_hash))
      if (!ok) {
        await recordAttempt('login', email)
        throw new HttpError(401, 'Incorrect email or password')
      }
      await clearAttempts('login', email)
      createSession(res, user)
      res.status(200).json(await withPasskeys(user))
    }
  },

  // POST /api/auth/passkey-login-options -> { options, token }; then
  // POST /api/auth/passkey-login { response, token } -> user (sets session cookie). No email needed.
  'passkey-login-options': {
    methods: ['POST'],
    handler: async (req, res) => res.status(200).json(await passkeys.authenticationOptions(req))
  },
  'passkey-login': {
    methods: ['POST'],
    handler: async (req, res) => {
      const userId = await passkeys.authenticate(req, body(req))
      const user = await findUserById(userId)
      if (!user) throw new HttpError(401, 'That account no longer exists')
      createSession(res, user)
      res.status(200).json(await withPasskeys(user))
    }
  },
  // POST /api/auth/passkey-register-options (logged in) -> { options, token }; then
  // POST /api/auth/passkey-register { response, token } -> the account's passkeys
  'passkey-register-options': {
    methods: ['POST'],
    handler: async (req, res) => res.status(200).json(await passkeys.registrationOptions(await requireUser(req), req))
  },
  'passkey-register': {
    methods: ['POST'],
    handler: async (req, res) => res.status(201).json(await passkeys.register(await requireUser(req), req, body(req)))
  },
  // GET /api/auth/passkeys -> [{ id, name, site, createdAt, lastUsedAt }]; DELETE /api/auth/passkeys?id= -> the rest
  passkeys: {
    methods: ['GET', 'DELETE'],
    handler: async (req, res) => {
      const user = await requireUser(req)
      res.setHeader('Cache-Control', 'no-store')
      if (req.method === 'DELETE') await passkeys.remove(user.id, req.query.id)
      res.status(200).json(await passkeys.listFor(user.id))
    }
  },

  // POST /api/auth/logout
  logout: {
    methods: ['POST'],
    handler: async (req, res) => {
      clearSession(res)
      res.status(204).end()
    }
  },

  // GET /api/auth/me -> user | 401
  me: {
    methods: ['GET'],
    handler: async (req, res) => {
      const user = await getSessionUser(req)
      if (!user) throw new HttpError(401, 'Not logged in')
      // Each visit renews the session, so only thirty days away logs someone out.
      createSession(res, user)
      res.status(200).json(await withPasskeys(user))
    }
  },

  // POST /api/auth/forgot { email } -> 200 regardless, so emails can't be enumerated here
  forgot: {
    methods: ['POST'],
    handler: async (req, res) => {
      const email = normalizeEmail(body(req).email)
      await assertNotThrottled('forgot', email)
      await recordAttempt('forgot', email)
      const user = await findUserByEmail(email)
      if (user) await sendPasswordResetEmail(user)
      res.status(200).json({ ok: true })
    }
  },

  // POST /api/auth/reset { token, password }
  reset: {
    methods: ['POST'],
    handler: async (req, res) => {
      const { token, password } = body(req)
      assertValidPassword(password)
      const { sub, pv } = verifyToken(token, 'reset')
      const user = await findUserById(sub)
      if (!user || passwordVersion(user.password_hash) !== pv) {
        throw new HttpError(400, 'This reset link has already been used or has expired')
      }
      await db('users').where({ id: user.id }).update({ password_hash: await hashPassword(password), updated_at: new Date() })
      res.status(200).json({ ok: true })
    }
  },

  // POST /api/auth/confirm { token }
  confirm: {
    methods: ['POST'],
    handler: async (req, res) => {
      const { sub, email } = verifyToken(body(req).token, 'confirm')
      // Only flips the flag if the address in the token is still the account's address.
      const updated = await db('users').where({ id: sub, email }).update({ email_confirmed: true, updated_at: new Date() })
      if (!updated) throw new HttpError(400, 'This confirmation link no longer matches your account email')
      res.status(200).json({ ok: true })
    }
  },

  // POST /api/auth/resend-confirmation (logged in)
  'resend-confirmation': {
    methods: ['POST'],
    handler: async (req, res) => {
      const user = await requireUser(req)
      if (user.email_confirmed) throw new HttpError(400, 'Your email is already confirmed')
      await sendConfirmationEmail(user)
      res.status(200).json({ ok: true })
    }
  },

  // POST /api/auth/unsubscribe { token } -> turns off one email preference without logging in
  unsubscribe: {
    methods: ['POST'],
    handler: async (req, res) => {
      const { sub, emailType } = verifyToken(body(req).token, 'unsubscribe')
      if (!EMAIL_PREFERENCES.includes(emailType)) throw new HttpError(400, 'Unknown email type')
      await db('users').where({ id: sub }).update({ [emailType]: false, updated_at: new Date() })
      res.status(200).json({ ok: true, emailType })
    }
  }
}

module.exports = async (req, res) => {
  const action = actions[req.query.action]
  if (!action) return res.status(404).json({ error: 'Not found' })
  return route(action.methods, action.handler)(req, res)
}
