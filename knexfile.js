require('dotenv').config({ quiet: true })

/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */
module.exports = {
  development: {
    client: 'pg',
    connection: process.env.DEV_PG_URL,
    pool: {
      min: 0,
      max: 5
    },
    migrations: {
      directory: __dirname + '/db/migrations'
    },
    seeds: {
      directory: __dirname + '/db/seeds/dev'
    },
    useNullAsDefault: true
  },
  test: {
    client: 'pg',
    connection: process.env.TEST_PG_URL,
    pool: { min: 0, max: 5 },
    migrations: { directory: __dirname + '/db/migrations' },
    useNullAsDefault: true
  },
  production: {
    client: 'pg',
    connection: process.env.PROD_PG_URL,
    pool: {
      min: 0,
      max: 5
    },
    migrations: {
      directory: __dirname + '/db/migrations'
    },
    seeds: {
      directory: __dirname + '/db/seeds/prod'
    },
    useNullAsDefault: true
  }
};
