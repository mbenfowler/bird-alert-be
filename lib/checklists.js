const { waitUntil } = require('@vercel/functions')
const db = require('./db')
const ebird = require('./ebird')
const { COUNTY_REGION } = require('./regions')

/**
 * The region's checklists, kept as they are submitted. The newest 200 are listed each run (that is
 * about seven weeks for a county like Hall), new ones are stored, and a batch of the newest that
 * have not been fetched in full get their species, counts, notes and media counts. Over time this
 * is the ground truth for a location: how often it is birded and how often each species turns up.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const listRow = (region, item) => {
  const iso = String(item.isoObsDate || '')
  const day = /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null
  if (!day || !item.subId || !item.locId) return null
  const loc = item.loc || {}
  return {
    sub_id: item.subId,
    region,
    loc_id: item.locId,
    loc_name: loc.locName || loc.name || null,
    lat: Number.isFinite(loc.latitude) ? loc.latitude : (Number.isFinite(loc.lat) ? loc.lat : null),
    lng: Number.isFinite(loc.longitude) ? loc.longitude : (Number.isFinite(loc.lng) ? loc.lng : null),
    is_hotspot: Boolean(loc.isHotspot),
    obs_day: day,
    obs_time: /^\d{2}:\d{2}$/.test(String(item.obsTime || '')) ? item.obsTime : null,
    num_species: Number.isFinite(item.numSpecies) ? item.numSpecies : null,
    observer: item.userDisplayName || null
  }
}

/** Species rows from a checklist view: one per taxon, with the note and the media counts. */
const speciesRows = (subId, view) => (view.obs || [])
  .filter((obs) => obs && obs.speciesCode)
  .map((obs) => ({
    sub_id: subId,
    species_code: obs.speciesCode,
    how_many: Number.isFinite(obs.howManyAtleast) ? obs.howManyAtleast : null,
    comments: typeof obs.comments === 'string' && obs.comments.trim() ? obs.comments.trim().slice(0, 2000) : null,
    photos: Number(obs.mediaCounts?.P) || 0,
    audio: Number(obs.mediaCounts?.A) || 0,
    video: Number(obs.mediaCounts?.V) || 0
  }))

const fetchDetail = async (subId) => {
  const view = await ebird.checklistView(subId)
  const rows = speciesRows(subId, view)
  if (rows.length) await db('checklist_species').insert(rows).onConflict(['sub_id', 'species_code']).merge()
  await db('checklists').where({ sub_id: subId }).update({
    detail_fetched_at: db.fn.now(),
    num_species: Number.isFinite(view.numSpecies) ? view.numSpecies : undefined,
    num_observers: Number.isFinite(view.numObservers) ? view.numObservers : null,
    duration_hrs: Number.isFinite(view.durationHrs) ? view.durationHrs : null,
    distance_km: Number.isFinite(view.effortDistanceKm) ? view.effortDistanceKm : null,
    observer: view.userDisplayName || undefined
  })
  return rows.length
}

/**
 * One pass for a region: list, store what is new, and fill in up to `detailLimit` checklists that
 * lack their species, newest first, pausing between eBird calls. Returns what it did.
 */
const syncChecklists = async (region, { detailLimit = 60, pause = 250, deadline = Infinity } = {}) => {
  const listed = (await ebird.recentChecklists(region, 200)).map((item) => listRow(region, item)).filter(Boolean)
  const known = new Set((await db('checklists').whereIn('sub_id', listed.map((r) => r.sub_id)).pluck('sub_id')))
  const fresh = listed.filter((r) => !known.has(r.sub_id))
  if (fresh.length) await db('checklists').insert(fresh).onConflict('sub_id').ignore()
  const pending = await db('checklists').where({ region }).whereNull('detail_fetched_at').orderBy('obs_day', 'desc').orderBy('obs_time', 'desc').limit(detailLimit).pluck('sub_id')
  let detailed = 0
  let failed = 0
  for (const subId of pending) {
    if (Date.now() > deadline) break
    try {
      await fetchDetail(subId)
      detailed += 1
    } catch (error) {
      failed += 1
      console.error(`Checklist ${subId} failed:`, error.message)
      if (error.upstream === 429) break
    }
    if (pause) await sleep(pause)
  }
  const stillPending = Number((await db('checklists').where({ region }).whereNull('detail_fetched_at').count('* as n').first()).n)
  return { region, listed: listed.length, added: fresh.length, detailed, failed, pending: stillPending }
}

/** Regions with at least one user, the set every background job works through. */
const userRegions = () => db('users').whereNot('location', '').whereNotNull('location').distinct('location').pluck('location')

const SYNC_KIND = (region) => `checklist-sync:${region}`

/** The regions, the one synced longest ago first (never-synced ones lead), so no region waits behind the others. */
const bySyncAge = async (regions) => {
  const rows = await db('job_runs').whereIn('kind', regions.map(SYNC_KIND)).select('kind', 'ran_at')
  const last = new Map(rows.map((r) => [r.kind, new Date(r.ran_at).getTime()]))
  return [...regions].sort((a, b) => (last.get(SYNC_KIND(a)) ?? 0) - (last.get(SYNC_KIND(b)) ?? 0))
}

/**
 * The hourly pass over every user's region within one call's time budget: sync each region's
 * checklists, oldest sync first, then grade. A call that runs out of time says `more`, and the
 * caller calls again; the regions it reached are now the newest, so the next call starts with the rest.
 */
const runChecklistSync = async ({ regions, deadline, sync = syncChecklists, grade = null, detailLimit = 40 }) => {
  // A region synced in the last 15 minutes was done earlier in this round; the hourly runs are 60 apart.
  const recent = new Set((await db('job_runs').whereIn('kind', regions.map(SYNC_KIND)).where('ran_at', '>', db.raw("now() - interval '15 minutes'")).pluck('kind')))
  const ordered = (await bySyncAge(regions)).filter((code) => !recent.has(SYNC_KIND(code)))
  const results = []
  for (const code of ordered) {
    if (Date.now() > deadline) break
    try {
      results.push(await sync(code, { detailLimit, deadline }))
      await db('job_runs').insert({ kind: SYNC_KIND(code), ran_at: db.fn.now(), detail: null }).onConflict('kind').merge({ ran_at: db.fn.now() })
    } catch (error) {
      console.error(`Checklist sync for ${code} failed:`, error.message)
      results.push({ region: code, error: error.message })
    }
  }
  // Grading is once a day per region and skips itself when already done, so a fixed order is fine here.
  const grading = []
  let graded = 0
  if (grade) {
    for (const code of regions) {
      if (Date.now() > deadline) break
      try { grading.push(await grade(code)) } catch (error) { console.error(`Grading for ${code} failed:`, error.message) }
      graded += 1
    }
  }
  return { regions: results, grading, more: results.length < ordered.length || (grade !== null && graded < regions.length) }
}

/**
 * A county or area someone just chose that has never been synced: sync it now rather than at the
 * next hourly run, so their first look at Go has places in it. The job_runs row is claimed first,
 * so two quick saves don't both sync; one already on file means the hourly runs have it.
 */
const syncNewRegion = async (region, { sync = syncChecklists, budget = 45_000 } = {}) => {
  if (!COUNTY_REGION.test(String(region || ''))) return null
  const claimed = await db('job_runs').insert({ kind: SYNC_KIND(region), ran_at: db.fn.now(), detail: null }).onConflict('kind').ignore().returning('kind')
  if (!claimed.length) return null
  // Gentler than the hourly pass (a second between checklists): it runs while the person is using
  // the app, whose own eBird calls share the key's rate limit. Thirty is enough for Go to fill in.
  return sync(region, { detailLimit: 30, pause: 1000, deadline: Date.now() + budget })
}

/** Starts that sync after the response is sent; Vercel keeps the function alive until it is done. */
const syncNewRegionSoon = (region) => {
  if (process.env.NODE_ENV === 'test') return
  waitUntil(syncNewRegion(region).catch((error) => console.error(`First sync for ${region} failed:`, error.message)))
}

module.exports = { syncChecklists, listRow, speciesRows, userRegions, runChecklistSync, syncNewRegion, syncNewRegionSoon }
