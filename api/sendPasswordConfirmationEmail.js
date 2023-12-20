const nodemailer = require('nodemailer')
const { google } = require('googleapis')
const { configDotenv } = require("dotenv")

configDotenv()

const redirectURI = 'https://developers.google.com/oauthplayground'
const oAuthClient2 = new google.auth.OAuth2(process.env.APP_CLIENT_ID, process.env.APP_CLIENT_SECRET, redirectURI)
oAuthClient2.setCredentials({ refresh_token: process.env.APP_REFRESH_TOKEN })

const sendResetPasswordEmail = async (email) => {
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

  try {
    const info = await transporter.sendMail({
      from: 'bird-alert Admin <birdalert.info@gmail.com>',
      to: email,
      subject: 'bird-alert email confirmation link',
      text: `Email confirmation link: https://bird-alert.vercel.app/confirm/${email}`,
      html: `<h2>Please click the link to confirm your email and start receiving Bird Alerts!</h2><p>https://bird-alert.vercel.app/confirm/${email}</p><h3>Having trouble?</h3><p> Feel free to reach out with questions by replying to this email.</p>`,
    })

    return info

  } catch(error) {
    console.error('Error sending email confiration email:', error);
  }
}

module.exports = async (req, res) => {
  try {
    const email = req.query.email;

    // Add validation logic for the email address if needed

    const info = await sendResetPasswordEmail(email)
    if (info.accepted.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Email confirmation email sent successfully.' }),
      };
    }
  } catch (error) {
    console.error('Error sending email confirmation email:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error.' }),
    };
  }
};
