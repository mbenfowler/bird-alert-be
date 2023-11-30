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
    service: 'gmail',
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
      from: '"bird-alert Admin" <birdalert.info@gmail.com>',
      to: email,
      subject: "bird-alert reset password link",
      text: `Reset password link: https://bird-alert.vercel.app/reset/${email}`,
      html: `<h2>Please click the link to reset your password</h2><p>https://bird-alert.vercel.app/reset/${email}</p><h3>Having trouble?</h3><p> Feel free to reach out with questions by replying to this email.</p>`,
    })
  } catch(error) {
    console.error('Error sending reset password email:', error);
  }
}

module.exports = async (req, res) => {
  try {
    const email = req.query.email;

    // Add validation logic for the email address if needed

    sendResetPasswordEmail(email);

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Reset password email sent successfully.' }),
    };
  } catch (error) {
    console.error('Error sending reset password email:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error.' }),
    };
  }
};
