const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  const { email, password } = req.query

  try {
    if (req.method === 'POST') {
      await db.transaction(async (trx) => {
        await trx('users').insert({
          email,
          password,
          username: '',
          phone: '',
          location: '',
          state: ''
        })
      })
  
      console.log('Exiting createUser transaction block successfully.')
    }
    
    res.status(200).json({ success: true })
  } catch (error) {
    console.error("Error creating user:", error);
    if (error.response && error.response.body) {
      console.log("Response body:", error.response.body);
    }
    res.status(500).json({ error })
  }
}
