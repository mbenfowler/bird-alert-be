const { configDotenv } = require("dotenv")

configDotenv()
const db = require(env.process.PROD_PG_URL)

app.get('/api/v1/saved', async (req, res) => {
  await db('saved_birds').where('user_id', 1).select('bird_id')
    .then(birdIds => {
      const birdPromises = birdIds.map(birdId => {
        return db('birds').where('id', birdId.bird_id).first()
      })
      Promise.all(birdPromises)
        .then(birds => res.status(200).json(birds))
        .catch(error => res.status(500).json({ error }))
    })
    .catch(error => res.status(500).json({ error }))
})
