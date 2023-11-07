const { knex } = require('knex')
const { configDotenv } = require("dotenv")

configDotenv()

const configuration = require('./knexfile')
const db = require('knex')(configuration)

module.exports = async (req, res) => {  
  try {
    const user = await db('users').first()
    res.status(200).json(user)
  } catch (error) {
    res.status(500).json({ error })
  }
}
