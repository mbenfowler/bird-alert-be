const db = require('./db')
const ebird = require('./ebird')
const { today, addDays } = require('./seasonality')

/**
 * Where to find a species, ranked by the chance a visit pays off. Every report decays at a rate
 * that depends on the species (a resident's report from ten days ago still counts; a migrant's
 * does not), effort turns reports into a detection rate (reports over checklists at the place),
 * and the hours of past reports say when to go. Bands, not percentages: the evidence travels with
 * each band so the reader can judge it.
 */
const DAY_MS = 86400000
const WINDOW_DAYS = 30
const EFFORT_DAYS = 14
const TIME_DAYS = 60
const MIN_EFFORT = 3
const MIN_TIME_SAMPLES = 5
/** A personal location this close to a public hotspot is, for a visitor, the same place. */
const MERGE_METRES = 600

/** Days a report keeps half its value. */
const HALF_LIVES = { resident: 21, seasonal: 10, passage: 4, rare: 2 }

/**
 * The species' persistence class, from its own year in the county: how many months it was
 * reported in and how many days, plus whether eBird currently flags it as notable here.
 */
const classify = ({ monthsPresent = 0, daysLastYear = 0, notable = false }) => {
  if (notable) return 'rare'
  if (daysLastYear < 12 || monthsPresent <= 3) return 'passage'
  if (monthsPresent >= 10) return 'resident'
  return 'seasonal'
}

const ageDays = (day, asOf) => Math.max(0, Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / DAY_MS))
const decay = (age, halfLife) => Math.pow(0.5, age / halfLife)

/** Sum of each distinct report day's remaining value. */
const recencyScore = (days, asOf, halfLife) => [...new Set(days)].reduce((sum, day) => sum + decay(ageDays(day, asOf), halfLife), 0)

/** Without effort data the chance is inferred; an inferred chance is never High, that needs checklists. */
const UNTRUSTED_CAP = 55

/**
 * The chance (0-100) that a visit finds the bird. With enough checklists it is the measured
 * detection rate, faded by how long ago the last report was relative to the species' half-life
 * (92% seen two days ago for a resident stays about 86%; three weeks old, about half). Without
 * enough checklists it comes from the recency score alone, and is capped.
 */
const chanceOf = ({ score, detection, effort, lastAge, halfLife }) => {
  const trusted = effort >= MIN_EFFORT && detection !== null
  const staleness = decay(lastAge, halfLife)
  if (trusted) return Math.round(100 * detection * Math.sqrt(staleness))
  return Math.round(Math.min(UNTRUSTED_CAP, 100 * (1 - Math.pow(0.5, score))))
}

/** High / Good / Fair / Long shot, from the chance, so label and number never disagree. */
const band = (chance) => chance >= 60 ? 'High' : chance >= 40 ? 'Good' : chance >= 20 ? 'Fair' : 'Long shot'

const BAND_ORDER = { High: 0, Good: 1, Fair: 2, 'Long shot': 3 }

/** The two-hour window that holds the most reports, when there are enough to say. */
const bestWindow = (times) => {
  const valid = times.filter((t) => /^\d{2}:\d{2}$/.test(t || ''))
  if (valid.length < MIN_TIME_SAMPLES) return null
  const buckets = new Array(12).fill(0)
  for (const t of valid) buckets[Math.min(11, Math.floor(Number(t.slice(0, 2)) / 2))] += 1
  let best = 0
  for (let i = 1; i < 12; i += 1) if (buckets[i] > buckets[best]) best = i
  const label = (h) => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`
  return { from: best * 2, to: best * 2 + 2, label: `${label(best * 2)} to ${label(best * 2 + 2)}`, share: Math.round((buckets[best] / valid.length) * 100), samples: valid.length }
}

/** When a species' own reports are too few to say, its order says something. */
const DEFAULT_TIME_BY_ORDER = {
  Strigiformes: 'Dusk and night',
  Caprimulgiformes: 'Dusk',
  Accipitriformes: 'Late morning, once the air warms',
  Cathartiformes: 'Late morning',
  Falconiformes: 'Morning',
  Passeriformes: 'First three hours after sunrise',
  Piciformes: 'Morning',
  Apodiformes: 'Morning and late afternoon',
  Anseriformes: 'Any time',
  Podicipediformes: 'Any time',
  Gaviiformes: 'Morning, calm water',
  Charadriiformes: 'Low tide on the coast; morning inland',
  Pelecaniformes: 'Morning',
  Suliformes: 'Morning',
  Ciconiiformes: 'Late morning',
  Gruiformes: 'Dawn and dusk',
  Columbiformes: 'Any time',
  Galliformes: 'First hour after sunrise',
  Cuculiformes: 'Morning',
  Coraciiformes: 'Any time',
  Psittaciformes: 'Dawn and dusk'
}

const metresBetween = (a, b) => {
  const toRad = (deg) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(h))
}

/**
 * Folds each personal location into the nearest public hotspot within MERGE_METRES: the hotspot
 * keeps its name and id (it is the place one can drive to) and gains the other's days, notes and
 * effort. Hotspots never merge with each other; inside a big park different pins mean different
 * spots. Mutates and returns `places`; `effort` gains combined entries under the hotspot's id.
 */
const mergePrivateIntoHotspots = (places, effort) => {
  const hotspots = [...places.values()].filter((p) => p.isHotspot === true && p.lat !== null)
  for (const place of [...places.values()]) {
    if (place.isHotspot !== false || place.lat === null) continue
    let nearest = null
    let best = MERGE_METRES
    for (const hotspot of hotspots) {
      const d = metresBetween(place, hotspot)
      if (d <= best) { best = d; nearest = hotspot }
    }
    if (!nearest) continue
    for (const day of place.days) nearest.days.add(day)
    nearest.times.push(...place.times)
    for (const subId of place.subIds) nearest.subIds.add(subId)
    nearest.notes.push(...place.notes)
    if (!nearest.last || place.last.stamp > nearest.last.stamp) nearest.last = place.last
    nearest.merged.push({ locId: place.locId, locName: place.locName })
    const a = effort.get(nearest.locId) || { checklists: 0, withSpecies: 0 }
    const b = effort.get(place.locId) || { checklists: 0, withSpecies: 0 }
    effort.set(nearest.locId, { checklists: a.checklists + b.checklists, withSpecies: a.withSpecies + b.withSpecies })
    places.delete(place.locId)
  }
  return places
}

/**
 * Pure: reports (one per sighting: locId, locName, day, time?, lat?, lng?, isHotspot?, subId?,
 * comment?, observer?) and effort per place (checklists, withSpecies over the effort window)
 * become ranked places with a band and the evidence behind it.
 */
const rankPlaces = ({ reports, effort = new Map(), asOf = today(), halfLife }) => {
  const places = new Map()
  for (const r of reports) {
    if (!r.locId || !r.day || ageDays(r.day, asOf) > WINDOW_DAYS) continue
    const place = places.get(r.locId) || { locId: r.locId, locName: r.locName || null, lat: null, lng: null, isHotspot: null, days: new Set(), times: [], last: null, notes: [], subIds: new Set(), merged: [] }
    place.locName = place.locName || r.locName || null
    // A personal location (someone's yard) is worth knowing about but cannot be visited; a hotspot can.
    if (typeof r.isHotspot === 'boolean') place.isHotspot = place.isHotspot || r.isHotspot
    if (place.lat === null && Number.isFinite(r.lat) && Number.isFinite(r.lng)) { place.lat = r.lat; place.lng = r.lng }
    place.days.add(r.day)
    if (r.time) place.times.push(r.time)
    if (r.subId) place.subIds.add(r.subId)
    const stamp = `${r.day} ${r.time || '00:00'}`
    if (!place.last || stamp > place.last.stamp) place.last = { stamp, day: r.day, time: r.time || null, subId: r.subId || null }
    if (r.comment) place.notes.push({ day: r.day, time: r.time || null, observer: r.observer || null, text: r.comment, subId: r.subId || null })
    places.set(r.locId, place)
  }
  const combined = new Map(effort)
  mergePrivateIntoHotspots(places, combined)
  const ranked = [...places.values()].map((p) => {
    const e = combined.get(p.locId) || { checklists: 0, withSpecies: 0 }
    const detection = e.checklists >= MIN_EFFORT ? Math.min(1, e.withSpecies / e.checklists) : null
    const score = recencyScore([...p.days], asOf, halfLife)
    const lastAge = ageDays(p.last.day, asOf)
    const chance = chanceOf({ score, detection, effort: e.checklists, lastAge, halfLife })
    p.notes.sort((a, b) => `${b.day} ${b.time || ''}`.localeCompare(`${a.day} ${a.time || ''}`))
    return {
      locId: p.locId,
      locName: p.locName,
      lat: p.lat,
      lng: p.lng,
      isHotspot: p.isHotspot,
      merged: p.merged,
      // The place's own busiest two hours, once it has enough timed reports; the species window otherwise.
      bestTime: bestWindow(p.times),
      chance,
      band: band(chance),
      score: Math.round(score * 100) / 100,
      days: p.days.size,
      lastSeen: { day: p.last.day, time: p.last.time, subId: p.last.subId, daysAgo: lastAge },
      effort: { checklists: e.checklists, withSpecies: e.withSpecies, detection: detection === null ? null : Math.round(detection * 100) },
      notes: p.notes.slice(0, 2)
    }
  })
  ranked.sort((a, b) => BAND_ORDER[a.band] - BAND_ORDER[b.band] || b.chance - a.chance || b.score - a.score || a.lastSeen.daysAgo - b.lastSeen.daysAgo)
  return ranked
}

// eBird's notable feed per region, held briefly so a page of species does not refetch it.
const notableCache = new Map()
const notableCodes = async (region) => {
  const hit = notableCache.get(region)
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.codes
  let codes = new Set()
  try { codes = new Set((await ebird.notableObservations(region, 14)).map((o) => o.speciesCode)) } catch (error) { console.error(`Notable feed for ${region} unavailable:`, error.message) }
  notableCache.set(region, { at: Date.now(), codes })
  return codes
}

const yearProfile = async (region, speciesCode, asOf) => {
  const rows = await db('region_species_days').where({ region, speciesCode }).whereBetween('day', [addDays(asOf, -365), asOf]).select(db.raw('to_char(day, \'YYYY-MM-DD\') as day'))
  const months = new Set(rows.map((r) => r.day.slice(0, 7)))
  return { monthsPresent: months.size, daysLastYear: rows.length }
}

/** Reports of the species in the window from everything we keep, plus eBird's live per-location feed. */
const reportsFor = async (region, speciesCode, asOf, { live = true } = {}) => {
  const since = addDays(asOf, -WINDOW_DAYS)
  const fromChecklists = await db('checklist_species as cs').join('checklists as c', 'c.sub_id', 'cs.sub_id')
    .where({ 'c.region': region, 'cs.species_code': speciesCode }).where('c.obs_day', '>=', since)
    .select('c.loc_id', 'c.loc_name', db.raw('to_char(c.obs_day, \'YYYY-MM-DD\') as day'), 'c.obs_time', 'c.lat', 'c.lng', 'c.is_hotspot', 'c.sub_id', 'cs.comments', 'c.observer')
  const fromHistory = await db('region_species_days').where({ region, speciesCode }).where('day', '>=', since).whereNotNull('locId')
    .select('locId', 'locName', db.raw('to_char(day, \'YYYY-MM-DD\') as day'), 'obsTime', 'subId')
  let liveRows = []
  if (live) {
    try { liveRows = await ebird.speciesObservations(region, speciesCode, WINDOW_DAYS) } catch (error) { console.error(`Live feed for ${speciesCode} in ${region} unavailable:`, error.message) }
  }
  return [
    ...fromChecklists.map((r) => ({ locId: r.loc_id, locName: r.loc_name, day: r.day, time: r.obs_time, lat: r.lat === null ? null : Number(r.lat), lng: r.lng === null ? null : Number(r.lng), isHotspot: Boolean(r.is_hotspot), subId: r.sub_id, comment: r.comments, observer: r.observer })),
    ...fromHistory.map((r) => ({ locId: r.locId, locName: r.locName, day: r.day, time: r.obsTime, subId: r.subId })),
    ...liveRows.filter((o) => o.locId && /^\d{4}-\d{2}-\d{2}/.test(o.obsDt || '')).map((o) => ({ locId: o.locId, locName: o.locName, day: o.obsDt.slice(0, 10), time: /\d{2}:\d{2}$/.test(o.obsDt) ? o.obsDt.slice(11, 16) : null, lat: o.lat, lng: o.lng, isHotspot: typeof o.locationPrivate === 'boolean' ? !o.locationPrivate : undefined, subId: o.subId }))
  ]
}

/** Checklists per place in the effort window, and how many of them had the species. */
const effortFor = async (region, speciesCode, asOf) => {
  const since = addDays(asOf, -EFFORT_DAYS)
  const totals = await db('checklists').where({ region }).where('obs_day', '>=', since).groupBy('loc_id').select('loc_id').count('* as n')
  const withSpecies = await db('checklist_species as cs').join('checklists as c', 'c.sub_id', 'cs.sub_id')
    .where({ 'c.region': region, 'cs.species_code': speciesCode }).where('c.obs_day', '>=', since).groupBy('c.loc_id').select('c.loc_id').count('* as n')
  const effort = new Map(totals.map((r) => [r.loc_id, { checklists: Number(r.n), withSpecies: 0 }]))
  for (const r of withSpecies) { const e = effort.get(r.loc_id) || { checklists: 0, withSpecies: 0 }; e.withSpecies = Number(r.n); effort.set(r.loc_id, e) }
  return effort
}

const timesFor = async (region, speciesCode, asOf) => {
  const since = addDays(asOf, -TIME_DAYS)
  const a = await db('checklist_species as cs').join('checklists as c', 'c.sub_id', 'cs.sub_id').where({ 'c.region': region, 'cs.species_code': speciesCode }).where('c.obs_day', '>=', since).whereNotNull('c.obs_time').pluck('c.obs_time')
  const b = await db('region_species_days').where({ region, speciesCode }).where('day', '>=', since).whereNotNull('obsTime').pluck('obsTime')
  return [...a, ...b]
}

/**
 * Everything the species page needs to say where to find one species in the region. `live: false`
 * (the daily grading pass) uses only what we keep, so a background pass never calls eBird.
 */
const whereToFind = async (region, speciesCode, { asOf = today(), live = true } = {}) => {
  const [profile, notable, reports, effort, times, bird] = await Promise.all([
    yearProfile(region, speciesCode, asOf),
    notableCodes(region),
    reportsFor(region, speciesCode, asOf, { live }),
    effortFor(region, speciesCode, asOf),
    timesFor(region, speciesCode, asOf),
    db('birds').where({ speciesCode }).first('order', 'comName')
  ])
  const cls = classify({ ...profile, notable: notable.has(speciesCode) })
  const halfLife = HALF_LIVES[cls]
  const window = bestWindow(times)
  return {
    speciesCode,
    class: cls,
    halfLifeDays: halfLife,
    profile,
    bestTime: window ? { ...window, source: 'reports' } : { label: DEFAULT_TIME_BY_ORDER[bird?.order] || 'Morning', source: 'typical' },
    asOf,
    places: rankPlaces({ reports, effort, asOf, halfLife }),
    // How the bands have fared here lately: graded predictions, so the page can put a number on a band.
    grades: await require('./grading').accuracy(region)
  }
}

module.exports = { classify, decay, recencyScore, chanceOf, band, bestWindow, rankPlaces, whereToFind, notableCodes, metresBetween, HALF_LIVES, DEFAULT_TIME_BY_ORDER, WINDOW_DAYS, EFFORT_DAYS, MERGE_METRES }
