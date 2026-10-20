require('dotenv').config({ quiet: true })
const knex = require('knex')

const environment = process.env.NODE_ENV || 'development'
const config = require('../knexfile')[environment]

// Reuse one pool per serverless container instead of one per handler file.
const db = global.__birdAlertDb || (global.__birdAlertDb = knex(config))

module.exports = db
