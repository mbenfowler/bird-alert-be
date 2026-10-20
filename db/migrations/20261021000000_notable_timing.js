/**
 * Notable pushes go out right away by default; a user can opt into batching them instead.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.boolean('push_notable_batched').notNullable().defaultTo(false)
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.dropColumn('push_notable_batched') })
}
