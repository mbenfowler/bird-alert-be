/**
 * Someone who asked for watch-list alerts but has no phone or browser subscribed to push gets the
 * daily watch-list email instead. This records whether they still want that fallback: true until
 * they unsubscribe from it, so it can be told apart from never having chosen the email digest.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.boolean('watchlist_email_fallback').notNullable().defaultTo(true) })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.dropColumn('watchlist_email_fallback') })
}
