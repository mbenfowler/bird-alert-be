/** Ideas and problem reports from the people using the app, kept even if the email to the owner fails. */
exports.up = async function (knex) {
  await knex.schema.createTable('feedback', (table) => {
    table.increments('id').primary()
    table.integer('user_id').references('id').inTable('users').onDelete('SET NULL').index()
    table.string('kind', 12).notNullable()
    table.text('message').notNullable()
    table.string('page', 200)
    table.string('user_agent', 300)
    table.boolean('emailed').notNullable().defaultTo(false)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
}
exports.down = async function (knex) {
  await knex.schema.dropTable('feedback')
}
