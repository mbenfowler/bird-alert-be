const { configDotenv } = require("dotenv")

configDotenv()
const db = require(env.process.PROD_PG_URL)

app.get('/api/v1/saved/:speciesCode', async (req, res) => {
  const speciesCode = req.params.speciesCode;
  const bird = await db('saved_birds')
    .where('speciesCode', speciesCode)
    .where('user_id', 1)
    .first()
  res.json(!!bird);
})
