const db = require('./db')
const ebird = require('./ebird')

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

module.exports = { syncChecklists, listRow, speciesRows, userRegions }
