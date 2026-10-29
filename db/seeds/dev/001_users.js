/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
const bcrypt = require('bcryptjs')

// Local development only: every seed account uses this password, and the repository is public,
// so never run these seeds against a real database (db/seeds/prod has random passwords).
const password_hash = bcrypt.hashSync('birdalert', 10)

exports.seed = async function(knex) {
  try {
    await knex('users').insert({
      password_hash,
      email: 'birder@example.com',
      location: '',
      state: '',
      email_confirmed: false,
      alert_digest_email_enabled: true,
      rare_sightings_email_enabled: true
    }, 'id')
    await knex('users').insert({
      password_hash,
      email: 'robin@example.com',
      location: 'US-GA-139',
      state: 'GA',
      email_confirmed: true,
      alert_digest_email_enabled: true,
      rare_sightings_email_enabled: true
    }, 'id')
    await knex('users').insert({
      password_hash,
      email: 'wren@example.com',
      location: 'US-GA-139',
      state: 'GA',
      email_confirmed: true,
      alert_digest_email_enabled: true,
      rare_sightings_email_enabled: true
    }, 'id')
  } catch (error) {
    console.log(`Error seeding user data: ${error}`)
  }
};
