const db = require('./db')
const { HttpError } = require('./http')
const { COUNTY_REGION } = require('./regions')
const { today, addDays } = require('./seasonality')

/**
 * A county's most productive hotspots lately: ranked by the species reported there in the last 7,
 * 30 or 90 days, then by checklists. Only what's on file, no eBird calls. Species come from the
 * checklists we've opened in full (most, not all: the hourly budget samples a busy county), counted
 * as birders count them: subspecies groups and forms roll up to their species, and spuhs, slashes,
 * hybrids and domestics don't count. A code eBird's taxonomy hasn't told us about yet counts as a
 * species. Checklists count every list, opened or not; the best list is the one with the most species.
 */
const PERIODS = [7, 30, 90]
const TOP = 25
/** How far back "on file since" looks: past the longest period, short of the odd ancient checklist eBird lists. */
const ON_FILE_DAYS = 120

const parseDays = (value) => {
  if (value === undefined || value === '') return 7
  const days = Number(value)
  if (!PERIODS.includes(days)) throw new HttpError(400, 'days must be 7, 30 or 90')
  return days
}

const assertCounty = (region) => {
  if (!COUNTY_REGION.test(String(region || ''))) throw new HttpError(400, 'region must be a county')
  return region
}

const bestHotspots = async (region, days = 7, { asOf = today() } = {}) => {
  const since = addDays(asOf, -(days - 1))
  const rows = (await db.raw(`
    with lists as (
      select sub_id, loc_id, loc_name, lat, lng, obs_day, obs_time, num_species, detail_fetched_at
      from checklists where region = :region and is_hotspot and obs_day >= :since
    ), per as (
      select loc_id, count(*)::int as checklists, max(loc_name) as loc_name, avg(lat)::float as lat, avg(lng)::float as lng
      from lists group by loc_id
    ), seen as (
      select l.loc_id, count(distinct case when t.category in ('issf', 'form') then coalesce(t.report_as, cs.species_code) else cs.species_code end)::int as species
      from lists l
      join checklist_species cs on cs.sub_id = l.sub_id
      left join taxonomy_ref t on t.species_code = cs.species_code
      where l.detail_fetched_at is not null and (t.category is null or t.category in ('species', 'issf', 'form'))
      group by l.loc_id
    ), best as (
      select distinct on (loc_id) loc_id, sub_id, num_species, to_char(obs_day, 'YYYY-MM-DD') as day
      from lists where num_species is not null
      order by loc_id, num_species desc, obs_day desc, obs_time desc nulls last
    )
    select per.loc_id, coalesce(per.loc_name, h.name) as name, coalesce(per.lat, h.lat) as lat, coalesce(per.lng, h.lng) as lng,
      coalesce(seen.species, 0) as species, per.checklists, best.sub_id as best_sub, best.num_species as best_species, best.day as best_day
    from per
    left join seen on seen.loc_id = per.loc_id
    left join best on best.loc_id = per.loc_id
    left join hotspot_ref h on h.loc_id = per.loc_id
    order by species desc, per.checklists desc, coalesce(per.loc_name, h.name) asc
    limit ${TOP}
  `, { region, since })).rows
  const onFile = (await db.raw(`
    select count(*) filter (where obs_day >= :since)::int as checklists,
      count(*) filter (where obs_day >= :since and detail_fetched_at is not null)::int as detailed,
      to_char(min(obs_day), 'YYYY-MM-DD') as first_day
    from checklists where region = :region and obs_day >= :floor
  `, { region, since, floor: addDays(asOf, -ON_FILE_DAYS) })).rows[0]
  return {
    region,
    days,
    since,
    onFile: { checklists: onFile.checklists, detailed: onFile.detailed, firstDay: onFile.first_day },
    hotspots: rows.map((r) => ({
      locId: r.loc_id,
      name: r.name,
      lat: r.lat === null ? null : Number(r.lat),
      lng: r.lng === null ? null : Number(r.lng),
      species: r.species,
      checklists: r.checklists,
      bestList: r.best_sub ? { species: r.best_species, subId: r.best_sub, day: r.best_day } : null
    }))
  }
}

module.exports = { bestHotspots, parseDays, assertCounty, PERIODS, TOP }
