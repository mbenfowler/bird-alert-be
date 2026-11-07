const db = require('./db')
const { lastRun, recordRun } = require('./jobRuns')
const { rollupHotspotWeeks } = require('./hotspotWeeks')

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
  // The API's own cached answers (lib/apiGuard) outlive none of their lifetimes, the longest a week;
  // the scouting-email counts (lib/scoutEmail) only matter for an hour.
  const apiCache = await db('nearby_cache').where((q) => q.where('key', 'like', 'api:%').orWhere('key', 'like', 'scout-email:%'))
    .where('fetched_at', '<', db.raw("now() - interval '8 days'")).del()
  return { checklists, history, apiCache }
}

/**
 * Once a day at most: true when it ran. The hotspots' weekly tallies are brought up to date first,
 * so a week is folded in long before its checklists are pruned; hotspot_weeks itself is kept for good.
 */
/** Whether today's (UTC) retention pass has yet to run. */
const retentionDue = async () => {
  const last = await lastRun('retention')
  return !(last && new Date(last.ran_at).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10))
}

const pruneDaily = async () => {
  if (!await retentionDue()) return null
  const hotspotWeeks = await rollupHotspotWeeks()
  // Events are kept as history: only their organizer deletes one.
  const result = { hotspotWeeks, ...await pruneOld() }
  await recordRun('retention', result)
  return result
}

/**
 * The hourly sync's last step, within its call's time: the pass needs this long before the deadline to
 * start (the weekly rollup and the deletes take a few seconds, more on a busy day). Short of that it
 * says `more`, and the next call, with nothing else left to do, runs it first thing.
 */
const RETENTION_RESERVE_MS = 15_000
const pruneWithin = async (deadline, { prune = pruneDaily, due = retentionDue } = {}) => {
  if (!await due()) return { retention: null, more: false }
  if (Date.now() > deadline - RETENTION_RESERVE_MS) return { retention: null, more: true }
  return { retention: await prune(), more: false }
}

module.exports = { pruneOld, pruneDaily, retentionDue, pruneWithin, RETENTION_DAYS, RETENTION_RESERVE_MS }
