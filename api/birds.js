const { route, HttpError } = require('../lib/http')
const db = require('../lib/db')

const MAX_CODES = 50
const MAX_RESULTS = 50

// GET /api/birds?codes=a,b,c  -> birds we already know about, in any order
// GET /api/birds?q=term       -> up to 50 birds whose common name contains the term
module.exports = route(['GET'], async (req, res) => {
  const { codes, q } = req.query

  if (typeof codes === 'string') {
    const list = [...new Set(codes.split(',').map((code) => code.trim()).filter(Boolean))]
    if (!list.length) return res.status(200).json([])
    if (list.length > MAX_CODES) throw new HttpError(400, `At most ${MAX_CODES} codes per request`)
    const birds = await db('birds').whereIn('speciesCode', list)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    return res.status(200).json(birds)
  }

  if (typeof q === 'string') {
    const term = q.trim()
    if (term.length < 2) return res.status(200).json([])
    const birds = await db('birds')
      .whereILike('comName', `%${term.replace(/[%_]/g, '\\$&')}%`)
      .orderBy('comName')
      .limit(MAX_RESULTS)
    return res.status(200).json(birds)
  }

  throw new HttpError(400, 'Provide either codes or q')
})
