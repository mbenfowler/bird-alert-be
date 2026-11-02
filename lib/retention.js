const db = require('./db')
const { lastRun, recordRun } = require('./jobRuns')
const { rollupHotspotWeeks } = require('./hotspotWeeks')
const { pruneTrips } = require('./places')

/**
 * How long the detail behind the odds is kept. The app reads at most 60 days back (detection
 * rates, report times); 90 leaves the odds backtest a month of days with a full window behind them.
 */
const RETENTION_DAYS = 90

/**
 * Keeps the free database plan from filling up (0.5 GB): checklists older than the window are
 * deleted (their species rows go with them), and history rows that old keep only what seasonality
 * needs (region, day, species), losing the place, time and checklist id. Safe to re-run.
 */
const pruneOld = async ({ days = RETENTION_DAYS } = {}) => {
  const cutoff = db.raw(`current_date - ?::int`, [days])
  const checklists = await db('checklists').where('obs_day', '<', cutoff).del()
  const history = await db('region_species_days').where('day', '<', cutoff)
    .where((q) => q.whereNotNull('locId').orWhereNotNull('locName').orWhereNotNull('obsTime').orWhereNotNull('subId'))
    .update({ locId: null, locName: null, obsTime: null, subId: null })
  return { checklists, history }
}

/**
 * Once a day at most: true when it ran. The hotspots' weekly tallies are brought up to date first,
 * so a week is folded in long before its checklists are pruned; hotspot_weeks itself is kept for good.
 */
const pruneDaily = async () => {
  const last = await lastRun('retention')
  if (last && new Date(last.ran_at).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) return null
  const hotspotWeeks = await rollupHotspotWeeks()
  // Trips that ended over a month ago go too.
  const result = { hotspotWeeks, ...await pruneOld(), trips: await pruneTrips() }
  await recordRun('retention', result)
  return result
}

module.exports = { pruneOld, pruneDaily, RETENTION_DAYS }
