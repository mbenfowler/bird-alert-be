/**
 * Server errors, kept a week so the hourly health check can notice when they pile up (a failed
 * workflow run emails the repository owner). No outside service; reporting never throws.
 */
const RETENTION_DAYS = 7

const reportError = async (where, error) => {
  const message = String(error && error.message ? error.message : error).slice(0, 1000)
  console.error(`${where}:`, error)
  try {
    const db = require('./db')
    await db('error_log').insert({ where: String(where).slice(0, 200), message })
  } catch (logError) {
    console.error('Error log unavailable:', logError.message)
  }
}

/** Errors in the last `minutes`, grouped by where, newest first; and old rows pruned. */
const recentErrors = async (minutes = 60) => {
  const db = require('./db')
  await db('error_log').where('at', '<', db.raw(`now() - interval '${RETENTION_DAYS} days'`)).del()
  const rows = await db('error_log').where('at', '>', db.raw(`now() - interval '${Number(minutes)} minutes'`))
    .groupBy('where').select('where').count('* as n').max('at as last').orderBy('last', 'desc')
  return rows.map((r) => ({ where: r.where, count: Number(r.n), last: r.last }))
}

module.exports = { reportError, recentErrors }
