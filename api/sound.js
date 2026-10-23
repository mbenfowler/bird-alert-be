const { route, HttpError } = require('../lib/http')
const { assertSpecies } = require('../lib/ebird')
const { soundFor } = require('../lib/sounds')

// A species' sound rarely changes, and a miss is cheap to repeat later.
const SOUND_CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'

// GET /api/sound?code=cangoo -> { found, url, page, type, length, recordist, license, licenseName, ... }
//                               one representative xeno-canto recording for the species
module.exports = route(['GET'], async (req, res) => {
  const { code } = req.query
  if (typeof code !== 'string') throw new HttpError(400, 'A species code is required')
  const sound = await soundFor(assertSpecies(code))
  res.setHeader('Cache-Control', SOUND_CACHE)
  return res.status(200).json(sound)
})
