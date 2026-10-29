// A user's saved birds go with the account. The 2023 table was made without ON DELETE, so deleting
// a user failed while they had any; every later table that points at users already cascades.
exports.up = async (knex) => {
  await knex.schema.alterTable('saved_birds', (table) => {
    table.dropForeign('user_id')
    table.foreign('user_id').references('id').inTable('users').onDelete('CASCADE')
  })
}

exports.down = async (knex) => {
  await knex.schema.alterTable('saved_birds', (table) => {
    table.dropForeign('user_id')
    table.foreign('user_id').references('id').inTable('users')
  })
}
