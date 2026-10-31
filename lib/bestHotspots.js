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
/** For one bird, every hotspot it was reported at (up to this many), so the page can also sort them by the latest report. */
const TOP_FOR_BIRD = 100
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

/** How much of the county is on file for the window: every list, those opened in full, and the first day. */
const onFileFor = async (region, since, asOf) => {
  const row = (await db.raw(`
    select count(*) filter (where obs_day >= :since)::int as checklists,
      count(*) filter (where obs_day >= :since and detail_fetched_at is not null)::int as detailed,
      to_char(min(obs_day), 'YYYY-MM-DD') as first_day
    from checklists where region = :region and obs_day >= :floor
  `, { region, since, floor: addDays(asOf, -ON_FILE_DAYS) })).rows[0]
  return { checklists: row.checklists, detailed: row.detailed, firstDay: row.first_day }
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
  return {
    region,
    days,
    since,
    onFile: await onFileFor(region, since, asOf),
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

/**
 * Lower bound of the 95% Wilson score interval for `hits` out of `n`. Ranking by it rather than the
 * plain share keeps a bird seen on the one list from a place from outranking one on 8 of 10 there.
 */
const wilsonLow = (hits, n) => {
  if (!n) return 0
  const z = 1.96
  const p = hits / n
  return (p + z * z / (2 * n) - z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)) / (1 + z * z / n)
}

/**
 * The same hotspots for one bird: where it was reported most reliably in the last 7, 30 or 90 days,
 * as the share of the lists opened in full there that have it (a subspecies group or form of it
 * counts), ranked by the Wilson lower bound so a long record beats a lucky single list. Only places
 * it was reported, with when and how many it was last reported there.
 */
const bestHotspotsFor = async (region, days, code, { asOf = today() } = {}) => {
  const since = addDays(asOf, -(days - 1))
  const rows = (await db.raw(`
    with lists as (
      select sub_id, loc_id, loc_name, lat, lng, obs_day, obs_time, detail_fetched_at
      from checklists where region = :region and is_hotspot and obs_day >= :since
    ), hits as (
      select l.sub_id, l.loc_id, l.obs_day, l.obs_time, max(cs.how_many) as how_many
      from lists l
      join checklist_species cs on cs.sub_id = l.sub_id
      left join taxonomy_ref t on t.species_code = cs.species_code
      where l.detail_fetched_at is not null and (cs.species_code = :code or (t.category in ('issf', 'form', 'intergrade') and t.report_as = :code))
      group by l.sub_id, l.loc_id, l.obs_day, l.obs_time
    ), reported as (
      select loc_id, count(*)::int as reports from hits group by loc_id
    ), per as (
      select loc_id, count(*)::int as checklists, count(*) filter (where detail_fetched_at is not null)::int as detailed,
        max(loc_name) as loc_name, avg(lat)::float as lat, avg(lng)::float as lng
      from lists group by loc_id
    ), last as (
      select distinct on (loc_id) loc_id, sub_id, how_many, to_char(obs_day, 'YYYY-MM-DD') as day
      from hits order by loc_id, obs_day desc, obs_time desc nulls last
    )
    select per.loc_id, coalesce(per.loc_name, h.name) as name, coalesce(per.lat, h.lat) as lat, coalesce(per.lng, h.lng) as lng,
      per.checklists, per.detailed, reported.reports, last.sub_id as last_sub, last.how_many as last_how_many, last.day as last_day
    from per
    join reported on reported.loc_id = per.loc_id
    join last on last.loc_id = per.loc_id
    left join hotspot_ref h on h.loc_id = per.loc_id
  `, { region, since, code })).rows
  const named = await db('taxonomy_ref').where({ species_code: code }).first('com_name')
  const hotspots = rows
    .map((r) => ({
      locId: r.loc_id,
      name: r.name,
      lat: r.lat === null ? null : Number(r.lat),
      lng: r.lng === null ? null : Number(r.lng),
      checklists: r.checklists,
      detailed: r.detailed,
      reports: r.reports,
      frequency: r.detailed ? r.reports / r.detailed : 0,
      lastSeen: { day: r.last_day, subId: r.last_sub, howMany: r.last_how_many === null ? null : Number(r.last_how_many) }
    }))
    .sort((a, b) => wilsonLow(b.reports, b.detailed) - wilsonLow(a.reports, a.detailed) || b.reports - a.reports || String(a.name).localeCompare(String(b.name)))
    .slice(0, TOP_FOR_BIRD)
  return {
    region,
    days,
    since,
    onFile: await onFileFor(region, since, asOf),
    species: { code, comName: named ? named.com_name : null },
    hotspots
  }
}

module.exports = { bestHotspots, bestHotspotsFor, wilsonLow, parseDays, assertCounty, PERIODS, TOP, TOP_FOR_BIRD }
