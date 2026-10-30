/**
 * An alert range: rare-bird and lifer alerts reach past the county to everything within range_mi
 * of a home spot (the county's center unless the person sets home_lat/home_lng; 0 keeps them to
 * the county). push_log learns the place of each alert, so a bird already announced at a spot
 * isn't announced again from a newer checklist there, whichever feed brings it.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.integer('range_mi').notNullable().defaultTo(30)
    table.double('home_lat')
    table.double('home_lng')
  })
  await knex.schema.alterTable('push_log', (table) => { table.string('loc_id', 32) })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.dropColumn('range_mi'); table.dropColumn('home_lat'); table.dropColumn('home_lng') })
  await knex.schema.alterTable('push_log', (table) => { table.dropColumn('loc_id') })
}
