class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const sendError = (res, status, message) => res.status(status).json({ error: message })

// Wraps a handler: enforces allowed methods and turns thrown errors into JSON responses.
const route = (allowedMethods, handler) => async (req, res) => {
  if (!allowedMethods.includes(req.method)) {
    res.setHeader('Allow', allowedMethods.join(', '))
    return sendError(res, 405, 'Method not allowed')
  }
  try {
    await handler(req, res)
  } catch (error) {
    // What people see of an error comes in their language (?locale= or X-Locale), English otherwise.
    const { translateError, requestLocale } = require('./i18n')
    const locale = requestLocale(req)
    if (error instanceof HttpError) return sendError(res, error.status, translateError(locale, error.message))
    await require('./errors').reportError(`${req.method} ${String(req.url).split('?')[0]}`, error)
    return sendError(res, 500, translateError(locale, 'Internal server error'))
  }
}

const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {})

module.exports = { HttpError, route, sendError, body }
