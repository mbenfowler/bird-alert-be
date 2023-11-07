const { configDotenv } = require("dotenv")
const express = require('express');
const cors = require('cors');

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

const app = express();
app.use(cors());

module.exports = async (req, res) => {
  try {
    const bird = req.body;
    const birdFromDB = await db('birds').where('speciesCode', bird.speciesCode).first();
    
    if (birdFromDB) {
      await db('saved_birds').where('bird_id', birdFromDB.id).del();
      res.status(200).json(birdFromDB);
    } else {
      res.status(404).json({ error: 'Bird not found' });
    }
  } catch (error) {
    res.status(500).json({ error });
  }
};
