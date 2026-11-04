/**
 * Event day, from the Big Day dry run:
 * - events.timezone: the zone the event's days are judged in (lib/timezones zoneForArea, from its
 *   area and spot), so "today", "over" and "is the tally open" are the same for every member
 *   whatever their account says. Filled for existing events here; null where the area can't say
 *   (the member's own zone stands in, as before).
 * - event_tally keeps who found each bird, when and where: an id (for marks and the log), the
 *   app's client_id (a retried add is the same add), observed_at (the sighting, which may be long
 *   before it synced), lat/lng rounded to 3 decimals and the nearest stop of the group's route.
 *   Removing a bird keeps the row (removed_at, removed_by), so undo or a re-add brings back its
 *   finder and time.
 * - event_tally_marks: "on my eBird checklist", ticked by each member for themselves.
 */
const { zoneForArea } = require('../../lib/timezones')

exports.up = async function (knex) {
  await knex.schema.alterTable('events', (table) => {
    table.string('timezone', 64)
  })
  const events = await knex('events').select('id', 'state', 'location', 'home_lat', 'home_lng')
  for (const event of events) {
    const zone = zoneForArea(event)
    if (zone) await knex('events').where({ id: event.id }).update({ timezone: zone })
  }

  await knex.schema.alterTable('event_tally', (table) => {
    table.increments('id', { primaryKey: false })
    table.uuid('client_id')
    table.timestamp('observed_at', { useTz: true })
    table.double('lat')
    table.double('lng')
    table.integer('stop_index')
    table.timestamp('removed_at', { useTz: true })
    table.integer('removed_by').references('id').inTable('users').onDelete('SET NULL')
    table.unique(['id'])
    table.unique(['event_id', 'client_id'])
  })
  await knex('event_tally').whereNull('observed_at').update({ observed_at: knex.ref('added_at') })

  await knex.schema.createTable('event_tally_marks', (table) => {
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE')
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.integer('tally_id').notNullable().references('id').inTable('event_tally').onDelete('CASCADE')
    table.timestamp('marked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.unique(['user_id', 'tally_id'])
    table.index(['event_id', 'user_id'])
  })
}

// Removed birds go for good on the way down, as they would have before.
exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('event_tally_marks')
  await knex('event_tally').whereNotNull('removed_at').del()
  await knex.schema.alterTable('event_tally', (table) => {
    table.dropUnique(['event_id', 'client_id'])
    table.dropUnique(['id'])
    table.dropColumn('removed_by')
    table.dropColumn('removed_at')
    table.dropColumn('stop_index')
    table.dropColumn('lng')
    table.dropColumn('lat')
    table.dropColumn('observed_at')
    table.dropColumn('client_id')
    table.dropColumn('id')
  })
  await knex.schema.alterTable('events', (table) => { table.dropColumn('timezone') })
}
