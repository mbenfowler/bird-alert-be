/**
 * An event's route, saved for the group: the start (rounded to 2 decimals, as the suggestion's
 * `from`) and up to 8 stops, each a hotspot (locId) or any other point (locId null). Anyone in the
 * event can change it; `version` goes up with each save, so a save made from an older copy is
 * refused (409) rather than quietly undoing someone else's change. No row: the suggested route.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('event_routes', (table) => {
    table.integer('event_id').primary().references('id').inTable('events').onDelete('CASCADE')
    table.jsonb('start')
    table.jsonb('stops').notNullable()
    table.integer('updated_by').references('id').inTable('users').onDelete('SET NULL')
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.integer('version').notNullable().defaultTo(1)
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('event_routes')
}
