/** Every eBird hotspot in a state, refreshed weekly, so a route can take a stop from anywhere by name. */
exports.up = async function (knex) {
  await knex.schema.createTable('hotspot_ref', (table) => {
    table.string('loc_id').primary()
    table.string('state', 8).notNullable().index()
    table.string('county', 16)
    table.string('name').notNullable()
    table.double('lat').notNullable()
    table.double('lng').notNullable()
    table.integer('species')
    table.integer('checklists')
    table.date('latest')
    table.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
}
exports.down = async function (knex) {
  await knex.schema.dropTable('hotspot_ref')
}
