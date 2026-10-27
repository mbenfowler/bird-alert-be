/** The HQ desk's daily rarity picks, so a bird isn't pitched twice and Monday can round up the week. */
exports.up = async function (knex) {
  await knex.schema.createTable('hq_picks', (table) => {
    table.increments('id').primary()
    table.date('day').notNullable().index()
    table.string('species_code', 12).notNullable()
    table.string('state', 8).notNullable()
    table.float('score').notNullable()
    table.string('share_id', 12)
    table.jsonb('detail').notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.unique(['day', 'species_code', 'state'])
  })
}
exports.down = async function (knex) {
  await knex.schema.dropTable('hq_picks')
}
