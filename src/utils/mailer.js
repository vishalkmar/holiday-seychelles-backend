const { getTransporter } = require('../config/mailer');

async function sendOTPEmail(email, otp) {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || 'Holiday Seychelles <no-reply@holidayseychelles.com>';

  const mailOptions = {
    from,
    to: email,
    subject: 'Your Holiday Seychelles Login OTP',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px;">
        <h2 style="color: #1a5490;">Holiday Seychelles</h2>
        <p>Hello,</p>
        <p>Your One-Time Password (OTP) for login is:</p>
        <div style="background: #f0f0f0; padding: 20px; text-align: center; margin: 20px 0; border-radius: 5px;">
          <h1 style="color: #1a5490; letter-spacing: 2px;">${otp}</h1>
        </div>
        <p>This OTP is valid for ${process.env.OTP_TTL_MINUTES || 10} minutes.</p>
        <p>If you did not request this, please ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #ddd; margin: 20px 0;" />
        <p style="color: #666; font-size: 12px;">
          © ${new Date().getFullYear()} Holiday Seychelles. All rights reserved.
        </p>
      </div>
    `,
    text: `Your OTP is: ${otp}. Valid for ${process.env.OTP_TTL_MINUTES || 10} minutes.`,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    if (transporter.__isJson) {
      // Dev mode: print to console
      console.log('📧 OTP Email (dev mode):', info.message);
    }
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('Failed to send OTP email:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendOTPEmail };
