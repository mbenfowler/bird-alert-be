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
 * Detectability: how readily a bird that is there gets noticed and reported. A cardinal shows
 * itself and sings at anyone; a Chuck-will's-widow calls only after dark, when hardly anyone birds.
 * Measured county-wide as the share of the region's recent checklists that report the species
 * (owls and nightjars: the share of checklists started before 7 am or from 6 pm, since daytime
 * lists would bury them). It shapes the chance where a place's own checklists are too few to.
 */
const DETECT_DAYS = 60
const MIN_COUNTY_LISTS = 30
const MIN_NIGHT_LISTS = 10
const NOCTURNAL_ORDERS = new Set(['Strigiformes', 'Caprimulgiformes'])
/** A county rate at or above this lets an inferred chance reach the full cap; rarer-seen birds get less. */
const DETECT_REFERENCE = 0.25
const DETECT_FLOOR = 0.35
/** How many checklists' worth of weight the county rate carries against a place's own few. */
const PRIOR_WEIGHT = 2

/** The county-wide detectability (0-1), or null when too few checklists are on file to say. */
const countyDetectability = ({ lists, withSpecies, nightLists = 0, nightWithSpecies = 0, nocturnal = false }) => {
  if (nocturnal && nightLists >= MIN_NIGHT_LISTS) return { rate: Math.min(1, nightWithSpecies / nightLists), basis: 'night', lists: nightLists }
  if (lists >= MIN_COUNTY_LISTS) return { rate: Math.min(1, withSpecies / lists), basis: 'all', lists }
  return null
}

/**
 * The chance (0-100) that a visit finds the bird. With enough checklists it is the measured
 * detection rate, faded by how long ago the last report was relative to the species' half-life
 * (92% seen two days ago for a resident stays about 86%; three weeks old, about half). Without
 * enough checklists it comes from the recency score alone, and is capped.
 */
const chanceOf = ({ score, detection, effort, withSpecies = null, lastAge, halfLife, prior = null }) => {
  const trusted = effort >= MIN_EFFORT && detection !== null
  const staleness = decay(lastAge, halfLife)
  if (trusted) {
    // A place's few checklists lean on the county's rate: 3 of 3 is promising, not certain.
    const rate = prior !== null && withSpecies !== null ? (withSpecies + PRIOR_WEIGHT * prior) / (effort + PRIOR_WEIGHT) : detection
    return Math.round(100 * Math.min(1, rate) * Math.sqrt(staleness))
  }
  // Approaches the cap rather than hitting it, so thinly birded places do not all read the same;
  // a bird that is hard to notice gets a lower cap, since reports of it are worth less on a visit.
  const cap = prior === null ? UNTRUSTED_CAP : UNTRUSTED_CAP * Math.min(1, Math.max(DETECT_FLOOR, Math.sqrt(prior / DETECT_REFERENCE)))
  return Math.round(cap * (1 - Math.pow(0.5, score)))
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
const rankPlaces = ({ reports, effort = new Map(), asOf = today(), halfLife, prior = null }) => {
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
    const chance = chanceOf({ score, detection, effort: e.checklists, withSpecies: e.withSpecies, lastAge, halfLife, prior })
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

const groupBy = (rows, key) => {
  const map = new Map()
  for (const row of rows) { const k = row[key]; if (!map.has(k)) map.set(k, []); map.get(k).push(row) }
  return map
}

/**
 * Where to find each of several species, with one query per table however many species there
 * are (a watch list of sixty costs the same as one of six). Stored data only; the live feed is a
 * single-species affair, added by `whereToFind`.
 */
const whereToFindMany = async (region, speciesCodes, { asOf = today() } = {}) => {
  const codes = [...new Set(speciesCodes)]
  if (!codes.length) return []
  const since = addDays(asOf, -WINDOW_DAYS)
  const effortSince = addDays(asOf, -EFFORT_DAYS)
  const timeSince = addDays(asOf, -TIME_DAYS)
  const detectSince = addDays(asOf, -DETECT_DAYS)
  const night = db.raw("sum(case when c.obs_time < '07:00' or c.obs_time >= '18:00' then 1 else 0 end) as night")
  const [yearRows, listRows, histRows, totals, hitRows, timeRows, birds, notable, grades, countyLists, countyHits] = await Promise.all([
    db('region_species_days').where({ region }).whereIn('speciesCode', codes).whereBetween('day', [addDays(asOf, -365), asOf]).select('speciesCode', db.raw('to_char(day, \'YYYY-MM-DD\') as day')),
    db('checklist_species as cs').join('checklists as c', 'c.sub_id', 'cs.sub_id').where('c.region', region).whereIn('cs.species_code', codes).where('c.obs_day', '>=', since)
      .select('cs.species_code', 'c.loc_id', 'c.loc_name', db.raw('to_char(c.obs_day, \'YYYY-MM-DD\') as day'), 'c.obs_time', 'c.lat', 'c.lng', 'c.is_hotspot', 'c.sub_id', 'cs.comments', 'c.observer'),
    db('region_species_days').where({ region }).whereIn('speciesCode', codes).where('day', '>=', since).whereNotNull('locId')
      .select('speciesCode', 'locId', 'locName', db.raw('to_char(day, \'YYYY-MM-DD\') as day'), 'obsTime', 'subId'),
    db('checklists').where({ region }).where('obs_day', '>=', effortSince).groupBy('loc_id').select('loc_id').count('* as n'),
    db('checklist_species as cs').join('checklists as c', 'c.sub_id', 'cs.sub_id').where('c.region', region).whereIn('cs.species_code', codes).where('c.obs_day', '>=', effortSince)
      .groupBy('cs.species_code', 'c.loc_id').select('cs.species_code', 'c.loc_id').count('* as n'),
    db('checklist_species as cs').join('checklists as c', 'c.sub_id', 'cs.sub_id').where('c.region', region).whereIn('cs.species_code', codes).where('c.obs_day', '>=', timeSince).whereNotNull('c.obs_time')
      .select('cs.species_code', 'c.obs_time'),
    db('birds').whereIn('speciesCode', codes).select('speciesCode', 'order', 'comName'),
    notableCodes(region),
    require('./grading').accuracy(region),
    db('checklists as c').where('c.region', region).where('c.obs_day', '>=', detectSince).count('* as n').select(night).first(),
    db('checklist_species as cs').join('checklists as c', 'c.sub_id', 'cs.sub_id').where('c.region', region).whereIn('cs.species_code', codes).where('c.obs_day', '>=', detectSince)
      .groupBy('cs.species_code').select('cs.species_code').count('* as n').select(night)
  ])
  const countyBy = new Map(countyHits.map((r) => [r.species_code, { n: Number(r.n), night: Number(r.night) }]))
  const histTimes = await db('region_species_days').where({ region }).whereIn('speciesCode', codes).where('day', '>=', timeSince).whereNotNull('obsTime').select('speciesCode', 'obsTime')
  const years = groupBy(yearRows, 'speciesCode')
  const lists = groupBy(listRows, 'species_code')
  const hists = groupBy(histRows, 'speciesCode')
  const hits = groupBy(hitRows, 'species_code')
  const times = groupBy(timeRows, 'species_code')
  const histT = groupBy(histTimes, 'speciesCode')
  const birdBy = new Map(birds.map((b) => [b.speciesCode, b]))
  const baseEffort = new Map(totals.map((r) => [r.loc_id, Number(r.n)]))
  return codes.map((speciesCode) => {
    const days = years.get(speciesCode) || []
    const profile = { monthsPresent: new Set(days.map((r) => r.day.slice(0, 7))).size, daysLastYear: days.length }
    const cls = classify({ ...profile, notable: notable.has(speciesCode) })
    const halfLife = HALF_LIVES[cls]
    const reports = [
      ...(lists.get(speciesCode) || []).map((r) => ({ locId: r.loc_id, locName: r.loc_name, day: r.day, time: r.obs_time, lat: r.lat === null ? null : Number(r.lat), lng: r.lng === null ? null : Number(r.lng), isHotspot: Boolean(r.is_hotspot), subId: r.sub_id, comment: r.comments, observer: r.observer })),
      ...(hists.get(speciesCode) || []).map((r) => ({ locId: r.locId, locName: r.locName, day: r.day, time: r.obsTime, subId: r.subId }))
    ]
    const effort = new Map()
    for (const [locId, n] of baseEffort) effort.set(locId, { checklists: n, withSpecies: 0 })
    for (const r of hits.get(speciesCode) || []) { const e = effort.get(r.loc_id) || { checklists: 0, withSpecies: 0 }; e.withSpecies = Number(r.n); effort.set(r.loc_id, e) }
    const window = bestWindow([...(times.get(speciesCode) || []).map((r) => r.obs_time), ...(histT.get(speciesCode) || []).map((r) => r.obsTime)])
    const bird = birdBy.get(speciesCode)
    const seen = countyBy.get(speciesCode) || { n: 0, night: 0 }
    const detect = countyDetectability({ lists: Number(countyLists?.n || 0), withSpecies: seen.n, nightLists: Number(countyLists?.night || 0), nightWithSpecies: seen.night, nocturnal: NOCTURNAL_ORDERS.has(bird?.order) })
    return {
      speciesCode,
      comName: bird?.comName || null,
      class: cls,
      halfLifeDays: halfLife,
      profile,
      bestTime: window ? { ...window, source: 'reports' } : { label: DEFAULT_TIME_BY_ORDER[bird?.order] || 'Morning', source: 'typical' },
      asOf,
      detectability: detect ? { rate: Math.round(detect.rate * 100), basis: detect.basis, lists: detect.lists } : null,
      places: rankPlaces({ reports, effort, asOf, halfLife, prior: detect ? detect.rate : null }),
      grades,
      _reports: reports,
      _prior: detect ? detect.rate : null,
      _effort: effort
    }
  })
}

/**
 * Everything the species page needs to say where to find one species in the region. `live: false`
 * (the daily grading pass) uses only what we keep, so a background pass never calls eBird.
 */
const whereToFind = async (region, speciesCode, { asOf = today(), live = true } = {}) => {
  const [base] = await whereToFindMany(region, [speciesCode], { asOf })
  const { _reports, _effort, _prior, ...result } = base
  if (!live) return result
  let liveRows = []
  try { liveRows = await ebird.speciesObservations(region, speciesCode, WINDOW_DAYS) } catch (error) { console.error(`Live feed for ${speciesCode} in ${region} unavailable:`, error.message) }
  const fresh = liveRows.filter((o) => o.locId && /^\d{4}-\d{2}-\d{2}/.test(o.obsDt || '')).map((o) => ({ locId: o.locId, locName: o.locName, day: o.obsDt.slice(0, 10), time: /\d{2}:\d{2}$/.test(o.obsDt) ? o.obsDt.slice(11, 16) : null, lat: o.lat, lng: o.lng, isHotspot: typeof o.locationPrivate === 'boolean' ? !o.locationPrivate : undefined, subId: o.subId }))
  return { ...result, places: rankPlaces({ reports: [..._reports, ...fresh], effort: _effort, asOf, halfLife: result.halfLifeDays, prior: _prior }) }
}

module.exports = { countyDetectability, NOCTURNAL_ORDERS, classify, decay, recencyScore, chanceOf, band, bestWindow, rankPlaces, whereToFind, whereToFindMany, notableCodes, metresBetween, HALF_LIVES, DEFAULT_TIME_BY_ORDER, WINDOW_DAYS, EFFORT_DAYS, MERGE_METRES }
