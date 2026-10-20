const { route, body, HttpError } = require('../lib/http')
const db = require('../lib/db')
const { requireUser } = require('../lib/auth')
const { assertSpecies } = require('../lib/ebird')
const { findOrCreateBirds } = require('../lib/enrich')

const savedBirdsFor = (userId) =>
  db('saved_birds')
    .join('birds', 'birds.id', 'saved_birds.bird_id')
    .where('saved_birds.user_id', userId)
    .select('birds.*')
    .orderBy('birds.taxonOrder')

// GET    /api/saved                      -> bird[]
// POST   /api/saved { speciesCode }      -> bird (idempotent; unknown codes are resolved and stored)
// DELETE /api/saved?speciesCode=         -> 204 (idempotent)
module.exports = route(['GET', 'POST', 'DELETE'], async (req, res) => {
  const user = await requireUser(req)

  if (req.method === 'GET') {
    return res.status(200).json(await savedBirdsFor(user.id))
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
    return res.status(201).json(bird)
  }

  const { speciesCode } = req.query
  if (!speciesCode) throw new HttpError(400, 'speciesCode is required')
  await db('saved_birds').where({ user_id: user.id, speciesCode }).del()
  return res.status(204).end()
})
