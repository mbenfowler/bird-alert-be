/**
 * The life list: birds a person has seen (tapped "Seen it" or imported from eBird), eBird's
 * taxonomy for matching an export's names to species codes, and the lifer alert preference.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('seen_birds', (table) => {
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('species_code', 12).notNullable()
    table.date('first_seen')
    table.string('source', 8).notNullable().defaultTo('tap')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.primary(['user_id', 'species_code'])
  })
  await knex.schema.createTable('taxonomy_ref', (table) => {
    table.string('species_code', 12).primary()
    table.string('sci_name').notNullable().index()
    table.string('com_name').notNullable()
    table.string('category', 12).notNullable()
    table.string('report_as', 12)
    table.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable('users', (table) => { table.boolean('push_lifer_enabled').notNullable().defaultTo(false) })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.dropColumn('push_lifer_enabled') })
  await knex.schema.dropTable('taxonomy_ref')
  await knex.schema.dropTable('seen_birds')
}
