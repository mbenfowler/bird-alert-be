const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  const user = req.query;
  
  try {
    const updateUser = {
      email: user.email,
      updated_at: new Date()
    };

    user.password && (updateUser.password = user.password)
    user.state && (updateUser.state = user.state)
    user.location && (updateUser.location = user.location)
    user.phone && (updateUser.phone = user.phone)

    await db('users').where({email: user.email}).update(updateUser);

    res.status(200).json(user);
  } catch (error) {
    console.error('Error updating user:', error)
    res.status(500).json({ error });
  }
};
