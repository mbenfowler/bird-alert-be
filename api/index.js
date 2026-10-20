const db = require('../lib/db')

// GET /api -> { ok, db, time }. Used by the hourly GitHub workflow as an uptime check.
module.exports = async (req, res) => {
  const started = Date.now()
  try {
    await db.raw('select 1')
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ ok: true, db: 'up', latencyMs: Date.now() - started, time: new Date().toISOString() })
  } catch (error) {
    console.error('Health check: database unreachable:', error.message)
    res.setHeader('Cache-Control', 'no-store')
    res.status(503).json({ ok: false, db: 'down', time: new Date().toISOString() })
  }
}
