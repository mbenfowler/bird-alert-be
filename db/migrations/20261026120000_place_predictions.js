/**
 * What the ranking said about each place, kept so it can be graded a week later against the
 * checklists that followed. Accuracy per band is what lets the app put a number on a band.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('place_predictions', (table) => {
    table.increments('id')
    table.string('region').notNullable()
    table.string('species_code').notNullable()
    table.string('loc_id').notNullable()
    table.date('as_of').notNullable()
    table.string('band', 12).notNullable()
    table.decimal('score', 8, 3)
    table.integer('detection')
    table.integer('effort')
    table.string('class', 12)
    table.integer('visits')
    table.boolean('outcome')
    table.timestamp('graded_at', { useTz: true })
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.unique(['region', 'species_code', 'loc_id', 'as_of'])
    table.index(['region', 'as_of'])
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTable('place_predictions')
}
