/**
 * Lets a user choose which sightings get pushed, and records which feed each push came from.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.boolean('push_watchlist_enabled').notNullable().defaultTo(true)
    table.boolean('push_notable_enabled').notNullable().defaultTo(false)
  })
  await knex.schema.alterTable('push_log', (table) => {
    table.string('kind').notNullable().defaultTo('watchlist')
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('push_log', (table) => { table.dropColumn('kind') })
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('push_watchlist_enabled')
    table.dropColumn('push_notable_enabled')
  })
}
