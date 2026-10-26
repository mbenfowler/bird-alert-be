exports.up = async function (knex) {
  await knex.schema.alterTable('place_predictions', (table) => { table.integer('chance') })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('place_predictions', (table) => { table.dropColumn('chance') })
}
