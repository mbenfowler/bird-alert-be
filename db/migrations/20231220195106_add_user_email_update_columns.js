/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema
    .alterTable('users', (table) => {
      // Add the new columns
      table.boolean('email_confirmed').defaultTo(false);
      table.boolean('alert_digest_email_enabled').defaultTo(true);
      table.boolean('rare_sightings_email_enabled').defaultTo(true);
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema
    .alterTable('users', (table) => {
      // Remove the added columns if needed
      table.dropColumn('email_confirmed');
      table.dropColumn('alert_digest_email_enabled');
      table.dropColumn('rare_sightings_email_enabled');
    });
};
