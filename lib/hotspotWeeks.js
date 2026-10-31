const db = require('./db')
const { today } = require('./seasonality')

/**
 * Folds the recent checklists into hotspot_weeks: for every hotspot and every week (Monday to
 * Sunday) with lists since `days` ago, how many checklists, how many species, and the best list.
 * Weeks are redone in full while they're recent, since checklists and their detail keep arriving for
 * days afterwards; run daily, before the 90-day prune, so a week is final long before its lists go.
 * Species are counted as birders count them: forms and subspecies groups roll up to their species,
 * spuhs, slashes, hybrids and domestics don't count, and a code the taxonomy hasn't told us about
 * yet counts as a species. Only checklists opened in full say which species. Safe to re-run.
 */
const ROLLUP_DAYS = 21

const rollupHotspotWeeks = async ({ days = ROLLUP_DAYS, asOf = today() } = {}) => {
  const result = await db.raw(`
    insert into hotspot_weeks (loc_id, region, week_start, checklists, species, best_list, best_sub_id, updated_at)
    with lists as (
      select sub_id, loc_id, region, date_trunc('week', obs_day)::date as week_start, obs_day, obs_time, num_species, detail_fetched_at
      from checklists
      where is_hotspot and obs_day >= date_trunc('week', cast(:asOf as date) - cast(:days as int))::date and obs_day <= cast(:asOf as date)
    ), per as (
      select loc_id, week_start, max(region) as region, count(*)::int as checklists from lists group by loc_id, week_start
    ), seen as (
      select l.loc_id, l.week_start,
        count(distinct case when t.category in ('issf', 'form') then coalesce(t.report_as, cs.species_code) else cs.species_code end)::int as species
      from lists l
      join checklist_species cs on cs.sub_id = l.sub_id
      left join taxonomy_ref t on t.species_code = cs.species_code
      where l.detail_fetched_at is not null and (t.category is null or t.category in ('species', 'issf', 'form'))
      group by l.loc_id, l.week_start
    ), best as (
      select distinct on (loc_id, week_start) loc_id, week_start, sub_id, num_species
      from lists where num_species is not null
      order by loc_id, week_start, num_species desc, obs_day desc, obs_time desc nulls last
    )
    select per.loc_id, per.region, per.week_start, per.checklists, coalesce(seen.species, 0), best.num_species, best.sub_id, now()
    from per
    left join seen on seen.loc_id = per.loc_id and seen.week_start = per.week_start
    left join best on best.loc_id = per.loc_id and best.week_start = per.week_start
    on conflict (loc_id, week_start) do update set region = excluded.region, checklists = excluded.checklists,
      species = excluded.species, best_list = excluded.best_list, best_sub_id = excluded.best_sub_id, updated_at = excluded.updated_at
  `, { days, asOf })
  return result.rowCount
}

module.exports = { rollupHotspotWeeks, ROLLUP_DAYS }
