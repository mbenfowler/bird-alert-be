const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  try {
    const birds = await db('birds').select()
    res.status(200).json(birds);
  } catch (error) {
    res.status(500).json({ error });
  }
}
