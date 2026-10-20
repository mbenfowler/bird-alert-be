const { route, HttpError } = require('../../lib/http')
const ebird = require('../../lib/ebird')

const DAY = 86400
const WEEK = 7 * DAY
const cache = (maxAge, swr) => `public, max-age=${Math.min(maxAge, 300)}, s-maxage=${maxAge}, stale-while-revalidate=${swr}`

// Read-only proxy for the eBird calls the app makes, so the API key stays on the server and the
// CDN can absorb repeat requests. Each resource sets a cache lifetime that matches how often the data moves.
const resources = {
  // GET /api/ebird/species-list?region=US-GA-139 -> string[] of species codes
  'species-list': {
    handler: ({ region }) => ebird.speciesList(ebird.assertRegion(region)),
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
  // GET /api/ebird/regions?state=GA -> { code, name }[]
  regions: {
    handler: ({ state }) => ebird.subregions(ebird.assertState(state)),
    cacheControl: cache(WEEK, 4 * WEEK)
  }
}

const clampBack = (value) => {
  const days = Number.parseInt(value ?? '30', 10)
  if (!Number.isFinite(days) || days < 1 || days > 30) throw new HttpError(400, 'back must be between 1 and 30')
  return days
}

module.exports = route(['GET'], async (req, res) => {
  const resource = resources[req.query.resource]
  if (!resource) throw new HttpError(404, 'Not found')
  const data = await resource.handler(req.query)
  res.setHeader('Cache-Control', resource.cacheControl)
  res.status(200).json(data)
})
