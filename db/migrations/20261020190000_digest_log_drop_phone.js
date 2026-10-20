/**
 * Records each digest email so a rerun never double-sends and "did it go out?" is answerable.
 * Drops the phone column, which nothing used.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.createTable('digest_log', (table) => {
    table.increments('id').primary()
    table.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE')
    table.string('kind').notNullable()
    table.date('sent_on').notNullable()
    table.integer('alerts').notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.unique(['user_id', 'kind', 'sent_on'])
  })
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('phone')
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.string('phone')
  })
  await knex.schema.dropTable('digest_log')
}
