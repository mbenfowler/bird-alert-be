/**
 * Where the group is on its saved route, shared with every member (the day view's "We're here"):
 * current_stop is a 0-based index into event_routes.stops, -1 for the meeting point (the start),
 * null for none; current_stop_at is when the member tapped it (their phone's clock, a future one
 * taken as now), so a tap made earlier that syncs late from an offline phone never overwrites a
 * newer one; current_stop_by is who tapped it. Kept apart from `version`: moving along the route is
 * never a conflict with someone editing it.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('event_routes', (table) => {
    table.integer('current_stop')
    table.timestamp('current_stop_at', { useTz: true })
    table.integer('current_stop_by').references('id').inTable('users').onDelete('SET NULL')
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('event_routes', (table) => {
    table.dropColumn('current_stop_by')
    table.dropColumn('current_stop_at')
    table.dropColumn('current_stop')
  })
}
