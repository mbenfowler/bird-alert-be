const crypto = require('crypto')

/**
 * Events stand on their own: places are the spots you keep, events the dated outings (solo or with a
 * group). So a member can be in an event before choosing a name the group sees (a solo event has no
 * group to see it), each member keeps their own history (archive) and their own trip notes, and an
 * event remembers the place it was planned from. Every trip becomes a solo event at its place, with
 * the place's target birds, and the trips go: nothing makes trips any more.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('event_members', (table) => {
    table.string('display_name', 40).nullable().alter()
    table.timestamp('archived_at', { useTz: true })
    table.timestamp('started_notice_at', { useTz: true })
    table.timestamp('ending_notice_at', { useTz: true })
    table.timestamp('return_seen_at', { useTz: true })
  })
  await knex.schema.alterTable('events', (table) => {
    table.integer('place_id').references('id').inTable('places').onDelete('SET NULL')
  })

  const token = () => crypto.randomBytes(16).toString('base64url')
  const trips = await knex('trips').join('places', 'places.id', 'trips.place_id')
    .select('trips.*', 'places.user_id', 'places.name', 'places.state', 'places.location', 'places.range_mi', 'places.home_lat', 'places.home_lng')
  for (const trip of trips) {
    const [event] = await knex('events').insert({
      owner_id: trip.user_id,
      place_id: trip.place_id,
      name: trip.name,
      state: trip.state,
      location: trip.location,
      range_mi: trip.range_mi,
      home_lat: trip.home_lat,
      home_lng: trip.home_lng,
      starts_on: trip.starts_on,
      ends_on: trip.ends_on,
      kind: trip.kind || 'trip',
      scout: Boolean(trip.scout),
      scout_days: trip.scout_days || 21,
      invite_token: token(),
      view_token: token()
    }).returning('id')
    const eventId = event.id ?? event
    await knex('event_members').insert({
      event_id: eventId,
      user_id: trip.user_id,
      display_name: null,
      role: 'organizer',
      last_scout_sent_on: trip.last_scout_sent_on,
      started_notice_at: trip.started_notice_at,
      ending_notice_at: trip.ending_notice_at,
      return_seen_at: trip.return_seen_at
    })
    const targets = await knex('place_targets').where({ place_id: trip.place_id }).pluck('species_code')
    if (targets.length) await knex('event_targets').insert(targets.map((code) => ({ event_id: eventId, species_code: code, added_by: trip.user_id })))
  }
  await knex('trips').del()
}

// The schema goes back; events made from trips stay events (the trips aren't recreated).
exports.down = async function (knex) {
  await knex.schema.alterTable('events', (table) => { table.dropColumn('place_id') })
  await knex('event_members').whereNull('display_name').update({ display_name: 'Me' })
  await knex.schema.alterTable('event_members', (table) => {
    table.dropColumn('archived_at')
    table.dropColumn('started_notice_at')
    table.dropColumn('ending_notice_at')
    table.dropColumn('return_seen_at')
    table.string('display_name', 40).notNullable().alter()
  })
}
