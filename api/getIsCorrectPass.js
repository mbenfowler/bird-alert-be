const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  const { email, password } = req.query
  try {
    const user = await db('users').where({ email }).first()
    if (user.password === password) {
      res.status(200).json({ isCorrectPass: true })
    } else {
      res.status(200).json({ isCorrectPass: false })
    }
  } catch (error) {
    res.status(500).json({ error })
  }
}
