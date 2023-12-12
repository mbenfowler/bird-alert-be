const nodemailer = require('nodemailer')
const { google } = require('googleapis')
const { configDotenv } = require("dotenv")
const fetch = require('node-fetch')

configDotenv()

const environment = process.env.NODE_ENV || 'development'
const configuration = require('../knexfile')[environment]
const db = require('knex')(configuration)

const redirectURI = 'https://developers.google.com/oauthplayground'
const oAuthClient2 = new google.auth.OAuth2(process.env.APP_CLIENT_ID, process.env.APP_CLIENT_SECRET, redirectURI)
oAuthClient2.setCredentials({ refresh_token: process.env.APP_REFRESH_TOKEN })

const sendAlertDigestEmail = async (email, alerts) => {
  const accessToken = await oAuthClient2.getAccessToken()
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
        type: 'OAuth2',
        user: process.env.APP_EMAIL,
        clientId: process.env.APP_CLIENT_ID,
        clientSecret: process.env.APP_CLIENT_SECRET,
        refreshToken: process.env.APP_REFRESH_TOKEN,
        accessToken: accessToken
    }
  });

  const birdInfo = alerts.map(alert => {
    return `<div style="border: 1px solid black; margin: 3px; padding: 5px;">
      <h3 style="margin: 0;">${alert.comName}</h3><br>
      <p style="margin: 0;">Confirmed sighting at ${alert.locName}! <a href="https://www.google.com/maps?q=${alert.lat},${alert.lng}&label=${alert.comName}}" target="_blank">(map)</p><br>
      <p style="margin: 0;">Check out this bird out on <a href="https://ebird.org/species/${alert.speciesCode}">eBird</a>.</p>
    </div>`
  })

  try {
    const info = await transporter.sendMail({
      from: 'bird-alert Admin <birdalert.info@gmail.com>',
      to: email,
      subject: 'Your daily Bird Alert digest!',
      text: `Review your alerts in-app: https://bird-alert.vercel.app/`,
      html: `<h2>Birds on your watch list have been spotted nearby!</h2>${birdInfo}<h3>Having trouble?</h3><p> Feel free to reach out with questions by replying to this email.</p>`,
    })

    return info

  } catch(error) {
    console.error('Error sending reset password email:', error);
  }
}

module.exports = async (req, res) => {
  try {
    const allUsers = await db('users').select();
    await Promise.all(allUsers.map(async user => {
      const { email, location } = user;
      const savedBirds = await db('saved_birds').where('user_id', user.id).select('speciesCode');

      if (savedBirds.length > 0) {
        const birdCodes = savedBirds.map(bird => bird.speciesCode);
        const alertedBirds = await Promise.all(birdCodes.map(async birdCode => {
          const response = await fetch(`https://api.ebird.org/v2/data/obs/${location}/recent/${birdCode}?back=1`, {
            headers: {
              'X-eBirdApiToken': process.env.EBIRD_API_KEY
            }
          });

          const data = await response.json();

          if (data.length > 0) {
            return data[0];
          }

          return null;
        }));

        const filteredAlertedBirds = alertedBirds.filter(alertedBird => alertedBird !== null);

        await sendAlertDigestEmail(email, filteredAlertedBirds);
      }
    }));

    res.status(200).send('Emails sent successfully');
  } catch (error) {
    console.error('Error sending emails:', error);
    res.status(500).send('Internal Server Error');
  }
}
