const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  const { email, password } = req.query
  try {
    const user = await db('users').where({ email }).first()
    if (!user) {
      await db('users').insert({ 
        email,
        password,
        username: '',
        phone: '',
        location: '',
        state: ''
      })
    }
  } catch (error) {
    res.status(500).json({ error })
  }
}
