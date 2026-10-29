/**
 * Nothing looks history rows up by place (the where-to-find query filters by region, species
 * and day), so this index only cost space: 1.8 MB of the table's 23 MB, used 58 times ever.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('region_species_days', (table) => { table.dropIndex(['region', 'locId']) })
}
exports.down = async function (knex) {
  await knex.schema.alterTable('region_species_days', (table) => { table.index(['region', 'locId']) })
}
