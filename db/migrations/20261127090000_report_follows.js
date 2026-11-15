/**
 * Following rare-bird reports after people are told of them (lib/reportFollows). rare_reports holds
 * each unconfirmed report someone was alerted to, once, with what was known when it went out (photo,
 * birders, a written description) and how it ended: confirmed by a reviewer, gone from eBird
 * (withdrawn or not accepted), or still unreviewed after the follow window. That record is also how
 * we learn which reports hold up. report_follows says who was told and how (push or email), and when
 * each heard the outcome. checklist_notes caches which species on a checklist the observer described.
 * The HQ desk's alerts link to their report, with the pick kept so a confirmation can bring fresh drafts.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('rare_reports', (table) => {
    table.increments('id')
    table.string('species_code', 16).notNullable()
    table.string('sub_id', 16).notNullable()
    table.string('loc_id', 16)
    table.string('loc_name', 200)
    table.string('region', 16).notNullable()
    table.integer('aba')
    table.string('obs_dt', 16)
    table.float('lat')
    table.float('lng')
    table.boolean('media').notNullable().defaultTo(false)
    table.integer('birders').notNullable().defaultTo(1)
    table.boolean('described')
    table.string('outcome', 12).notNullable().defaultTo('pending')
    table.timestamp('missing_since', { useTz: true })
    table.timestamp('settled_at', { useTz: true })
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.unique(['species_code', 'sub_id'])
    table.index(['outcome', 'region'])
  })
  await knex.schema.createTable('report_follows', (table) => {
    table.increments('id')
    table.integer('report_id').notNullable().references('id').inTable('rare_reports').onDelete('CASCADE')
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('via', 8).notNullable()
    table.timestamp('told_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('pushed_at', { useTz: true })
    table.date('mailed_on')
    table.unique(['report_id', 'user_id', 'via'])
    table.index(['user_id'])
  })
  await knex.schema.createTable('checklist_notes', (table) => {
    table.string('sub_id', 16).primary()
    table.specificType('described', 'text[]').notNullable()
    table.timestamp('fetched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
  await knex.schema.alterTable('hq_alerts', (table) => {
    table.integer('report_id').references('id').inTable('rare_reports').onDelete('SET NULL')
    table.string('share_url', 200)
    table.jsonb('pick')
    table.timestamp('outcome_told_at', { useTz: true })
  })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('hq_alerts', (table) => {
    table.dropColumn('report_id'); table.dropColumn('share_url'); table.dropColumn('pick'); table.dropColumn('outcome_told_at')
  })
  await knex.schema.dropTable('checklist_notes')
  await knex.schema.dropTable('report_follows')
  await knex.schema.dropTable('rare_reports')
}
