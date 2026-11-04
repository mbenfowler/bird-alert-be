/**
 * event_scout_birds.species: every bird that day's scouting email named (its bird of the day, what's
 * new, the targets reported lately, what else is about this week), each with the spot the report
 * placed it, as [{ code, loc, locName }]. The recap (lib/eventRecap) says which of the birds found
 * the scouting had pointed to. "Email me the scouting report now" adds to the same day's row.
 *
 * species_code (the bird of the day) can now be empty: a report asked for with no target about has
 * no bird of the day, yet it still named birds.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('event_scout_birds', (table) => {
    table.jsonb('species')
    table.string('species_code', 16).nullable().alter()
  })
}

exports.down = async function (knex) {
  await knex('event_scout_birds').whereNull('species_code').del()
  await knex.schema.alterTable('event_scout_birds', (table) => {
    table.dropColumn('species')
    table.string('species_code', 16).notNullable().alter()
  })
}
