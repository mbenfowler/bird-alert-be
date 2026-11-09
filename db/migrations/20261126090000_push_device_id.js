/**
 * Which device a push subscription belongs to: a random id the app keeps in the browser's storage
 * and sends when it subscribes. A device that subscribes again (an iPhone whose subscription was
 * dropped and renewed) replaces its old row instead of adding one, so dead endpoints don't pile up.
 * Nullable: rows from before this, and browsers that never send one, have none.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('push_subscriptions', (table) => {
    table.string('device_id', 64)
    table.index(['user_id', 'device_id'])
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('push_subscriptions', (table) => {
    table.dropIndex(['user_id', 'device_id'])
    table.dropColumn('device_id')
  })
}
