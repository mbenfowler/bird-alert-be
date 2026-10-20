/**
 * Adds the table behind login/forgot-password throttling, drops the never-used username column,
 * and widens the URL columns on birds (Wikipedia image URLs regularly exceed 255 characters).
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.createTable('auth_throttle', (table) => {
    table.string('key').primary()
    table.integer('attempts').notNullable().defaultTo(0)
    table.timestamp('window_start', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('username')
  })
  await knex.schema.alterTable('birds', (table) => {
    table.text('birdImg').alter()
    table.text('wikiURL').alter()
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('birds', (table) => {
    table.string('birdImg').alter()
    table.string('wikiURL').alter()
  })
  await knex.schema.alterTable('users', (table) => {
    table.string('username')
  })
  await knex.schema.dropTable('auth_throttle')
}
