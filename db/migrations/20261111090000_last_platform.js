/**
 * What each person last opened the app on (ios, android or desktop) and whether it was the app
 * installed to the home screen, for the morning admin numbers: is the iPhone install step what's
 * keeping push alerts from most people? Kept as the latest only, like last_seen_at.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.string('last_platform', 16)
    table.boolean('last_installed')
  })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.dropColumn('last_platform'); table.dropColumn('last_installed') })
}
