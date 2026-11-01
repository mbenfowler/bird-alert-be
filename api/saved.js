const { localize } = require('../lib/birdNames')
const { route, body, HttpError } = require('../lib/http')
const db = require('../lib/db')
const { requireUser } = require('../lib/auth')
const { assertSpecies } = require('../lib/ebird')
const { findOrCreateBirds } = require('../lib/enrich')
const { getRoute, putRoute } = require('../lib/savedRoutes')
const { importLifeList, seenList, markSeen, unmarkSeen } = require('../lib/lifeList')
const { splitEvidence } = require('../lib/splitEvidence')
const { createShare } = require('../lib/shares')
const { sendFeedback } = require('../lib/feedback')

const savedBirdsFor = (userId) =>
  db('saved_birds')
    .join('birds', 'birds.id', 'saved_birds.bird_id')
    .where('saved_birds.user_id', userId)
    .select('birds.*')
    .orderBy('birds.taxonOrder')

// GET    /api/saved                      -> bird[]
// POST   /api/saved { speciesCode }      -> bird (idempotent; unknown codes are resolved and stored)
// DELETE /api/saved?speciesCode=         -> 204 (idempotent)
// GET    /api/saved?kind=route&region=   -> { region, stops: point[] | null, start: point | null, updatedAt }
// PUT    /api/saved?kind=route { region, stops?, start? } -> the same; stops null goes back to the suggested route
//   (a point is { locId, name, lat, lng, note }; the route rides on this function so it costs no function slot)
// GET    /api/saved?kind=seen                    -> [{ speciesCode, firstSeen, source }] the life list
// POST   /api/saved?kind=seen { speciesCode }    -> 201 (idempotent) "Seen it"
// DELETE /api/saved?kind=seen&speciesCode=       -> 204
// POST   /api/saved?kind=seen&import=1 { csv }   -> { added, already, skipped: [{ name, reason, choices?, where? }], total } from eBird's life list export
// POST   /api/saved?kind=seen&evidence=1 { choices: [{ speciesCode, comName }], locId?, region?, day }
//   -> { area, sampled, lean, strength: clear|mixed|thin, ranked: [{ speciesCode, comName, days }] } which of a slash it likely was, from local reports
module.exports = route(['GET', 'POST', 'PUT', 'DELETE'], async (req, res) => {
  const user = await requireUser(req)
  // Private and per person, so birds are named in the person's own language.
  const named = (data) => localize(data, user.locale)

  if (req.query.kind === 'route') {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'GET') return res.status(200).json(await getRoute(user.id, String(req.query.region || '')))
    if (req.method === 'PUT') return res.status(200).json(await putRoute(user.id, body(req)))
    throw new HttpError(405, 'Method not allowed')
  }
  // POST /api/saved?kind=feedback { kind: 'idea' | 'bug' | 'other', message, page? } -> { ok } emailed to the owner, reply-to the sender
  if (req.query.kind === 'feedback') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
    return res.status(201).json(await sendFeedback(user, body(req), { userAgent: req.headers['user-agent'] }))
  }
  // POST /api/saved?kind=share { kind: 'route' | 'sighting', ... } -> { id, url } a read-only link anyone can open
  if (req.query.kind === 'share') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
    return res.status(201).json(await createShare(user.id, body(req)))
  }
  if (req.query.kind === 'seen') {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'GET') return res.status(200).json(await seenList(user.id))
    if (req.method === 'POST' && req.query.evidence === '1') return res.status(200).json(await named(await splitEvidence(body(req))))
    if (req.method === 'POST' && req.query.import === '1') return res.status(200).json(await importLifeList(user.id, body(req).csv))
    const code = assertSpecies(String(req.method === 'POST' ? body(req).speciesCode || '' : req.query.speciesCode || ''))
    if (req.method === 'POST') { await markSeen(user.id, code); return res.status(201).json({ speciesCode: code }) }
    if (req.method === 'DELETE') { await unmarkSeen(user.id, code); return res.status(204).end() }
    throw new HttpError(405, 'Method not allowed')
  }
  if (req.method === 'PUT') throw new HttpError(405, 'Method not allowed')

  if (req.method === 'GET') {
    return res.status(200).json(await named(await savedBirdsFor(user.id)))
  }

  if (req.method === 'POST') {
    const { speciesCode } = body(req)
    if (!speciesCode) throw new HttpError(400, 'speciesCode is required')
    const [bird] = await findOrCreateBirds([assertSpecies(String(speciesCode))])
    if (!bird) throw new HttpError(404, `Unknown species code ${speciesCode}`)
    await db('saved_birds')
      .insert({ user_id: user.id, bird_id: bird.id, speciesCode: bird.speciesCode })
      .onConflict(['user_id', 'bird_id'])
      .ignore()
    return res.status(201).json(await named(bird))
  }

  const { speciesCode } = req.query
  if (!speciesCode) throw new HttpError(400, 'speciesCode is required')
  await db('saved_birds').where({ user_id: user.id, speciesCode }).del()
  return res.status(204).end()
})
