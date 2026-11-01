const { route, HttpError } = require('../lib/http')
const db = require('../lib/db')
const { assertSpecies } = require('../lib/ebird')
const { findOrCreateBirds } = require('../lib/enrich')
const { withAba } = require('../lib/abaCodes')
const { withTips } = require('../lib/tips')
const { localize } = require('../lib/birdNames')
const { normalizeLocale, ebirdLocale } = require('../lib/i18n')

const MAX_CODES = 50
const MAX_RESULTS = 50

// Bird records never change once stored, so let browsers and the CDN hold them.
const BIRDS_CACHE = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'

// GET /api/birds?codes=a,b,c  -> birds for those eBird species codes, in request order (unknown codes are
//                                resolved from eBird plus image and wiki lookups and stored), each with
//                                `tips: { habitat, look, time } | null`, our field craft for the species
// GET /api/birds?q=term       -> up to 50 stored birds whose common name contains the term
// ?locale=es-MX: names in that language (and search matches them), keyed by URL like the rest.
module.exports = route(['GET'], async (req, res) => {
  const { codes, q } = req.query
  const locale = normalizeLocale(req.query.locale)

  if (typeof codes === 'string') {
    const list = codes.split(',').map((code) => code.trim()).filter(Boolean).map(assertSpecies)
    if (!list.length) return res.status(200).json([])
    if (list.length > MAX_CODES) throw new HttpError(400, `At most ${MAX_CODES} codes per request`)
    // `aba`: the ABA Checklist code (credited wherever the app shows it), or null.
    const birds = await withAba(withTips(await findOrCreateBirds(list)))
    res.setHeader('Cache-Control', BIRDS_CACHE)
    return res.status(200).json(locale ? await localize(birds, locale) : birds)
  }

  if (typeof q === 'string') {
    const term = q.trim()
    if (term.length < 2) return res.status(200).json([])
    const like = `%${term.replace(/[%_]/g, '\\$&')}%`
    // In another language, a bird matches by its name there too (eBird's translations, once fetched).
    const code = ebirdLocale(locale)
    const translated = code === 'en' ? [] : await db('taxonomy_names').where({ locale: code }).whereILike('com_name', like).limit(MAX_RESULTS).pluck('species_code')
    const birds = await db('birds')
      .where((w) => { w.whereILike('comName', like); if (translated.length) w.orWhereIn('speciesCode', translated) })
      .orderBy('comName')
      .limit(MAX_RESULTS)
    // Short, because a bird stored by an enrichment moments ago should turn up in search promptly.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60')
    return res.status(200).json(locale ? await localize(birds, locale) : birds)
  }

  throw new HttpError(400, 'Provide either codes or q')
})
