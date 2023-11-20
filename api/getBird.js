const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  const { speciesCode } = req.query
  try {
    const bird = await db('birds').where({ speciesCode }).first()
    res.status(200).json(bird || {});
  } catch (error) {
    res.status(500).json({ error })
  }
}
