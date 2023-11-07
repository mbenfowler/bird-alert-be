const { configDotenv } = require("dotenv")

configDotenv()
const db = require(env.process.PROD_PG_URL)

app.delete('/api/v1/saved', (req, res) => {
  const bird = req.body
  db('birds').where('speciesCode', bird.speciesCode).first()
    .then(bird => {
      db('saved_birds').where('bird_id', bird.id).del()
        .then(() => res.status(200).json(bird))
        .catch(error => res.status(500).json({ error }))
    })
    .catch(error => res.status(500).json({ error }))
})
