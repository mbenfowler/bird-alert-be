const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  console.log('Received createUser request:', {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body: req.body,
    timestamp: new Date().toISOString(),
  });
  
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
    console.error("Error creating user:", error);
    if (error.response && error.response.body) {
      console.log("Response body:", error.response.body);
    }
    res.status(500).json({ error })
  }
}
