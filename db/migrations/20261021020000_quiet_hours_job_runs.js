/**
 * Quiet hours for push (in the user's own time zone, reported by their browser), and a record of
 * when each background job last ran so the app can show it.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.smallint('push_quiet_start').defaultTo(22)
    table.smallint('push_quiet_end').defaultTo(6)
    table.string('timezone')
  })
  await knex.schema.createTable('job_runs', (table) => {
    table.string('kind').primary()
    table.timestamp('ran_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.jsonb('detail')
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTable('job_runs')
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('push_quiet_start')
    table.dropColumn('push_quiet_end')
    table.dropColumn('timezone')
  })
}
