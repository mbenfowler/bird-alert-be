/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
const crypto = require('crypto')
const bcrypt = require('bcryptjs')

// Seed accounts get a random password that is never written down: the repository is public, so a
// fixed one here would be everyone's. Sign in with "Forgot password?" to set a real one.
const password_hash = bcrypt.hashSync(crypto.randomBytes(32).toString('base64url'), 10)

exports.seed = async function(knex) {
  try {
    await knex('users').insert({
      password_hash,
      email: 'birder@example.com',
      location: '',
      state: ''
    }, 'id')
    await knex('users').insert({
      password_hash,
      email: 'robin@example.com',
      location: 'US-GA-139',
      state: 'GA'
    }, 'id')
    await knex('users').insert({
      password_hash,
      email: 'wren@example.com',
      location: 'US-GA-139',
      state: 'GA'
    }, 'id')
  } catch (error) {
    console.log(`Error seeding user data: ${error}`)
  }
};
