/** Mail sent per UTC day (so a provider's daily cap is never crossed) and recent server errors. */
exports.up = async function (knex) {
  await knex.schema.createTable('mail_counts', (table) => {
    table.date('day').primary()
    table.integer('sent').notNullable().defaultTo(0)
    table.integer('held').notNullable().defaultTo(0)
  })
  await knex.schema.createTable('error_log', (table) => {
    table.increments('id')
    table.text('where').notNullable()
    table.text('message').notNullable()
    table.timestamp('at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.index(['at'])
  })
}
exports.down = async function (knex) {
  await knex.schema.dropTable('error_log')
  await knex.schema.dropTable('mail_counts')
}
