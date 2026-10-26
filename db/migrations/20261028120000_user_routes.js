/** A person's own route per county, and where their day starts, so both follow them across devices. */
exports.up = async function (knex) {
  await knex.schema.createTable('user_routes', (table) => {
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('region', 16).notNullable()
    table.jsonb('stops').notNullable()
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.primary(['user_id', 'region'])
  })
  await knex.schema.alterTable('users', (table) => { table.jsonb('route_start') })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.dropColumn('route_start') })
  await knex.schema.dropTable('user_routes')
}
