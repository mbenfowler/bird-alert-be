const db = require('./db')
const ebird = require('./ebird')
const { findOrCreateBirds } = require('./enrich')

/**
 * Seasonality for a region, from a table of (region, day, species) rows. eBird's historic feed
 * gives one day per request, so days are fetched once and kept; the hourly job adds today's
 * reports as they come in and fills in older days a few at a time.
 */

const DAY_MS = 86_400_000
const toDay = (date) => date.toISOString().slice(0, 10)
const parseDay = (day) => new Date(`${day}T00:00:00Z`)
const addDays = (day, n) => toDay(new Date(parseDay(day).getTime() + n * DAY_MS))
const yearAgo = (day) => { const d = parseDay(day); d.setUTCFullYear(d.getUTCFullYear() - 1); return toDay(d) }
const today = () => toDay(new Date())
const daysBetween = (from, to) => {
  const list = []
  for (let day = from; day <= to; day = addDays(day, 1)) list.push(day)
  return list
}
const countIn = (days, from, to) => { let n = 0; for (const day of days) if (day >= from && day <= to) n += 1; return n }
const earliestIn = (days, from, to) => [...days].filter((day) => day >= from && day <= to).sort()[0] || null

// "This time last year": the two weeks around today's date a year ago.
const EXPECTED_SPAN = 7
// A migrant was regularly reported around this date last year (at least this many days within
// three weeks either side) and essentially absent two to four months before it.
const REGULAR_SPAN = 21
const REGULAR_MIN_DAYS = 3
const GONE_FROM = 120
const GONE_TO = 50
const GONE_MAX_REPORTS = 1
// How much of last year we need on file before trusting the migrant test.
const GONE_MIN_COVERAGE = 40
// "Not here yet" for the feed; a longer silence before a report counts as the first of the season.
const ABSENT_DAYS = 14
const FIRST_ABSENT_DAYS = 45
const FIRST_MIN_COVERAGE = 30
// A species gets one first-of-season per region within this many days.
const SEASON_GAP_DAYS = 120
// 16 months: enough to judge last year's arrivals against the two to four months before them.
const BACKFILL_DAYS = 490
// Give up on a backfill pass after this many days fail; the next pass picks them up.
const MAX_FAILURES = 5

/** Which species were reported on which days: Map speciesCode -> Set of 'YYYY-MM-DD'. */
const presence = async (region, from, to) => {
  const rows = await db('region_species_days').where({ region }).whereBetween('day', [from, to]).select('speciesCode', db.raw('to_char(day, \'YYYY-MM-DD\') as day'))
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.speciesCode)) map.set(row.speciesCode, new Set())
    map.get(row.speciesCode).add(row.day)
  }
  return map
}

/** How many days in the range have been fetched in full. */
const coverage = async (region, from, to) =>
  Number((await db('region_days').where({ region }).whereBetween('day', [from, to]).count('* as n').first()).n)

/**
 * Species expected around `day`, judged by last year: how many of the 15 days around this date a
 * year ago they were reported on, and whether they look like a returning migrant rather than a
 * resident that happens to be under-reported. Pure, for tests; `lastYear` is a presence map.
 */
const expectedSpecies = (lastYear, day, { migrantTest = true } = {}) => {
  const ly = yearAgo(day)
  const [from, to] = [addDays(ly, -EXPECTED_SPAN), addDays(ly, EXPECTED_SPAN)]
  const [regFrom, regTo] = [addDays(ly, -REGULAR_SPAN), addDays(ly, REGULAR_SPAN)]
  const [goneFrom, goneTo] = [addDays(ly, -GONE_FROM), addDays(ly, -GONE_TO)]
  const result = []
  for (const [speciesCode, days] of lastYear) {
    const daysLastYear = countIn(days, from, to)
    if (!daysLastYear) continue
    const migrant = countIn(days, regFrom, regTo) >= REGULAR_MIN_DAYS && countIn(days, goneFrom, goneTo) <= GONE_MAX_REPORTS
    if (migrantTest && !migrant) continue
    result.push({ speciesCode, daysLastYear, windowDays: 2 * EXPECTED_SPAN + 1, firstLastYear: earliestIn(days, regFrom, regTo), migrant })
  }
  return result.sort((a, b) => b.daysLastYear - a.daysLastYear || a.speciesCode.localeCompare(b.speciesCode))
}

const lastYearPresence = (region, day) => {
  const ly = yearAgo(day)
  return presence(region, addDays(ly, -GONE_FROM), addDays(ly, REGULAR_SPAN))
}

const migrantTestPossible = async (region, day) => {
  const ly = yearAgo(day)
  return (await coverage(region, addDays(ly, -GONE_FROM), addDays(ly, -GONE_TO))) >= GONE_MIN_COVERAGE
}

/** Fetches one day from eBird and stores it, marking the day as covered even when nothing was reported. */
/** The time of day from eBird's "YYYY-MM-DD HH:MM" (null when the checklist had no time). */
const timeOf = (obsDt) => {
  const match = /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2})/.exec(String(obsDt || ''))
  return match ? match[1] : null
}

/** One row per species for the day: eBird returns each species' most recent report, with where and when. */
const dayRows = (region, day, observations) => {
  const rows = new Map()
  for (const obs of observations) {
    if (!obs.speciesCode || rows.has(obs.speciesCode)) continue
    rows.set(obs.speciesCode, { region, day, speciesCode: obs.speciesCode, locId: obs.locId || null, locName: obs.locName || null, obsTime: timeOf(obs.obsDt), subId: obs.subId || null })
  }
  return [...rows.values()]
}

const fetchDay = async (region, day) => {
  const rows = dayRows(region, day, await ebird.historicObservations(region, day))
  if (rows.length) {
    await db('region_species_days').insert(rows).onConflict(['region', 'day', 'speciesCode']).merge(['locId', 'locName', 'obsTime', 'subId'])
  }
  await db('region_days').insert({ region, day, species_count: rows.length, has_locations: true }).onConflict(['region', 'day']).merge()
  return rows.length
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Days fetched before locations were kept are fetched again so each report gains its where and
 * when. Newest first; stops at `limit` fetches or `deadline`. Safe to re-run.
 */
const backfillLocations = async (region, { limit = Infinity, deadline = Infinity, pause = 0 } = {}) => {
  const days = (await db('region_days').where({ region, has_locations: false }).orderBy('day', 'desc').select(db.raw('to_char(day, \'YYYY-MM-DD\') as day'))).map((r) => r.day)
  let fetched = 0
  let failed = 0
  for (const day of days) {
    if (fetched >= limit || Date.now() > deadline) break
    try {
      await fetchDay(region, day)
      fetched += 1
    } catch (error) {
      failed += 1
      await sleep(error.upstream === 429 ? 15000 : 1000)
    }
    if (pause) await sleep(pause)
  }
  return { fetched, failed, remaining: days.length - fetched - failed }
}

/**
 * Makes sure each of `days` has been fetched in full. Stops at `limit` fetches or when `deadline`
 * (ms since epoch) passes, so callers can give it a time budget. Returns how many were fetched
 * and how many are still missing.
 */
const ensureDays = async (region, days, { limit = Infinity, deadline = Infinity, pause = 0 } = {}) => {
  if (!days.length) return { fetched: 0, remaining: 0, failed: 0 }
  const have = new Set((await db('region_days').where({ region }).whereIn('day', days).select(db.raw('to_char(day, \'YYYY-MM-DD\') as day'))).map((r) => r.day))
  const missing = days.filter((day) => !have.has(day)).sort().reverse()
  let fetched = 0
  let failed = 0
  for (const day of missing) {
    if (fetched >= limit || Date.now() > deadline) break
    // eBird answers a long run of requests with the odd 502; one retry after a breath, then move on.
    try {
      await fetchDay(region, day)
      fetched += 1
    } catch (error) {
      // A 429 means we have been asking too fast; give eBird a proper breather before the retry.
      await new Promise((resolve) => setTimeout(resolve, error.upstream === 429 ? 15000 : 1000))
      try {
        await fetchDay(region, day)
        fetched += 1
      } catch (retryError) {
        failed += 1
        console.error(`History for ${region} on ${day} failed:`, retryError.message)
        if (failed >= MAX_FAILURES) break
      }
    }
    if (pause) await new Promise((resolve) => setTimeout(resolve, pause))
  }
  return { fetched, remaining: missing.length - fetched, failed }
}

/** Fills in the last 16 months, newest first, skipping the last two days (still being reported). */
const backfill = (region, options = {}) => {
  const end = addDays(today(), -2)
  return ensureDays(region, daysBetween(addDays(end, -BACKFILL_DAYS), end), options)
}

/** Records today's reports from the live feed; each observation carries its own (local) date. */
const recordObservations = async (region, observations) => {
  const rows = new Map()
  for (const obs of observations) {
    const day = String(obs.obsDt || '').slice(0, 10)
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      rows.set(`${day}:${obs.speciesCode}`, { region, day, speciesCode: obs.speciesCode, locId: obs.locId || null, locName: obs.locName || null, obsTime: timeOf(obs.obsDt), subId: obs.subId || null })
    }
  }
  if (rows.size) await db('region_species_days').insert([...rows.values()]).onConflict().ignore()
}

const withBirds = async (items) => {
  const birds = await findOrCreateBirds(items.map((item) => item.speciesCode)).catch(() => [])
  const byCode = new Map(birds.map((b) => [b.speciesCode, b]))
  return items
    .map((item) => {
      const bird = byCode.get(item.speciesCode)
      return bird ? { ...item, comName: bird.comName, sciName: bird.sciName, birdImg: bird.birdImg, wikiURL: bird.wikiURL } : null
    })
    .filter(Boolean)
}

/**
 * Species that were around this time last year but have not been reported in the last two
 * weeks. Fetches the core window on demand (at most 15 eBird calls, once per region per year).
 * `learning` is true while last year's record is too thin to tell migrants from residents.
 */
/**
 * History fetched on behalf of one page view. A new county needs a month of last year's days; a page
 * fetches only a few of them and the hourly pass fills the rest, paced, so a rush of new counties
 * never bursts eBird (which throttles per key, the whole app's key). Until then the page says it is
 * still learning.
 */
const PAGE_FETCH_LIMIT = 4
const PAGE_FETCH_MS = 5000

const arrivingSoon = async (region, { day = today(), recent, fetchLimit = PAGE_FETCH_LIMIT } = {}) => {
  const ly = yearAgo(day)
  // Best effort: a rate-limited or flaky eBird leaves us with whatever history is already on file.
  try {
    await ensureDays(region, daysBetween(addDays(ly, -EXPECTED_SPAN), addDays(ly, EXPECTED_SPAN)), { limit: fetchLimit, deadline: Date.now() + PAGE_FETCH_MS })
  } catch (error) {
    console.error(`History for ${region} around ${ly} unavailable:`, error.message)
  }
  const migrantTest = await migrantTestPossible(region, day)
  const expected = expectedSpecies(await lastYearPresence(region, day), day, { migrantTest })

  const live = recent || await ebird.recentObservations(region, ABSENT_DAYS)
  const here = new Set(live.map((obs) => obs.speciesCode))
  for (const code of (await presence(region, addDays(day, -ABSENT_DAYS), addDays(day, -1))).keys()) here.add(code)

  const arrivals = await withBirds(expected.filter((item) => !here.has(item.speciesCode)))
  return { arrivals: arrivals.sort((a, b) => b.daysLastYear - a.daysLastYear || a.comName.localeCompare(b.comName)), learning: !migrantTest }
}

/**
 * Looks through today's reports for returning migrants: expected about now, not reported for 45
 * days, not already greeted this season. Each new one is stored in season_firsts, which the push
 * job and the weekly email read. Needs enough history on file to be sure of the silence.
 */
const detectSeasonFirsts = async (region, recent, { day = today() } = {}) => {
  if (!recent.length) return []
  const ly = yearAgo(day)
  const [recentCoverage, lastYearCoverage] = await Promise.all([
    coverage(region, addDays(day, -FIRST_ABSENT_DAYS), addDays(day, -2)),
    coverage(region, addDays(ly, -GONE_FROM), addDays(ly, REGULAR_SPAN))
  ])
  if (recentCoverage < FIRST_MIN_COVERAGE || lastYearCoverage < 100) return []

  const migrants = new Map(expectedSpecies(await lastYearPresence(region, day), day).map((item) => [item.speciesCode, item]))
  const since = await presence(region, addDays(day, -FIRST_ABSENT_DAYS), addDays(day, -1))
  const candidates = recent.filter((obs) => migrants.has(obs.speciesCode) && !since.has(obs.speciesCode))
  if (!candidates.length) return []

  const greeted = new Set(
    await db('season_firsts').where({ region }).whereIn('speciesCode', candidates.map((c) => c.speciesCode))
      .where('seen_on', '>', addDays(day, -SEASON_GAP_DAYS)).pluck('speciesCode')
  )
  const firsts = []
  for (const obs of candidates) {
    if (greeted.has(obs.speciesCode)) continue
    const last = await db('region_species_days').where({ region, speciesCode: obs.speciesCode }).where('day', '<', day).max(db.raw('to_char(day, \'YYYY-MM-DD\')')).first()
    const row = { region, speciesCode: obs.speciesCode, seen_on: String(obs.obsDt).slice(0, 10), last_seen_on: last?.max || null, observation: obs }
    await db('season_firsts').insert(row)
    firsts.push(row)
  }
  return firsts
}

/** Season firsts recorded in the last `hours`, as observations tagged for the push job. */
const recentSeasonFirsts = async (region, hours = 24) => {
  const rows = await db('season_firsts').where({ region }).where('created_at', '>', db.raw(`now() - interval '${hours} hours'`))
  return rows.map((row) => ({ ...row.observation, kind: 'season', lastSeenOn: row.last_seen_on ? toDay(new Date(row.last_seen_on)) : null }))
}

/**
 * The week in review for a region: species back after a month or more away, regulars that have
 * gone quiet, and what last year says to expect over the next two weeks.
 */
const migrationReport = async (region, { day = today(), deadline = Date.now() + 8000 } = {}) => {
  try {
    await ensureDays(region, daysBetween(addDays(day, -46), addDays(day, -2)), { deadline })
  } catch (error) {
    console.error(`History for ${region} before ${day} unavailable:`, error.message)
  }
  const live = await ebird.recentObservations(region, ABSENT_DAYS)
  const weekStart = addDays(day, -7)
  const thisWeek = new Map()
  for (const obs of live) if (String(obs.obsDt).slice(0, 10) >= weekStart && !thisWeek.has(obs.speciesCode)) thisWeek.set(obs.speciesCode, obs)
  const seenRecently = new Set(live.map((obs) => obs.speciesCode))

  const monthBefore = await presence(region, addDays(day, -37), addDays(day, -8))
  const recentDays = await presence(region, weekStart, addDays(day, -1))
  const arrived = [...thisWeek.values()]
    .filter((obs) => !monthBefore.has(obs.speciesCode))
    .map((obs) => ({ speciesCode: obs.speciesCode, daysThisWeek: Math.max(1, recentDays.get(obs.speciesCode)?.size || 0), firstSeen: [...(recentDays.get(obs.speciesCode) || [])].sort()[0] || String(obs.obsDt).slice(0, 10), locName: obs.locName }))

  const older = await presence(region, addDays(day, -44), addDays(day, -15))
  const departed = []
  for (const [speciesCode, days] of older) {
    if (days.size >= REGULAR_MIN_DAYS && !seenRecently.has(speciesCode)) departed.push({ speciesCode, daysBefore: days.size, lastSeen: [...days].sort().at(-1) })
  }

  const coming = (await arrivingSoon(region, { day: addDays(day, 7), recent: live })).arrivals.slice(0, 10)
  const [arrivedBirds, departedBirds] = await Promise.all([withBirds(arrived), withBirds(departed)])
  return {
    arrived: arrivedBirds.sort((a, b) => b.daysThisWeek - a.daysThisWeek || a.comName.localeCompare(b.comName)),
    departed: departedBirds.sort((a, b) => b.daysBefore - a.daysBefore || a.comName.localeCompare(b.comName)),
    coming
  }
}

/** Days per month a species was reported in the region over the last year, with how many days are on file. */
const seasonality = async (region, speciesCode, { day = today() } = {}) => {
  const from = addDays(day, -365)
  const [reported, covered] = await Promise.all([
    db('region_species_days').where({ region, speciesCode }).whereBetween('day', [from, day]).select(db.raw('extract(month from day)::int as month')).count('* as n').groupBy('month'),
    db('region_days').where({ region }).whereBetween('day', [from, day]).select(db.raw('extract(month from day)::int as month')).count('* as n').groupBy('month')
  ])
  const byMonth = (rows) => new Map(rows.map((r) => [r.month, Number(r.n)]))
  const [r, c] = [byMonth(reported), byMonth(covered)]
  return { months: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, reported: r.get(i + 1) || 0, covered: c.get(i + 1) || 0 })) }
}

module.exports = {
  toDay, addDays, yearAgo, daysBetween, today, expectedSpecies,
  presence, coverage, ensureDays, backfill, backfillLocations, dayRows, timeOf, recordObservations,
  arrivingSoon, detectSeasonFirsts, recentSeasonFirsts, migrationReport, seasonality
}
