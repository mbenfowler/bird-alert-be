/**
 * Every user-facing line the server writes, in English: the source every other language is
 * translated from (lib/i18n.js). {name} marks a value filled in; { one, other } a plural, picked
 * by `count`. Account emails are written as a note from Matt and should stay in his voice.
 */
module.exports = {
  format: {
    dateTime: '{date}, {time}'
  },
  // What a county is called where the reader lives (lib/regions countyWord), for prose.
  places: {
    county: 'county',
    municipality: 'municipality',
    area: 'area'
  },
  // The preview card under a shared ABA Code 4 or 5 sighting (lib/shareCard.js). Bitmap fonts: plain ASCII only.
  card: {
    abaCode: 'ABA CODE {code}',
    confirmed: 'CONFIRMED BY EBIRD REVIEWERS',
    where: '{state} · {county} · {date}',
    whereNoCounty: '{state} · {date}'
  },
  distance: {
    mi: '{n} mi',
    km: '{n} km',
    away: '{distance} away',
    awayIn: '{distance} away in {county}',
    awayParen: '{place} ({distance} away)',
    awayInParen: '{place} ({distance} away in {county})',
    in: 'in {county}',
    inParen: '{place} (in {county})',
    inPlace: 'in {county} ({place})',
    atPlace: 'near {place}'
  },
  evidence: {
    confirmed: 'Confirmed by eBird reviewer',
    unconfirmed: 'Unconfirmed: not yet reviewed',
    photo: 'photo',
    audio: 'audio',
    video: 'video',
    birders: { one: '{count} birder', other: '{count} birders' }
  },
  push: {
    nearby: 'nearby',
    lifer: '🎯 Lifer chance: {bird} reported {where}',
    season: '{emoji} First {bird} of the season!',
    abaCode: '❗ ABA Code {code}: {bird} reported {where}',
    notable: '❗ Notable: {bird} reported {where}',
    watched: '⭐ {bird} spotted nearby!',
    watchedAway: '⭐ {bird} spotted {where}!',
    watchedMany: '⭐ {count} watch list birds spotted nearby',
    seen: '{count} seen',
    firstSince: 'first since {date}',
    firstInYear: 'first in over a year',
    andMore: 'and {count} more',
    summaryTitle: '{count} more sightings nearby',
    summaryBody: '{names}{more}.',
    summaryMore: ' and {count} more',
    reviewTitle: '✅ Now confirmed by eBird: {bird}',
    abaCodeShort: 'ABA Code {code}',
    test: 'Test: {title}',
    testPlainTitle: 'Bird Alert notifications are on',
    testPlainBody: 'You will hear from us when a bird on your watch list is reported nearby.',
    actions: {
      map: 'Open map',
      ebird: 'View on eBird',
      app: 'Open app'
    }
  },
  mail: {
    footer: 'Having trouble? Reply to this email and a human will read it.',
    ebirdCreditText: 'Sightings and checklists from eBird (https://ebird.org), the Cornell Lab of Ornithology.',
    ebirdCreditHtml: 'Sightings and checklists from <a href="https://ebird.org" style="color:#1a56db;">eBird</a>, the Cornell Lab of Ornithology.',
    openMap: 'Open map',
    viewChecklist: 'View checklist on eBird',
    mapAlt: 'Map of where the birds were reported',
    moreCards: '...and {count} more. See them all in the app.',
    placeHeading: '{place} · {county}',
    seen: '{count} seen',
    abaCode: 'ABA Code {code}',
    openApp: 'Open the app: {url}',
    alertSettings: 'Alert settings',
    signature: 'Matt, Bird Alert',
    hi: 'Hi,',
    confirm: {
      subject: 'Confirm your email for Bird Alert',
      body: 'Thanks for signing up for Bird Alert! Please click the email confirmation link below and I’ll start sending you your birds here!:',
      ignore: 'If you didn’t sign up, you can ignore this.'
    },
    reminder: {
      subject: 'Confirm your email to start getting bird alerts',
      body: 'Looks like you signed up for Bird Alert yesterday but haven’t confirmed your email yet. Please click the email confirmation link below and I’ll start sending you your birds here!:',
      ignore: 'Didn’t sign up? Ignore this; it’s the only reminder.'
    },
    reset: {
      subject: 'Reset your Bird Alert password',
      body: 'Here’s the link to choose a new Bird Alert password. It works once and expires in an hour:',
      ignore: 'If you didn’t ask for this, ignore it; your password stays as it is.'
    },
    digest: {
      subject: { one: '{bird} was spotted near you', other: '{count} birds from your watch list were spotted near you' },
      text: 'Birds on your watch list were reported nearby:',
      intro: 'Reported to eBird in your area since yesterday.',
      introFallback: 'Reported to eBird in your area since yesterday. This comes by email because alerts aren’t set up on a phone or computer yet; turn them on in Settings and they’ll arrive the moment a bird is reported.',
      unsubscribe: 'Unsubscribe from this digest'
    },
    rare: {
      subjectAba: 'ABA Code {code} near you: {bird}{more}',
      subjectAbaMore: ' + {count} more',
      subject: { one: 'Uncommon bird near you: {bird}', other: '{count} uncommon birds reported near you' },
      text: 'Notable sightings reported near you:',
      intro: "eBird's notable sightings for your area since yesterday.",
      abaNote: 'In the ABA Area (the US and Canada), ABA Code 3 birds turn up a few times each year, Code 4 not every year, and Code 5 only a few times ever. Codes from the ABA Checklist, used with permission of the American Birding Association.',
      unsubscribe: 'Unsubscribe from these emails'
    },
    migration: {
      yourArea: 'your area',
      subject: 'Migration this week in {place}: {headline}',
      quietWeek: 'a quiet week',
      heading: 'Migration this week in {place}',
      intro: 'Who turned up, who moved on, and who to expect next, from a year of eBird reports for your {countyWord}.',
      arrivals: { one: '{count} arrival', other: '{count} arrivals' },
      movedOnCount: '{count} moved on',
      toWatchFor: '{count} to watch for',
      arrived: 'Arrived this week',
      arrivedText: 'Arrived this week:',
      arrivedEmpty: 'No species returned this week after a month or more away.',
      movedOn: 'Moved on',
      movedOnText: 'Moved on:',
      movedOnEmpty: 'Every regular from the past month was reported again in the last two weeks.',
      expected: 'Expected over the next two weeks',
      expectedText: 'Expected over the next two weeks:',
      expectedEmpty: 'Everything that was here this time last year has already been reported.',
      backSince: 'Back since {date}',
      backSinceDays: { one: 'Back since {date}, reported on {count} day this week', other: 'Back since {date}, reported on {count} days this week' },
      lastReported: { one: 'Last reported {date}, after {count} day in the month before', other: 'Last reported {date}, after {count} days in the month before' },
      lastYear: 'This time last year: reported on {days} of {window} days',
      lastYearFrom: 'This time last year: reported on {days} of {window} days, from {date}',
      backSinceText: '- {bird} (back since {date})',
      lastReportedText: '- {bird} (last reported {date})',
      lastYearText: '- {bird} ({days} of {window} days this time last year)',
      radar: "Tonight's migration radar",
      radarText: "Tonight's migration radar: {url}",
      openBirdAlert: 'Open Bird Alert',
      birdcastCredit: 'Radar counts are from BirdCast (Cornell Lab of Ornithology and Colorado State University).',
      unsubscribe: 'Unsubscribe from this email'
    }
  },
  /**
   * Errors people can see, keyed by the English the code throws (lib/http translates them per
   * request). Developer-facing validation messages are left out on purpose.
   */
  errors: {
    'Give the place a name': 'Give the place a name',
    'Choose where the place is': 'Choose where the place is',
    'Choose one of the offered distances': 'Choose one of the offered distances',
    'That spot is not a place on the map': 'That spot is not a place on the map',
    'You can save up to 10 places': 'You can save up to 10 places',
    'No such place': 'No such place',
    'Target birds must be a list': 'Target birds must be a list',
    'A place can have up to 50 target birds': 'A place can have up to 50 target birds',
    'A trip needs a start and an end date': 'A trip needs a start and an end date',
    'A trip has to end on or after the day it starts': 'A trip has to end on or after the day it starts',
    'A trip can be up to 60 days long': 'A trip can be up to 60 days long',
    'That trip has already ended': 'That trip has already ended',
    'A trip can start up to a year from now': 'A trip can start up to a year from now',
    'No such trip': 'No such trip',
    'An account with that email already exists': 'An account with that email already exists',
    'Incorrect email or password': 'Incorrect email or password',
    'Please enter a valid email address': 'Please enter a valid email address',
    'Please log in': 'Please log in',
    'Not logged in': 'Not logged in',
    'Too many attempts. Please try again later.': 'Too many attempts. Please try again later.',
    'That account no longer exists': 'That account no longer exists',
    'This link is invalid or has expired': 'This link is invalid or has expired',
    'This reset link has already been used or has expired': 'This reset link has already been used or has expired',
    'This confirmation link no longer matches your account email': 'This confirmation link no longer matches your account email',
    'Your email is already confirmed': 'Your email is already confirmed',
    'This link has expired or never existed': 'This link has expired or never existed',
    'That passkey isn’t on any account here. Sign in with your password, then add it again.': 'That passkey isn’t on any account here. Sign in with your password, then add it again.',
    'The passkey couldn’t be checked': 'The passkey couldn’t be checked',
    'eBird is busy right now. Trying again in a moment.': 'eBird is busy right now. Trying again in a moment.',
    'That took too long. Try again.': 'That took too long. Try again.',
    'Could not load hotspots': 'Could not load hotspots',
    'eBird has no such area': 'eBird has no such area',
    'That area is not in that state or province': 'That area is not in that state or province',
    'Say a little more, then send': 'Say a little more, then send',
    'Thanks for all the ideas! Send more tomorrow.': 'Thanks for all the ideas! Send more tomorrow.',
    'That’s a lot of sharing for one day. Try again tomorrow.': 'That’s a lot of sharing for one day. Try again tomorrow.',
    'That doesn’t look like an eBird life list export (no Common Name or Scientific Name column)': 'That doesn’t look like an eBird life list export (no Common Name or Scientific Name column)',
    'That file is too large': 'That file is too large',
    'The file is empty': 'The file is empty',
    'Search is too long': 'Search is too long',
    'Push notifications are not configured on the server': 'Push notifications are not configured on the server',
    'Bird sounds are not configured': 'Bird sounds are not configured',
    'Unknown bird': 'Unknown bird',
    'Unknown species': 'Unknown species',
    'Not found': 'Not found',
    'Internal server error': 'Internal server error'
  }
}
