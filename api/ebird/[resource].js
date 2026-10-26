const { route, HttpError } = require('../../lib/http')
const ebird = require('../../lib/ebird')
const db = require('../../lib/db')
const { arrivingSoon, seasonality } = require('../../lib/seasonality')
const { syncChecklists, userRegions } = require('../../lib/checklists')
const { whereToFind, notableCodes } = require('../../lib/hotspots')
const { dailyPass, accuracy } = require('../../lib/grading')
const { whereToGo } = require('../../lib/whereToGo')
const { assertCronCaller } = require('../../lib/digest')

const DAY = 86400
const WEEK = 7 * DAY
const cache = (maxAge, swr) => `public, max-age=${Math.min(maxAge, 300)}, s-maxage=${maxAge}, stale-while-revalidate=${swr}`

// Read-only proxy for the eBird calls the app makes, so the API key stays on the server and the
// CDN can absorb repeat requests. Each resource sets a cache lifetime that matches how often the data moves.
const resources = {
  // GET /api/ebird/species-list?region=US-GA-139 -> string[] of species codes (true species only)
  'species-list': {
    handler: async ({ region }) => speciesOnly(await ebird.speciesList(ebird.assertRegion(region))),
    cacheControl: cache(DAY, WEEK)
  },
  // GET /api/ebird/observations?region= -> recent observations
  observations: {
    handler: ({ region }) => ebird.recentObservations(ebird.assertRegion(region)),
    cacheControl: cache(300, 3600)
  },
  // GET /api/ebird/notable?region=&back=30
  notable: {
    handler: ({ region, back }) => ebird.notableObservations(ebird.assertRegion(region), clampBack(back)),
    cacheControl: cache(300, 3600)
  },
  // GET /api/ebird/species-observations?region=&code=&back=30
  'species-observations': {
    handler: ({ region, code, back }) =>
      ebird.speciesObservations(ebird.assertRegion(region), ebird.assertSpecies(code), clampBack(back)),
    cacheControl: cache(300, 3600)
  },
  // GET /api/ebird/arriving?region= -> { arrivals: [{ speciesCode, comName, birdImg, daysLastYear, windowDays, firstLastYear }], learning }
  arriving: {
    handler: ({ region }) => arrivingSoon(ebird.assertRegion(region)),
    cacheControl: cache(3600, DAY)
  },
  // GET /api/ebird/seasonality?region=&code= -> { months: [{ month, reported, covered }] } for the last year
  seasonality: {
    handler: ({ region, code }) => seasonality(ebird.assertRegion(region), ebird.assertSpecies(code)),
    cacheControl: cache(DAY, WEEK)
  },
  // GET /api/ebird/where?region=&code= -> { class, halfLifeDays, bestTime, places: [{ locId, locName, lat, lng, band,
  //   score, days, lastSeen, effort: { checklists, withSpecies, detection }, notes }] } ranked by the chance a visit pays off
  where: {
    handler: ({ region, code }) => whereToFind(ebird.assertRegion(region), ebird.assertSpecies(code)),
    cacheControl: cache(600, 3600)
  },
  // GET /api/ebird/where-to-go?region=&codes=a,b,c -> { species, places: [{ locId, locName, expected, birds, bestTime, seenToday }],
  //   route: { stops, covers, url } } the watch list's places folded together, ranked by birds a visit can expect (any number of codes; beyond 1000 the rest are ignored)
  'where-to-go': {
    handler: ({ region, codes }) => {
      const list = String(codes || '').split(',').map((c) => c.trim()).filter(Boolean).map(ebird.assertSpecies)
      if (!list.length) throw new HttpError(400, 'codes is required')
      // Long lists are fine (the bulk path costs the same); beyond a thousand, the rest are simply not considered.
      return whereToGo(ebird.assertRegion(region), list.slice(0, 1000))
    },
    cacheControl: cache(600, 3600)
  },
  // GET /api/ebird/regions?state=GA -> { code, name }[]
  regions: {
    handler: ({ state }) => ebird.subregions(ebird.assertState(state)),
    cacheControl: cache(WEEK, 4 * WEEK)
  },
  // GET /api/ebird/sync-checklists[?region=] (hourly, GitHub Actions; cron auth) -> per region, what was
  // listed, added and fetched in full. Keeps the checklists tables current within the function's time budget.
  'sync-checklists': {
    handler: async ({ region }, req) => {
      assertCronCaller(req)
      const regions = region ? [ebird.assertRegion(region)] : await userRegions()
      const deadline = Date.now() + 45_000
      const results = []
      for (const code of regions) {
        if (Date.now() > deadline) break
        results.push(await syncChecklists(code, { detailLimit: 40, deadline }))
      }
      // Once a day per region: record what the ranking says and grade last week's predictions.
      const grading = []
      for (const code of regions) {
        if (Date.now() > deadline) break
        try { grading.push(await dailyPass(code, { where: whereToFind, notable: await notableCodes(code), deadline })) } catch (error) { console.error(`Grading for ${code} failed:`, error.message) }
      }
      return { regions: results, grading }
    },
    cacheControl: 'no-store'
  },
  // GET /api/ebird/grades?region= -> { High: { n, hits, rate, enough }, ... } how the bands fared over the last two months
  grades: {
    handler: ({ region }) => accuracy(ebird.assertRegion(region)),
    cacheControl: cache(3600, DAY)
  }
}

// eBird's region list includes hybrids, spuhs and slashes, which have no photo or article. Categories
// come from our own birds table where known, and from eBird taxonomy (50 codes a call) otherwise.
const speciesOnly = async (codes) => {
  const category = new Map((await db('birds').whereIn('speciesCode', codes).select('speciesCode', 'category'))
    .map((bird) => [bird.speciesCode, bird.category]))
  const unknown = codes.filter((code) => !category.has(code))
  for (let i = 0; i < unknown.length; i += 50) {
    for (const taxon of await ebird.taxonomy(unknown.slice(i, i + 50))) category.set(taxon.speciesCode, taxon.category)
  }
  return codes.filter((code) => category.get(code) === 'species')
}

const clampBack = (value) => {
  const days = Number.parseInt(value ?? '30', 10)
  if (!Number.isFinite(days) || days < 1 || days > 30) throw new HttpError(400, 'back must be between 1 and 30')
  return days
}

module.exports = route(['GET'], async (req, res) => {
  const resource = resources[req.query.resource]
  if (!resource) throw new HttpError(404, 'Not found')
  const data = await resource.handler(req.query, req)
  res.setHeader('Cache-Control', resource.cacheControl)
  res.status(200).json(data)
})
