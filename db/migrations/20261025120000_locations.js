/**
 * Where, not just what. The daily history keeps the location and time of each species' report so a
 * hotspot can be judged by its own past; checklists and their species are kept so a location's
 * detection rate (reports over effort), the birders' notes and the media counts are on hand.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('region_species_days', (table) => {
    table.string('locId')
    table.string('locName')
    table.string('obsTime', 5)
    table.string('subId')
    table.index(['region', 'locId'])
  })
  await knex.schema.alterTable('region_days', (table) => {
    table.boolean('has_locations').notNullable().defaultTo(false)
  })
  await knex.schema.createTable('checklists', (table) => {
    table.string('sub_id').primary()
    table.string('region').notNullable()
    table.string('loc_id').notNullable()
    table.text('loc_name')
    table.decimal('lat', 9, 6)
    table.decimal('lng', 9, 6)
    table.boolean('is_hotspot').notNullable().defaultTo(false)
    table.date('obs_day').notNullable()
    table.string('obs_time', 5)
    table.integer('num_species')
    table.integer('num_observers')
    table.decimal('duration_hrs', 6, 2)
    table.decimal('distance_km', 7, 2)
    table.text('observer')
    table.timestamp('detail_fetched_at', { useTz: true })
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.index(['region', 'obs_day'])
    table.index(['loc_id', 'obs_day'])
  })
  await knex.schema.createTable('checklist_species', (table) => {
    table.string('sub_id').notNullable().references('sub_id').inTable('checklists').onDelete('CASCADE')
    table.string('species_code').notNullable()
    table.integer('how_many')
    table.text('comments')
    table.integer('photos').notNullable().defaultTo(0)
    table.integer('audio').notNullable().defaultTo(0)
    table.integer('video').notNullable().defaultTo(0)
    table.primary(['sub_id', 'species_code'])
    table.index(['species_code'])
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTable('checklist_species')
  await knex.schema.dropTable('checklists')
  await knex.schema.alterTable('region_days', (table) => { table.dropColumn('has_locations') })
  await knex.schema.alterTable('region_species_days', (table) => {
    table.dropIndex(['region', 'locId'])
    table.dropColumn('locId'); table.dropColumn('locName'); table.dropColumn('obsTime'); table.dropColumn('subId')
  })
}
