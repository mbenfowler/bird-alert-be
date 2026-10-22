/**
 * The latest push sent to each user, with what became of it. iPhone Home Screen apps run push in a
 * context that cannot reach the open page, so a tap is handed to the app through the server: the
 * worker reports the tap here and the open app polls for it.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('push_handoff', (table) => {
    table.integer('user_id').primary().references('id').inTable('users').onDelete('CASCADE')
    table.text('title').notNullable()
    table.text('url').notNullable()
    table.timestamp('sent_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('tapped_at', { useTz: true })
    table.timestamp('offered_at', { useTz: true })
    table.timestamp('opened_at', { useTz: true })
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTable('push_handoff')
}
