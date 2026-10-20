const { route, HttpError } = require('../lib/http')
const db = require('../lib/db')
const { assertSpecies } = require('../lib/ebird')
const { findOrCreateBirds } = require('../lib/enrich')

const MAX_CODES = 50
const MAX_RESULTS = 50

// Bird records never change once stored, so let browsers and the CDN hold them.
const BIRDS_CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'

// GET /api/birds?codes=a,b,c  -> birds for those eBird species codes, in request order (unknown codes are
//                                resolved from eBird plus image and wiki lookups and stored)
// GET /api/birds?q=term       -> up to 50 stored birds whose common name contains the term
module.exports = route(['GET'], async (req, res) => {
  const { codes, q } = req.query

  if (typeof codes === 'string') {
    const list = codes.split(',').map((code) => code.trim()).filter(Boolean).map(assertSpecies)
    if (!list.length) return res.status(200).json([])
    if (list.length > MAX_CODES) throw new HttpError(400, `At most ${MAX_CODES} codes per request`)
    const birds = await findOrCreateBirds(list)
    res.setHeader('Cache-Control', BIRDS_CACHE)
    return res.status(200).json(birds)
  }

  if (typeof q === 'string') {
    const term = q.trim()
    if (term.length < 2) return res.status(200).json([])
    const birds = await db('birds')
      .whereILike('comName', `%${term.replace(/[%_]/g, '\\$&')}%`)
      .orderBy('comName')
      .limit(MAX_RESULTS)
    res.setHeader('Cache-Control', 'public, max-age=300')
    return res.status(200).json(birds)
  }

  throw new HttpError(400, 'Provide either codes or q')
})
