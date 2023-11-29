const nodemailer = require('nodemailer');
const { configDotenv } = require("dotenv")

configDotenv()

const sendResetPasswordEmail = async (email) => {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'birdalert.info@gmail.com',
      pass: process.env.APP_PW,
    },
  });

  try {
    const info = await transporter.sendMail({
      from: '"bird-alert Admin" <birdalert.info@gmail.com>',
      to: email,
      subject: "bird-alert reset password link",
      text: "Reset password link: https://bird-alert.vercel.app/reset",
      html: "<h2>Please click the link to reset your password</h2><p>https://bird-alert.vercel.app/reset</p><h3>Having trouble?</h3><p> Feel free to reach out with questions by replying to this email.</p>",
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
