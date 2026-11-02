/**
 * A trip can be a Big Day (kind 'bigday'), and any trip can scout: for scout_days before it starts,
 * a daily report says which of the place's target birds have been reported there lately and which
 * haven't. last_scout_sent_on is the person's own date of the last report, so it goes once a day.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('trips', (table) => {
    table.string('kind', 8).notNullable().defaultTo('trip')
    table.boolean('scout').notNullable().defaultTo(false)
    table.integer('scout_days').notNullable().defaultTo(21)
    table.date('last_scout_sent_on')
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('trips', (table) => {
    table.dropColumn('kind')
    table.dropColumn('scout')
    table.dropColumn('scout_days')
    table.dropColumn('last_scout_sent_on')
  })
}
