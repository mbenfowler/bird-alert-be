/**
 * What brought someone in, saved once at signup: the referring site's name, a utm_source tag,
 * the share link they arrived on, and the kind of page they landed on. Never a full address.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.jsonb('signup_source') })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.dropColumn('signup_source') })
}
