/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
const bcrypt = require('bcryptjs')

// Seed accounts all use the password below; change it before seeding a real database.
const password_hash = bcrypt.hashSync('birdalert', 10)

exports.seed = async function(knex) {
  try {
    await knex('users').insert({
      username: '',
      password_hash,
      email: 'robinware456@gmail.com',
      phone: '555-555-5555',
      location: '',
      state: ''
    }, 'id')
    await knex('users').insert({
      username: '',
      password_hash,
      email: 'mbfowler@gmail.com',
      phone: '555-555-5556',
      location: 'US-GA-139',
      state: 'GA'
    }, 'id')
    await knex('users').insert({
      username: '',
      password_hash,
      email: 'joyce.fowler@bellsouth.net',
      phone: '',
      location: 'US-GA-139',
      state: 'GA'
    }, 'id')
  } catch (error) {
    console.log(`Error seeding user data: ${error}`)
  }
};
