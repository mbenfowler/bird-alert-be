/**
 * When a person finished (or skipped) the short setup after signing up. Everyone who already had
 * an account counts as set up, so only new accounts see it.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.timestamp('onboarded_at', { useTz: true }) })
  await knex('users').update({ onboarded_at: knex.fn.now() })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.dropColumn('onboarded_at') })
}
