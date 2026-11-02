/**
 * Places: somewhere else a person birds besides home ("Colorado (work)"), each with its own area,
 * alert range, target birds and seen list (like a state list), plus trips (dates they'll be there).
 * While a place is active (a trip covers today, or they said "I'm here now"), alerts follow them
 * there; home keeps alerting too unless they turn that off. Home itself stays on users (state,
 * location, range, home spot). Trip dates are calendar days in the person's own time zone, both
 * ends included.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('places', (table) => {
    table.increments('id')
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.text('name').notNullable()
    table.string('state', 8).notNullable()
    table.string('location', 32).notNullable()
    table.integer('range_mi').notNullable().defaultTo(30)
    table.double('home_lat')
    table.double('home_lng')
    // Whose list makes a bird a "lifer" there: the life list, or this place's own seen list.
    table.string('lifers_scope', 8).notNullable().defaultTo('life')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.index(['user_id'])
  })
  await knex.schema.createTable('place_targets', (table) => {
    table.integer('place_id').notNullable().references('id').inTable('places').onDelete('CASCADE')
    table.string('species_code', 16).notNullable()
    table.primary(['place_id', 'species_code'])
  })
  // Birds seen at a place (like a state list), apart from the life list.
  await knex.schema.createTable('place_seen', (table) => {
    table.integer('place_id').notNullable().references('id').inTable('places').onDelete('CASCADE')
    table.string('species_code', 16).notNullable()
    table.date('seen_on')
    table.primary(['place_id', 'species_code'])
  })
  await knex.schema.createTable('trips', (table) => {
    table.increments('id')
    table.integer('place_id').notNullable().references('id').inTable('places').onDelete('CASCADE')
    table.date('starts_on').notNullable()
    table.date('ends_on').notNullable()
    // The two trip notes by email, each sent once, and when the app's "welcome back" was seen.
    table.timestamp('started_notice_at', { useTz: true })
    table.timestamp('ending_notice_at', { useTz: true })
    table.timestamp('return_seen_at', { useTz: true })
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.index(['place_id', 'ends_on'])
    table.index(['ends_on'])
  })
  await knex.schema.alterTable('users', (table) => {
    table.integer('active_place_id').references('id').inTable('places').onDelete('SET NULL')
    table.boolean('keep_home_alerts').notNullable().defaultTo(true)
    table.boolean('trip_emails_enabled').notNullable().defaultTo(true)
  })
}

exports.down = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('active_place_id')
    table.dropColumn('keep_home_alerts')
    table.dropColumn('trip_emails_enabled')
  })
  await knex.schema.dropTable('trips')
  await knex.schema.dropTable('place_seen')
  await knex.schema.dropTable('place_targets')
  await knex.schema.dropTable('places')
}
