/**
 * Strict rare-bird alerts, by choice: a rare (notable) sighting is only alerted once it has proof
 * (an eBird reviewer's OK, a photo or recording, or a second birder). Off by default: most people
 * would rather hear early and judge the evidence themselves. A sighting held back waits in push_log
 * as review_state 'held' (not sent; ignored by the "already sent" checks) until it qualifies.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.boolean('rare_alerts_need_proof').notNullable().defaultTo(false)
  })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => { table.dropColumn('rare_alerts_need_proof') })
}
