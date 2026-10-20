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
    if (error instanceof HttpError) return sendError(res, error.status, error.message)
    console.error(`${req.method} ${req.url} failed:`, error)
    return sendError(res, 500, 'Internal server error')
  }
}

const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {})

module.exports = { HttpError, route, sendError, body }
