/** Read-only links to a route or a sighting, made by a person to send to anyone. */
exports.up = async function (knex) {
  await knex.schema.createTable('shares', (table) => {
    table.string('id', 12).primary()
    table.string('kind', 10).notNullable()
    table.integer('user_id').references('id').inTable('users').onDelete('SET NULL')
    table.jsonb('payload').notNullable()
    table.integer('views').notNullable().defaultTo(0)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.index(['user_id', 'created_at'])
  })
}
exports.down = async function (knex) {
  await knex.schema.dropTable('shares')
}
