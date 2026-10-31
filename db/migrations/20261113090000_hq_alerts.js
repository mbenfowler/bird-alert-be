/**
 * The HQ desk's instant rarity alerts: one row per bird per state each time the owner is told, so
 * a bird reported again later in the week isn't announced twice. The hourly run reads the last
 * seven days of it.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('hq_alerts', (table) => {
    table.increments('id')
    table.string('species_code', 16).notNullable()
    table.string('state', 8).notNullable()
    table.integer('aba').notNullable()
    table.string('first_sub_id', 16)
    table.timestamp('alerted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.index(['species_code', 'state', 'alerted_at'])
  })
}
exports.down = async function (knex) {
  await knex.schema.dropTable('hq_alerts')
}
