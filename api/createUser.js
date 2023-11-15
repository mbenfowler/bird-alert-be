const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  const { email, password } = req.query
  try {
    await db('users').insert({
      email,
      password,
      username: '',
      phone: '',
      location: '',
      state: ''
    })

    res.status(200).json({ success: true })
  } catch (error) {
    res.status(500).json({ error })
  }
}
