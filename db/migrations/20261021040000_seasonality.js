/**
 * Seasonality: which species were reported in a region on which days, built from eBird's historic
 * feed and topped up by the hourly job. Powers the "arriving soon" feed, first-of-season pushes,
 * the weekly migration email and the months strip on the sighting page.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.createTable('region_species_days', (table) => {
    table.string('region').notNullable()
    table.date('day').notNullable()
    table.string('speciesCode').notNullable()
    table.primary(['region', 'day', 'speciesCode'])
    table.index(['region', 'speciesCode'])
  })
  // Days we have asked eBird for in full (a fetched day with no reports is still fetched).
  await knex.schema.createTable('region_days', (table) => {
    table.string('region').notNullable()
    table.date('day').notNullable()
    table.integer('species_count').notNullable().defaultTo(0)
    table.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.primary(['region', 'day'])
  })
  // The first report of a returning migrant, once per species per season per region.
  await knex.schema.createTable('season_firsts', (table) => {
    table.increments('id')
    table.string('region').notNullable()
    table.string('speciesCode').notNullable()
    table.date('seen_on').notNullable()
    table.date('last_seen_on')
    table.jsonb('observation')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.index(['region', 'speciesCode'])
  })
  await knex.schema.alterTable('users', (table) => {
    table.boolean('push_first_of_season').notNullable().defaultTo(false)
    table.boolean('migration_email_enabled').notNullable().defaultTo(false)
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('push_first_of_season')
    table.dropColumn('migration_email_enabled')
  })
  await knex.schema.dropTable('season_firsts')
  await knex.schema.dropTable('region_days')
  await knex.schema.dropTable('region_species_days')
}
