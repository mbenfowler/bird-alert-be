/**
 * A weekly tally per hotspot, kept for good: checklists, species and the best list each week. The
 * checklists behind it are pruned after 90 days to keep the free plan small, so without this a
 * question like "the most productive hotspots in the third week of July" could never be answered
 * from our own data. A row per hotspot per week it was birded: a few MB a year.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('hotspot_weeks', (table) => {
    table.string('loc_id', 16).notNullable()
    table.string('region', 16).notNullable()
    // The Monday the week starts on.
    table.date('week_start').notNullable()
    table.integer('checklists').notNullable()
    table.integer('species').notNullable()
    table.integer('best_list')
    table.string('best_sub_id', 16)
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.primary(['loc_id', 'week_start'])
    table.index(['region', 'week_start'])
  })
}
exports.down = async function (knex) {
  await knex.schema.dropTable('hotspot_weeks')
}
