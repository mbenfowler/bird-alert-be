const crypto = require('crypto')
const bcrypt = require('bcryptjs')

/**
 * Replaces plaintext passwords with bcrypt hashes, normalizes and uniques emails,
 * and prevents duplicate watch-list rows.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('users', (table) => {
    table.string('password_hash')
  })

  const users = await knex('users').select('id', 'email', 'password')
  for (const user of users) {
    // Accounts with no usable password get a random one and must use the reset flow.
    const plaintext = user.password && user.password.length ? user.password : crypto.randomBytes(32).toString('hex')
    await knex('users').where({ id: user.id }).update({
      password_hash: await bcrypt.hash(plaintext, 10),
      email: String(user.email || '').trim().toLowerCase()
    })
  }

  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('password')
    table.string('password_hash').notNullable().alter()
  })

  // IF NOT EXISTS keeps this safe on databases that already carry these indexes.
  await knex.raw('create unique index if not exists users_email_unique on users (email)')
  await knex.raw('create unique index if not exists saved_birds_user_id_bird_id_unique on saved_birds (user_id, bird_id)')
  await knex.raw('create index if not exists saved_birds_user_id_index on saved_birds (user_id)')
}

/**
 * Hashes cannot be reversed, so passwords come back empty.
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw('drop index if exists saved_birds_user_id_index')
  await knex.raw('drop index if exists saved_birds_user_id_bird_id_unique')
  await knex.raw('drop index if exists users_email_unique')
  await knex.schema.alterTable('users', (table) => {
    table.string('password')
    table.dropColumn('password_hash')
  })
}
