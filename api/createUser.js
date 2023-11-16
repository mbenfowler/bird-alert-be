const { configDotenv } = require("dotenv")
import getUserExists from "./getUserExists"

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  
  const { email, password } = req.query

  const isDuplicate = await getUserExists(email)

  if (isDuplicate.userExists) {
    // Handle duplicate email error on the frontend
    console.error('Duplicate email detected');
    return;
  }

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
    console.error("Error creating user:", error);
    if (error.response && error.response.body) {
      console.log("Response body:", error.response.body);
    }
    res.status(500).json({ error })
  }
}
