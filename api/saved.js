const { route, body, HttpError } = require('../lib/http')
const db = require('../lib/db')
const { requireUser } = require('../lib/auth')

const BIRD_FIELDS = [
  'comName', 'sciName', 'speciesCode', 'category', 'order', 'familyCode',
  'familyComName', 'familySciName', 'birdImg', 'wikiURL', 'taxonOrder'
]

const savedBirdsFor = (userId) =>
  db('saved_birds')
    .join('birds', 'birds.id', 'saved_birds.bird_id')
    .where('saved_birds.user_id', userId)
    .select('birds.*')
    .orderBy('birds.taxonOrder')

// GET    /api/saved                      -> bird[]
// POST   /api/saved { ...bird }          -> bird (idempotent)
// DELETE /api/saved?speciesCode=         -> 204 (idempotent)
module.exports = route(['GET', 'POST', 'DELETE'], async (req, res) => {
  const user = await requireUser(req)

  if (req.method === 'GET') {
    return res.status(200).json(await savedBirdsFor(user.id))
  }

  if (req.method === 'POST') {
    const input = body(req)
    if (!input.speciesCode || !input.comName || !input.sciName) {
      throw new HttpError(400, 'speciesCode, comName and sciName are required')
    }
    const birdData = Object.fromEntries(
      BIRD_FIELDS.filter((field) => input[field] !== undefined && input[field] !== null && input[field] !== 'undefined')
        .map((field) => [field, field === 'taxonOrder' ? Number(input[field]) || null : String(input[field])])
    )

    const bird = await db.transaction(async (trx) => {
      await trx('birds').insert(birdData).onConflict('speciesCode').ignore()
      const row = await trx('birds').where({ speciesCode: birdData.speciesCode }).first()
      await trx('saved_birds')
        .insert({ user_id: user.id, bird_id: row.id, speciesCode: row.speciesCode })
        .onConflict(['user_id', 'bird_id'])
        .ignore()
      return row
    })
    return res.status(201).json(bird)
  }

  const { speciesCode } = req.query
  if (!speciesCode) throw new HttpError(400, 'speciesCode is required')
  await db('saved_birds').where({ user_id: user.id, speciesCode }).del()
  return res.status(204).end()
})
