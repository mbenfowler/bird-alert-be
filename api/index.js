const db = require('../lib/db')
const { recentErrors } = require('../lib/errors')

// Errors in the last hour at which the strict health check fails (and the workflow emails the owner).
const ERROR_ALARM = 5

// GET /api -> { ok, db, latencyMs, errors: { lastHour, by } , time }. The hourly GitHub workflow calls
// it with ?strict=1, which answers 503 when the database is down or errors have piled up.
module.exports = async (req, res) => {
  const started = Date.now()
  res.setHeader('Cache-Control', 'no-store')
  try {
    await db.raw('select 1')
    const by = await recentErrors(60)
    const lastHour = by.reduce((sum, e) => sum + e.count, 0)
    const ok = !(req.query && req.query.strict) || lastHour < ERROR_ALARM
    res.status(ok ? 200 : 503).json({ ok, db: 'up', latencyMs: Date.now() - started, errors: { lastHour, by }, time: new Date().toISOString() })
  } catch (error) {
    console.error('Health check: database unreachable:', error.message)
    res.status(503).json({ ok: false, db: 'down', time: new Date().toISOString() })
  }
}
