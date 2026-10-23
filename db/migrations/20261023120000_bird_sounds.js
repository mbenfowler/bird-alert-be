/**
 * One representative recording per species, chosen from xeno-canto and kept so a species is looked
 * up there once (a row with no xc_id records that nothing suitable was found, so the search is not
 * repeated on every play).
 */
exports.up = async function (knex) {
  await knex.schema.createTable('bird_sounds', (table) => {
    table.string('species_code').primary()
    table.integer('xc_id')
    table.text('url')
    table.text('type')
    table.string('quality', 1)
    table.integer('length_s')
    table.text('recordist')
    table.text('license')
    table.text('country')
    table.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTable('bird_sounds')
}
