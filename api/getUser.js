const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {  
  try {
    console.log('Connection URL:', process.env.PROD_PG_URL);
    const user = await db('users').first()
    res.status(200).json(user)
  } catch (error) {
    res.status(500).json({ error })
  }
}
