const { configDotenv } = require("dotenv")

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

module.exports = async (req, res) => {
  const user = req.query;
  try {
    const updateUser = {
      email: user.email,
      updated_at: new Date()
    };

    user.state && (updateUser.state = user.state)
    user.location && (updateUser.location = user.location)
    const confirmedBool = user.confirmed === 'true' ? true : false
    user.confirmed && (updateUser.email_confirmed = confirmedBool)

    const alertDigestBool = user.alert_digest_email_enabled === 'true' ? true : false
    user.alert_digest_email_enabled && (updateUser.alert_digest_email_enabled = alertDigestBool)

    const rareSightingsBool = user.rare_sightings_email_enabled === 'true' ? true : false
    user.rare_sightings_email_enabled && (updateUser.rare_sightings_email_enabled = rareSightingsBool)
    user.password && (updateUser.password = user.password)
    user.phone && (updateUser.phone = user.phone)

    await db('users').where({email: user.emailLookup}).update(updateUser);

    res.status(200).json(user);
  } catch (error) {
    console.error('Error updating user:', error)
    res.status(500).json({ error });
  }
};
