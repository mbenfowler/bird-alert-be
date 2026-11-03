/**
 * Rare-bird news for birds still to see, by choice: with users.notable_skip_seen on, a notable
 * sighting of a species already on the person's life list (or the place's own list, at a place
 * whose lifers count against it) isn't pushed or emailed, unless the bird is on their watch list.
 * Off by default: most people still want to hear about any rarity nearby.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.boolean('notable_skip_seen').notNullable().defaultTo(false)
  })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.dropColumn('notable_skip_seen') })
}
