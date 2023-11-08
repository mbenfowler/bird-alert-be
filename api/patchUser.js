const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  const user = req.query;

  try {
    await db('users').where('id', 1).update({
      username: user.name,
      password: user.password,
      location: user.location,
      email: user.email,
      phone: user.phone,
      state: user.state,
      updated_at: new Date(),
    });
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ error });
  }
};
