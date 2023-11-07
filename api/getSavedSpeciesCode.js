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
    const speciesCode = req.query.speciesCode; // Change to query parameter
    const bird = await db('saved_birds')
      .where('speciesCode', speciesCode)
      .where('user_id', 1)
      .first();

    res.status(200).json(!!bird);
  } catch (error) {
    res.status(500).json({ error });
  }
};
