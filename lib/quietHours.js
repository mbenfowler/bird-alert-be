/** Hour of the day (0-23) right now in a time zone, or null if the zone is unknown. */
const localHour = (timezone, now = new Date()) => {
  try {
    const hour = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(now)
    return Number(hour) % 24
  } catch {
    return null
  }
}

const isValidTimezone = (timezone) => typeof timezone === 'string' && localHour(timezone) !== null

/**
 * True while the user's quiet window is active. Needs both bounds and a known time zone; the
 * window may wrap midnight (22 -> 6). Start == end means "all day quiet" is impossible: treated as off.
 */
const inQuietHours = (user, now = new Date()) => {
  const start = user.push_quiet_start
  const end = user.push_quiet_end
  if (start == null || end == null || start === end || !user.timezone) return false
  const hour = localHour(user.timezone, now)
  if (hour == null) return false
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

module.exports = { localHour, isValidTimezone, inQuietHours }
