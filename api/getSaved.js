const { configDotenv } = require("dotenv")

configDotenv()
const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  try {
    const birdIds = await db('saved_birds').where('user_id', 1).select('bird_id');
    const birdPromises = birdIds.map(birdId => {
      return db('birds').where('id', birdId.bird_id).first();
    });
    const birds = await Promise.all(birdPromises);
    res.status(200).json(birds);
  } catch (error) {
    res.status(500).json({ error });
  }
};