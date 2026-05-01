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

/**
 * Send a booking voucher email with the PDF attached.
 * `voucherAbsolutePath` is the on-disk path to the generated PDF.
 */
async function sendVoucherEmail(booking, voucherAbsolutePath) {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || 'Holiday Seychelles <no-reply@holidayseychelles.com>';

  const guestName = `${booking.lead_first_name || ''} ${booking.lead_last_name || ''}`.trim() || 'Guest';
  const total = `${booking.currency || 'INR'} ${Number(booking.payment_amount || 0).toFixed(2)}`;
  const travelDate = booking.travel_date
    ? new Date(booking.travel_date).toLocaleDateString()
    : booking.check_in_date
      ? `${new Date(booking.check_in_date).toLocaleDateString()}${booking.check_out_date ? ' → ' + new Date(booking.check_out_date).toLocaleDateString() : ''}`
      : '—';

  const mailOptions = {
    from,
    to: booking.lead_email,
    subject: `Booking Confirmed · ${booking.booking_reference} — Holiday Seychelles`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 0; background: #f8fafc;">
        <div style="background: linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%); color: #fff; padding: 28px 32px;">
          <h1 style="margin: 0; font-size: 22px; font-weight: 700;">Holiday Seychelles</h1>
          <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.9;">Booking Confirmation</p>
        </div>

        <div style="padding: 28px 32px; background: #ffffff;">
          <p style="margin: 0 0 16px; font-size: 15px; color: #0f172a;">Hi <strong>${guestName}</strong>,</p>
          <p style="margin: 0 0 18px; font-size: 14px; color: #334155; line-height: 1.5;">
            Thank you for booking with us. Your booking is confirmed and your voucher is attached to this email.
          </p>

          <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 18px 20px; margin: 20px 0;">
            <p style="margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #1d4ed8; font-weight: 600;">Booking Reference</p>
            <p style="margin: 4px 0 0; font-size: 20px; font-weight: 700; color: #0f172a; letter-spacing: 0.5px;">${booking.booking_reference}</p>
          </div>

          <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #334155;">
            <tr>
              <td style="padding: 8px 0; color: #64748b; width: 40%;">Product</td>
              <td style="padding: 8px 0; font-weight: 600; color: #0f172a;">${booking.product_title || '—'}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b;">Type</td>
              <td style="padding: 8px 0; font-weight: 600; color: #0f172a; text-transform: capitalize;">${booking.booking_type || '—'}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b;">Travel Date</td>
              <td style="padding: 8px 0; font-weight: 600; color: #0f172a;">${travelDate}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #64748b;">Travellers</td>
              <td style="padding: 8px 0; font-weight: 600; color: #0f172a;">${booking.total_travellers || 1}</td>
            </tr>
            <tr style="border-top: 2px solid #e2e8f0;">
              <td style="padding: 12px 0 8px; color: #64748b;">Amount Paid</td>
              <td style="padding: 12px 0 8px; font-weight: 700; color: #1d4ed8; font-size: 16px;">${total}</td>
            </tr>
          </table>

          <p style="margin: 24px 0 6px; font-size: 13px; color: #64748b;">
            Your voucher PDF is attached. Please carry a printed or digital copy at check-in.
          </p>
          <p style="margin: 0; font-size: 13px; color: #64748b;">
            Need help? Email <a href="mailto:info@holidayseychelles.com" style="color: #1d4ed8; text-decoration: none;">info@holidayseychelles.com</a>.
          </p>
        </div>

        <div style="padding: 16px 32px; background: #f1f5f9; text-align: center; font-size: 11px; color: #64748b;">
          © ${new Date().getFullYear()} Holiday Seychelles. All rights reserved.
        </div>
      </div>
    `,
    text:
      `Hi ${guestName},\n\n` +
      `Your booking ${booking.booking_reference} is confirmed.\n` +
      `Product: ${booking.product_title}\n` +
      `Type: ${booking.booking_type}\n` +
      `Travel: ${travelDate}\n` +
      `Total Paid: ${total}\n\n` +
      `Voucher PDF is attached.\n\n` +
      `Holiday Seychelles`,
    attachments: voucherAbsolutePath
      ? [{ filename: `voucher-${booking.booking_reference}.pdf`, path: voucherAbsolutePath, contentType: 'application/pdf' }]
      : undefined,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    if (transporter.__isJson) {
      console.log('📧 Voucher Email (dev mode):', { to: booking.lead_email, ref: booking.booking_reference });
    }
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('Failed to send voucher email:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send a refund-confirmation email to the lead guest.
 */
async function sendRefundEmail(booking, refund) {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || 'Holiday Seychelles <no-reply@holidayseychelles.com>';

  const guestName = `${booking.lead_first_name || ''} ${booking.lead_last_name || ''}`.trim() || 'Guest';
  const refundAmount = `${refund.currency || booking.currency || 'INR'} ${Number(refund.amount || 0).toFixed(2)}`;
  const reasonLine = refund.reason ? `<p style="margin: 0 0 12px; font-size: 14px; color: #475569;">Reason: ${refund.reason}</p>` : '';

  const mailOptions = {
    from,
    to: booking.lead_email,
    subject: `Refund Processed · ${booking.booking_reference} — Holiday Seychelles`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #f8fafc;">
        <div style="background: linear-gradient(135deg, #7c3aed 0%, #a855f7 100%); color: #fff; padding: 28px 32px;">
          <h1 style="margin: 0; font-size: 22px; font-weight: 700;">Holiday Seychelles</h1>
          <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.9;">Refund Confirmation</p>
        </div>
        <div style="padding: 28px 32px; background: #ffffff;">
          <p style="margin: 0 0 16px; font-size: 15px; color: #0f172a;">Hi <strong>${guestName}</strong>,</p>
          <p style="margin: 0 0 12px; font-size: 14px; color: #334155; line-height: 1.5;">
            Your refund for booking <strong>${booking.booking_reference}</strong> has been processed.
          </p>
          ${reasonLine}
          <div style="background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 12px; padding: 18px 20px; margin: 20px 0;">
            <p style="margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #7c3aed; font-weight: 600;">Refund Amount</p>
            <p style="margin: 4px 0 0; font-size: 24px; font-weight: 700; color: #0f172a;">${refundAmount}</p>
            ${refund.gatewayReference ? `<p style="margin: 8px 0 0; font-size: 12px; color: #64748b;">Reference: ${refund.gatewayReference}</p>` : ''}
          </div>
          <p style="margin: 0 0 6px; font-size: 13px; color: #64748b;">
            Funds typically appear in your original payment method within 5–10 business days, depending on your bank.
          </p>
          <p style="margin: 0; font-size: 13px; color: #64748b;">
            Need help? Email <a href="mailto:info@holidayseychelles.com" style="color: #7c3aed; text-decoration: none;">info@holidayseychelles.com</a>.
          </p>
        </div>
        <div style="padding: 16px 32px; background: #f1f5f9; text-align: center; font-size: 11px; color: #64748b;">
          © ${new Date().getFullYear()} Holiday Seychelles. All rights reserved.
        </div>
      </div>
    `,
    text:
      `Hi ${guestName},\n\n` +
      `Your refund of ${refundAmount} for booking ${booking.booking_reference} has been processed.\n` +
      (refund.gatewayReference ? `Refund reference: ${refund.gatewayReference}\n` : '') +
      (refund.reason ? `Reason: ${refund.reason}\n` : '') +
      `\nFunds will appear in 5–10 business days.\n\nHoliday Seychelles`,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    if (transporter.__isJson) {
      console.log('📧 Refund Email (dev mode):', { to: booking.lead_email, ref: booking.booking_reference });
    }
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('Failed to send refund email:', err.message);
    return { success: false, error: err.message };
  }
}

async function sendQueryReplyEmail(query, replyMessage) {
  const transporter = getTransporter();
  const from = process.env.SMTP_FROM || 'Holiday Seychelles <no-reply@holidayseychelles.com>';

  const guestName = query.name || 'Traveler';
  const subjectLine = query.subject || 'Your Holiday Seychelles query';
  const toEmail = String(query.email || '').trim();
  const ccRecipients = String(process.env.SMTP_To || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value && value.includes('@'));

  if (!toEmail || !toEmail.includes('@')) {
    return { success: false, error: 'Recipient email is missing or invalid' };
  }
  const mailOptions = {
    from,
    to: toEmail,
    cc: ccRecipients.length ? ccRecipients.join(', ') : undefined,
    subject: `Reply to your query · ${subjectLine} — Holiday Seychelles`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; background: #f8fafc;">
        <div style="background: linear-gradient(135deg, #0f172a 0%, #0f4c81 100%); color: #fff; padding: 28px 32px;">
          <h1 style="margin: 0; font-size: 22px; font-weight: 700;">Holiday Seychelles</h1>
          <p style="margin: 6px 0 0; font-size: 13px; opacity: 0.9;">Customer Support Reply</p>
        </div>
        <div style="padding: 28px 32px; background: #ffffff;">
          <p style="margin: 0 0 16px; font-size: 15px; color: #0f172a;">Hi <strong>${guestName}</strong>,</p>
          <p style="margin: 0 0 18px; font-size: 14px; color: #334155; line-height: 1.6;">
            We have replied to your query regarding <strong>${subjectLine}</strong>.
          </p>
          <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 14px; padding: 18px 20px; margin: 20px 0;">
            <p style="margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #2563eb; font-weight: 700;">Our Reply</p>
            <div style="font-size: 14px; color: #0f172a; line-height: 1.7; white-space: pre-wrap;">${replyMessage}</div>
          </div>
          <p style="margin: 0; font-size: 13px; color: #64748b;">
            You can also log in to your Holiday Seychelles account to continue this conversation from your Queries panel.
          </p>
        </div>
        <div style="padding: 16px 32px; background: #f1f5f9; text-align: center; font-size: 11px; color: #64748b;">
          © ${new Date().getFullYear()} Holiday Seychelles. All rights reserved.
        </div>
      </div>
    `,
    text:
      `Hi ${guestName},\n\n` +
      `We have replied to your query regarding "${subjectLine}".\n\n` +
      `${replyMessage}\n\n` +
      `You can continue this conversation from your Holiday Seychelles account.\n\n` +
      `Holiday Seychelles`,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    if (transporter.__isJson) {
      console.log('📧 Query Reply Email (dev mode):', { to: query.email, subject: subjectLine });
    }
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('Failed to send query reply email:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendOTPEmail, sendVoucherEmail, sendRefundEmail, sendQueryReplyEmail };
