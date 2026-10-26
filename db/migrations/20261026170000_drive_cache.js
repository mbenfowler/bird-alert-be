/** Driving routes between points, from OSRM, kept for a month so each pair is asked for once. */
exports.up = async function (knex) {
  await knex.schema.createTable('drive_cache', (table) => {
    table.string('key').primary()
    table.jsonb('detail').notNullable()
    table.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
}
exports.down = async function (knex) {
  await knex.schema.dropTable('drive_cache')
}
