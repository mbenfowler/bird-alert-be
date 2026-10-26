/** Public land near a point, looked up once a month: eBird's hotspots and OpenStreetMap's parks. */
exports.up = async function (knex) {
  await knex.schema.createTable('nearby_cache', (table) => {
    table.string('key').primary()
    table.jsonb('detail').notNullable()
    table.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
}
exports.down = async function (knex) {
  await knex.schema.dropTable('nearby_cache')
}
