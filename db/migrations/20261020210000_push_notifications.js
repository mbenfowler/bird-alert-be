/**
 * Web push: one row per browser subscription, and a log of what has been pushed so an observation
 * is never announced twice.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.createTable('push_subscriptions', (table) => {
    table.increments('id').primary()
    table.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE')
    table.text('endpoint').notNullable().unique()
    table.text('p256dh').notNullable()
    table.text('auth').notNullable()
    table.string('user_agent')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.index(['user_id'])
  })
  await knex.schema.createTable('push_log', (table) => {
    table.increments('id').primary()
    table.integer('user_id').unsigned().notNullable().references('users.id').onDelete('CASCADE')
    table.string('speciesCode').notNullable()
    table.string('sub_id').notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.unique(['user_id', 'speciesCode', 'sub_id'])
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTable('push_log')
  await knex.schema.dropTable('push_subscriptions')
}
