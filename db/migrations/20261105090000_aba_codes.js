/**
 * The ABA Checklist's code for each species in the ABA Area (1-2 regular, 3 rare, 4 casual,
 * 5 accidental, 6 extinct or extirpated), used with the ABA's permission to rank the HQ desk's
 * rarities nationally. The checklist is the ABA's copyrighted work, so the data is loaded from
 * their CSV by scripts/load-aba-checklist.js and never kept in this repository.
 */
exports.up = async function (knex) {
  await knex.schema.createTable('aba_codes', (table) => {
    table.string('sci_name', 120).primary()
    table.string('com_name', 120).notNullable()
    table.smallint('code').notNullable()
    table.string('version', 40).notNullable()
    table.index(['com_name'])
  })
}
exports.down = async function (knex) {
  await knex.schema.dropTable('aba_codes')
}
