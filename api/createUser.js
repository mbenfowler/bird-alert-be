const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  const { email, password } = req.query
  try {
    console.log('Start of /api/createUser function');
    const userQueryStartTime = Date.now();
    const user = await db('users').where({ email }).first()
    const userQueryDuration = Date.now() - userQueryStartTime;
    console.log('User query duration:', userQueryDuration, 'ms');
    console.log('Received request with email:', email);
    if (!user) {
      await db('users').insert({ 
        email,
        password,
        username: '',
        phone: '',
        location: '',
        state: ''
      })

      const createUserDuration = Date.now() - createUserStartTime;
      console.log('Create user duration:', createUserDuration, 'ms');

      console.log('End of /api/createUser function');

      res.status(200).json({ success: true });
    }
  } catch (error) {
    res.status(500).json({ error })
  }
}
