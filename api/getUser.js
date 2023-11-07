const { configDotenv } = require("dotenv")

configDotenv()
const db = require(env,process.PROD_PG_URL)

app.get('/api/v1/user/:id', async (req, res) => {
  const userId = req.params.id;
  await db('users').where({id: userId}).first()
    .then(user => res.status(200).json(user))
    .catch(error => res.status(500).json({ error }))
})
