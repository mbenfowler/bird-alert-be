/**
 * Following up on rare birds announced before eBird's reviewers had looked: push_log learns the
 * bird's ABA code, the county it was reported in and the place's name, and where its review stands
 * ('pending' while unconfirmed, then 'confirmed' or 'dropped'). The hourly run checks the pending
 * ones and tells each person once when one is confirmed. Only ABA Code 3-5 birds are followed.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('push_log', (table) => {
    table.smallint('aba')
    table.string('sighting_region', 16)
    table.text('loc_name')
    table.string('review_state', 12)
    table.timestamp('reviewed_at', { useTz: true })
    table.index(['review_state'])
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('push_log', (table) => {
    table.dropIndex(['review_state'])
    table.dropColumn('aba')
    table.dropColumn('sighting_region')
    table.dropColumn('loc_name')
    table.dropColumn('review_state')
    table.dropColumn('reviewed_at')
  })
}
