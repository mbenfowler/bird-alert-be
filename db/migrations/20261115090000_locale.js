/**
 * Languages. users.locale (BCP-47: 'en', 'es-MX', 'fr-CA') is the one setting for both the app's
 * words and the bird names; null means English. taxonomy_names keeps eBird's common names per
 * language, fetched a whole language at a time (one call, about 18,600 names) and refreshed
 * monthly, so a bird name in Spanish or French never costs a call of its own.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.string('locale', 16) })
  await knex.schema.createTable('taxonomy_names', (table) => {
    table.string('locale', 16).notNullable()
    table.string('species_code', 16).notNullable()
    table.text('com_name').notNullable()
    table.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.primary(['locale', 'species_code'])
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTable('taxonomy_names')
  await knex.schema.alterTable('users', (table) => { table.dropColumn('locale') })
}
