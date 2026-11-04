/**
 * The event recap (lib/eventRecap):
 * - event_recaps: the recap frozen once its fix window closes (48 hours after the tally does), so a
 *   life list changed later never rewrites who got which lifer. `data` is the members' view in
 *   English, with what the public view needs to leave personal spots out; it's named and redacted
 *   when read.
 * - event_members.recap_notice_at: the "your recap is ready" email, claimed before it goes, so it
 *   goes to each member once.
 * - event_scout_birds: the bird of the day each morning's scouting email led with, one a day per
 *   event, so the recap can say the scouting called it. Nothing kept it before, so events scouted
 *   before this have none.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('event_recaps', (table) => {
    table.integer('event_id').primary().references('id').inTable('events').onDelete('CASCADE')
    table.jsonb('data').notNullable()
    table.timestamp('sealed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable('event_members', (table) => {
    table.timestamp('recap_notice_at', { useTz: true })
  })
  await knex.schema.createTable('event_scout_birds', (table) => {
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE')
    table.date('day').notNullable()
    table.string('species_code', 16).notNullable()
    table.primary(['event_id', 'day'])
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('event_scout_birds')
  await knex.schema.alterTable('event_members', (table) => { table.dropColumn('recap_notice_at') })
  await knex.schema.dropTableIfExists('event_recaps')
}
