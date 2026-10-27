const db = require('./db')
const ebird = require('./ebird')
const { HttpError } = require('./http')
const { addDays, today } = require('./seasonality')

/**
 * Which of two species a one-or-the-other sighting (a slash, or an old record from before a split)
 * most likely was, from what birders identified nearby around that time of year. eBird already
 * assigned old records wherever only one species occurs, so what is left is where both do; local
 * reports give the odds, never certainty, and the person makes the call.
 *
 * Samples the county (or the state, for a personal location) on days around the date, this year
 * of the sighting and the one before: one eBird call per day sampled, asked only on request.
 */
const OFFSETS = [-14, -7, 0, 7, 14]
const CONCURRENCY = 3
const MIN_DAYS = 4
const LEAN = 0.75
const CACHE_DAYS = 90
// Asked while the person waits: whatever has come back by then is the answer.
const BUDGET_MS = 25000

/** The county of a hotspot (from our copy or eBird), or null for a personal location. */
const countyOf = async (locId) => {
  if (!locId) return null
  const row = await db('hotspot_ref').where({ loc_id: locId }).first('county')
  if (row?.county) return row.county
  try { return (await ebird.hotspotInfo(locId))?.subnational2Code || null } catch { return null }
}

/** Days to sample: around the sighting's date in its year and the year before, none in the future. */
const sampleDays = (day, asOf = today()) => {
  const year = Number(day.slice(0, 4))
  const days = []
  for (const y of [year, year - 1]) {
    const anchor = `${y}${day.slice(4)}`
    for (const offset of OFFSETS) {
      const d = addDays(anchor, offset)
      if (d < asOf) days.push(d)
    }
  }
  return days
}

/** Days each species was reported on, out of the days sampled, to a verdict in plain terms. */
const verdict = (tally, choices) => {
  const ranked = choices.map((c) => ({ ...c, days: tally[c.speciesCode] || 0 })).sort((a, b) => b.days - a.days)
  const total = ranked.reduce((sum, c) => sum + c.days, 0)
  if (total < MIN_DAYS) return { lean: null, strength: 'thin', ranked }
  return ranked[0].days / total >= LEAN ? { lean: ranked[0].speciesCode, strength: 'clear', ranked } : { lean: null, strength: 'mixed', ranked }
}

const splitEvidence = async ({ choices, locId = null, region = null, day }, { asOf = today() } = {}) => {
  if (!Array.isArray(choices) || choices.length < 2 || choices.length > 3) throw new HttpError(400, 'Two or three choices are needed')
  const codes = choices.map((c) => ebird.assertSpecies(String(c.speciesCode || c)))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new HttpError(400, 'Invalid day')
  if (locId && !/^L\d{1,12}$/.test(locId)) throw new HttpError(400, 'Invalid location')
  const area = (await countyOf(locId)) || (region ? ebird.assertRegion(region) : null)
  if (!area) throw new HttpError(400, 'A location or region is needed')
  const names = Object.fromEntries(choices.map((c) => [c.speciesCode || c, c.comName || c.speciesCode || c]))
  const key = `split:${area}:${day.slice(5)}:${day.slice(0, 4)}:${[...codes].sort().join(',')}`
  const cached = await db('nearby_cache').where({ key }).first()
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_DAYS * 86400000) return cached.detail

  const days = sampleDays(day, asOf)
  const tally = {}
  let answered = 0
  let next = 0
  const deadline = Date.now() + BUDGET_MS
  const worker = async () => {
    while (next < days.length && Date.now() < deadline) {
      const d = days[next++]
      try {
        const rows = await Promise.race([
          ebird.historicObservations(area, d),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), Math.max(1000, deadline - Date.now())))
        ])
        answered += 1
        for (const code of codes) if (rows.some((o) => o.speciesCode === code)) tally[code] = (tally[code] || 0) + 1
      } catch (error) { console.error(`Split evidence ${area} ${d}:`, error.message) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, days.length) }, worker))
  const result = { area, areaKind: area.split('-').length === 3 ? 'county' : 'state', from: addDays(day, -14).slice(5), to: addDays(day, 14).slice(5), sampled: answered, ...verdict(tally, codes.map((speciesCode) => ({ speciesCode, comName: names[speciesCode] }))) }
  if (answered) await db('nearby_cache').insert({ key, detail: result }).onConflict('key').merge({ detail: result, fetched_at: db.fn.now() })
  return result
}

module.exports = { splitEvidence, sampleDays, verdict }
