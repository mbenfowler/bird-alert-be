/**
 * When each person last opened the app (their session check), at most once an hour, for the daily
 * admin numbers and for a polite "we miss you" note one day.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.timestamp('last_seen_at', { useTz: true }) })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.dropColumn('last_seen_at') })
}
