const db = require('./db')
const { addDays, today } = require('./seasonality')
const { recordRun, lastRun } = require('./jobRuns')

/**
 * The ranking grades itself. Once a day each region's species of interest (the watch-list birds of
 * its users and whatever eBird flags notable) have their ranked places recorded; a week later each
 * record is checked against the checklists that followed at that place. Accuracy per band is the
 * number the page can honestly show, and later what tunes the half-lives.
 */
const GRADE_AFTER_DAYS = 7
const MIN_GRADED = 20
const ACCURACY_DAYS = 60
/** Species per region per day; keeps a pass to a few seconds of database work. */
const MAX_SPECIES = 40

/**
 * Species worth predicting in a region: its users' watch lists plus the current notable set,
 * limited to species reported here in the last 30 days (nothing to rank otherwise) and capped.
 */
const speciesOfInterest = async (region, notable = new Set(), asOf = today()) => {
  const saved = await db('saved_birds as s').join('users as u', 'u.id', 's.user_id').where('u.location', region).distinct('s.speciesCode').pluck('s.speciesCode')
  const since = addDays(asOf, -30)
  const recent = new Set([
    ...await db('region_species_days').where({ region }).where('day', '>=', since).distinct('speciesCode').pluck('speciesCode'),
    ...await db('checklist_species as cs').join('checklists as c', 'c.sub_id', 'cs.sub_id').where('c.region', region).where('c.obs_day', '>=', since).distinct('cs.species_code').pluck('cs.species_code')
  ])
  return [...new Set([...saved, ...notable])].filter((code) => recent.has(code)).slice(0, MAX_SPECIES)
}

/** Stores today's places for the species; a second call the same day changes nothing. */
const recordPredictions = async (region, speciesCode, asOf, result) => {
  const rows = result.places.map((p) => ({
    region, species_code: speciesCode, loc_id: p.locId, as_of: asOf, band: p.band, score: p.score, detection: p.effort.detection, effort: p.effort.checklists, class: result.class
  }))
  if (!rows.length) return 0
  await db('place_predictions').insert(rows).onConflict(['region', 'species_code', 'loc_id', 'as_of']).ignore()
  return rows.length
}

/**
 * Grades every prediction old enough: outcome true if a checklist at the place in the week after
 * had the species, false if checklists were made there and none had it, null (unvisited) if nobody
 * birded the place. Returns how many were graded.
 */
const gradeDue = async (asOf = today()) => {
  const due = await db('place_predictions').whereNull('graded_at').where('as_of', '<=', addDays(asOf, -GRADE_AFTER_DAYS)).select('id', 'region', 'species_code', 'loc_id', db.raw('to_char(as_of, \'YYYY-MM-DD\') as as_of'))
  for (const p of due) {
    const from = addDays(p.as_of, 1)
    const to = addDays(p.as_of, GRADE_AFTER_DAYS)
    const visits = Number((await db('checklists').where({ region: p.region, loc_id: p.loc_id }).whereBetween('obs_day', [from, to]).count('* as n').first()).n)
    let outcome = null
    if (visits > 0) {
      const hit = await db('checklist_species as cs').join('checklists as c', 'c.sub_id', 'cs.sub_id')
        .where({ 'c.region': p.region, 'c.loc_id': p.loc_id, 'cs.species_code': p.species_code }).whereBetween('c.obs_day', [from, to]).first('cs.sub_id')
      outcome = Boolean(hit)
    }
    await db('place_predictions').where({ id: p.id }).update({ visits, outcome, graded_at: db.fn.now() })
  }
  return due.length
}

/** Per band, over the last two months of graded, visited predictions: how often the bird was there. */
const accuracy = async (region, { asOf = today(), days = ACCURACY_DAYS } = {}) => {
  const rows = await db('place_predictions').where({ region }).whereNotNull('graded_at').whereNotNull('outcome').where('as_of', '>=', addDays(asOf, -days))
    .groupBy('band').select('band').count('* as n').sum({ hits: db.raw('case when outcome then 1 else 0 end') })
  const out = {}
  for (const r of rows) {
    const n = Number(r.n)
    const hits = Number(r.hits)
    out[r.band] = { n, hits, rate: n ? Math.round((hits / n) * 100) : null, enough: n >= MIN_GRADED }
  }
  return out
}

/**
 * The daily pass for a region, called from the hourly sync: records predictions once a day and
 * grades what is due. `where(region, code)` is injected so the module stays free of a cycle.
 */
const dailyPass = async (region, { where, notable = new Set(), asOf = today(), deadline = Infinity } = {}) => {
  const kind = `predictions:${region}`
  const last = await lastRun(kind)
  if (last && last.detail && last.detail.day === asOf) return { region, skipped: true }
  const species = await speciesOfInterest(region, notable, asOf)
  let recorded = 0
  let predicted = 0
  for (const code of species) {
    if (Date.now() > deadline) break
    try {
      recorded += await recordPredictions(region, code, asOf, await where(region, code, { asOf, live: false }))
      predicted += 1
    } catch (error) {
      console.error(`Prediction for ${code} in ${region} failed:`, error.message)
    }
  }
  const graded = await gradeDue(asOf)
  await recordRun(kind, { day: asOf, species: species.length, predicted, recorded, graded })
  return { region, species: species.length, predicted, recorded, graded }
}

module.exports = { speciesOfInterest, recordPredictions, gradeDue, accuracy, dailyPass, MIN_GRADED, GRADE_AFTER_DAYS, MAX_SPECIES }
