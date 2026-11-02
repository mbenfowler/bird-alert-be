/**
 * Group events: a trip shared with a small group (a Big Day with friends). Anyone in the group can
 * change it; an invite link lets people join, a separate view-only link lets anyone see the plan
 * and the day's tally without an account. Each member's own life list still decides their lifers,
 * and each gets their own scouting report (so the day it was sent is kept per member).
 */
exports.up = async function (knex) {
  await knex.schema.createTable('events', (table) => {
    table.increments('id')
    // Who started it; the organizer role on event_members is what counts (an account deleted leaves the group its event).
    table.integer('owner_id').references('id').inTable('users').onDelete('SET NULL')
    table.string('name', 80).notNullable()
    table.string('state', 16).notNullable()
    table.string('location', 32).notNullable()
    table.integer('range_mi').notNullable().defaultTo(30)
    table.double('home_lat')
    table.double('home_lng')
    table.date('starts_on').notNullable()
    table.date('ends_on').notNullable()
    table.string('kind', 8).notNullable().defaultTo('trip')
    table.boolean('scout').notNullable().defaultTo(false)
    table.integer('scout_days').notNullable().defaultTo(21)
    table.string('invite_token', 32).notNullable().unique()
    table.string('view_token', 32).notNullable().unique()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.index(['starts_on', 'ends_on'])
  })
  await knex.schema.createTable('event_members', (table) => {
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE')
    table.integer('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('display_name', 40).notNullable()
    table.string('role', 12).notNullable().defaultTo('member')
    table.timestamp('joined_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.date('last_scout_sent_on')
    table.primary(['event_id', 'user_id'])
    table.index(['user_id'])
  })
  await knex.schema.createTable('event_targets', (table) => {
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE')
    table.string('species_code', 16).notNullable()
    table.integer('added_by').references('id').inTable('users').onDelete('SET NULL')
    table.primary(['event_id', 'species_code'])
  })
  await knex.schema.createTable('event_tally', (table) => {
    table.integer('event_id').notNullable().references('id').inTable('events').onDelete('CASCADE')
    table.string('species_code', 16).notNullable()
    table.integer('added_by').references('id').inTable('users').onDelete('SET NULL')
    table.timestamp('added_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.primary(['event_id', 'species_code'])
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('event_tally')
  await knex.schema.dropTableIfExists('event_targets')
  await knex.schema.dropTableIfExists('event_members')
  await knex.schema.dropTableIfExists('events')
}
