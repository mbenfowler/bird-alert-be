const { route, HttpError } = require('../../lib/http')
const ebird = require('../../lib/ebird')
const db = require('../../lib/db')
const { arrivingSoon, seasonality } = require('../../lib/seasonality')
const { runChecklistSync, userRegions } = require('../../lib/checklists')
const { EBIRD_THROTTLED } = require('../../lib/adminStats')
const { pruneDaily } = require('../../lib/retention')
const { whereToFind, notableCodes } = require('../../lib/hotspots')
const { dailyPass, accuracy } = require('../../lib/grading')
const { whereToGo, parseOrigin } = require('../../lib/whereToGo')
const { bestHotspots, bestHotspotsFor, parseDays, assertCounty } = require('../../lib/bestHotspots')
const { nearbyPublic } = require('../../lib/nearby')
const { placeSearch, parsePoints } = require('../../lib/placeSearch')
const { drive } = require('../../lib/routing')
const { getShare, sharePage } = require('../../lib/shares')
const { chase } = require('../../lib/chase')
const { withAba } = require('../../lib/abaCodes')
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
  // GET /api/ebird/notable?region=&back=30 -> eBird's notable sightings, each with its ABA Checklist code (`aba`, or null)
  notable: {
    handler: async ({ region, back }) => withAba(await ebird.notableObservations(ebird.assertRegion(region), clampBack(back)), { region }),
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
  //   route: { stops, covers, url, drive, origin }, grades: { High: { n, hits, rate, enough }, ... } } the watch list's places folded together, ranked by birds a visit can expect (any number of codes; beyond 1000 the rest are ignored)
  'where-to-go': {
    handler: ({ region, codes, from }) => {
      const list = String(codes || '').split(',').map((c) => c.trim()).filter(Boolean).map(ebird.assertSpecies)
      if (!list.length) throw new HttpError(400, 'codes is required')
      // Long lists are fine (the bulk path costs the same); beyond a thousand, the rest are simply not considered.
      // `from=lat,lng` (optional): the route counts the drive from there, and its directions start there.
      return whereToGo(ebird.assertRegion(region), list.slice(0, 1000), { origin: parseOrigin(from) })
    },
    cacheControl: cache(600, 3600)
  },
  // GET /api/ebird/best-hotspots?region=<county>&days=7|30|90 -> { region, days, since, onFile: { checklists, detailed, firstDay },
  //   hotspots: [{ locId, name, lat, lng, species, checklists, bestList: { species, subId, day } | null }] } the county's
  //   hotspots ranked by species reported lately, then checklists (top 25; from what's on file, no eBird calls).
  //   With &species=<code>: { region, days, since, onFile, species: { code, comName }, hotspots: [{ locId, name, lat, lng,
  //   checklists, detailed, reports, frequency, lastSeen: { day, subId, howMany } }] } where that bird was reported most reliably
  'best-hotspots': {
    handler: ({ region, days, species }) => {
      const county = assertCounty(ebird.assertRegion(region))
      if (species === undefined || species === '') return bestHotspots(county, parseDays(days))
      return bestHotspotsFor(county, parseDays(days), ebird.assertSpecies(String(species)))
    },
    cacheControl: cache(600, 3600)
  },
  // GET /api/ebird/nearby?lat=&lng= -> { hotspots: [{ locId, name, lat, lng, miles, checklists, species, latest, lightlyBirded }],
  //   parks: [{ name, lat, lng, miles, type }] } public land near a point (eBird hotspots within 10 km, OSM parks within ~5 km)
  nearby: {
    handler: ({ lat, lng }) => nearbyPublic(Number.parseFloat(lat), Number.parseFloat(lng)),
    cacheControl: cache(DAY, WEEK)
  },
  // GET /api/ebird/place-search?state=GA&q=yahoola[&addresses=1] -> { hotspots: [{ locId, name, county, lat, lng, species, checklists, latest }],
  //   addresses: [{ name, lat, lng }] } stops and starting points by name; addresses only when asked (on submit, not as you type)
  'place-search': {
    handler: ({ state, q, addresses }) => placeSearch({ state: ebird.assertState(state).toUpperCase(), q, addresses: addresses === '1' }),
    cacheControl: cache(DAY, WEEK)
  },
  // GET /api/ebird/drive?points=lat,lng;lat,lng -> { minutes, miles, legs, geometry } or null, the drive through a route of the person's own making
  drive: {
    handler: async ({ points }) => (await drive(parsePoints(points))) ?? null,
    cacheControl: cache(DAY, WEEK)
  },
  // GET /api/ebird/chase?locId=&code=[&cls=rare|passage|seasonal|resident] -> is it still there? the last report (or a
  //   later checklist with the bird), checklists since that did and didn't have it, and the chance a visit now finds it
  chase: {
    handler: ({ locId, code, cls }) => chase({ locId, code, cls }),
    cacheControl: cache(600, 1200)
  },
  // GET /api/ebird/share?id= -> a shared route or sighting (public, read-only)
  share: {
    handler: ({ id }) => getShare(id),
    // Not cached at the edge, so every open is counted (one small read).
    cacheControl: 'no-store'
  },
  // GET /api/ebird/share-page?kind=r|s&id= -> the app's page with the share's preview card (title, picture) in its head;
  //   the front end rewrites /share/:kind/:id here, so links pasted anywhere unfurl properly
  'share-page': {
    handler: (query, req) => sharePage(query, req),
    // Never saved at the edge. The page names the build of the front end that asked for it (a preview
    // or production), but this endpoint's address is the same for both, so a saved copy could hand one
    // front end's build to the other: a blank page. Each request is one small database read.
    cacheControl: 'no-store',
    html: true
  },
  // GET /api/ebird/regions?state=GA -> { code, name }[]
  regions: {
    handler: ({ state }) => ebird.subregions(ebird.assertState(state)),
    cacheControl: cache(WEEK, 4 * WEEK)
  },
  // GET /api/ebird/sync-checklists[?region=] (hourly, GitHub Actions; cron auth) -> per region, what was
  // listed, added and fetched in full, plus `more` when the time budget ran out (call again). The region
  // synced longest ago goes first, so new regions with a big backlog can't starve the rest.
  'sync-checklists': {
    handler: async ({ region }, req) => {
      assertCronCaller(req)
      const regions = region ? [ebird.assertRegion(region)] : await userRegions()
      const deadline = Date.now() + 45_000
      // Once a day per region: record what the ranking says and grade last week's predictions.
      const grade = async (code) => dailyPass(code, { where: whereToFind, notable: await notableCodes(code), deadline })
      const result = await runChecklistSync({ regions, deadline, grade })
      // Logged so the morning admin numbers can count how often eBird pushed back.
      if (result.throttled) await require('../../lib/errors').reportError(EBIRD_THROTTLED, new Error('eBird throttled the key; the round stopped'))
      // Once a day, after a round is done: drop detail older than the app reads.
      if (!result.more) {
        try { result.retention = await pruneDaily() } catch (error) { console.error('Retention failed:', error.message) }
      }
      return result
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
  if (resource.html) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    return res.status(200).send(data)
  }
  res.status(200).json(data)
})
