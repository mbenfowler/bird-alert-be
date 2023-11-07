const { configDotenv } = require("dotenv")

configDotenv()
const db = require(env.process.PROD_PG_URL)

app.patch('/api/v1/user', async (req, res) => {
  const user = req.body
  await db('users').where('id', 1).update({
    username: user.name,
    password: user.password,
    location: user.location,
    email: user.email,
    phone: user.phone,
    state: user.state,
    updated_at: new Date()
  })
    .then(() => res.status(200).json(user))
    .catch(error => res.status(500).json({ error }))
})
