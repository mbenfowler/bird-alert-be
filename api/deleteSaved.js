const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  try {
    const speciesCode = req.query.speciesCode
    const userEmail = req.query.email
    const birdFromDB = await db('birds').where('speciesCode', speciesCode).first();
    const userFromDB = await db('users').where('email', userEmail).first();
    if (birdFromDB) {
      await db('saved_birds').where('bird_id', birdFromDB.id).where('user_id', userFromDB.id).del();
      res.status(200).json(birdFromDB);
    } else {
      res.status(404).json({ error: 'Bird not found' });
    }
  } catch (error) {
    console.error("Error in deleteSaved:", error);
    res.status(500).json({ error });
  }
};
