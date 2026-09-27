-- Editable copy for every email the system sends.
--
-- The visual shell (header, card, footer, button) stays in code so a bad edit
-- cannot break the layout. What lives here is the wording: subject, heading and
-- the body fragment, with `{{variable}}` placeholders the sender fills in.
--
-- Variables whose name ends in _block, _table or _html are inserted as raw HTML
-- because the system composes them (a reference card, a details table).
-- Everything else is HTML-escaped, so a guest whose name contains "<" cannot
-- inject markup into an email.
--
-- `enabled` is what makes an automated email toggleable from the admin panel:
-- the morning sweep skips a kind whose template row is disabled. A template
-- that does not exist is NOT an outage - the sender falls back to the version
-- coded in utils/lifecycleEmails.js.
CREATE TABLE IF NOT EXISTS email_templates (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    template_key VARCHAR(60) NOT NULL,
    name VARCHAR(120) NOT NULL,
    description VARCHAR(400),
    category VARCHAR(20) NOT NULL DEFAULT 'lifecycle',
    subject VARCHAR(255) NOT NULL,
    subheading VARCHAR(160),
    heading VARCHAR(200),
    body_html MEDIUMTEXT NOT NULL,
    cta_label VARCHAR(80),
    cta_url VARCHAR(400),
    accent VARCHAR(9) NOT NULL DEFAULT '#2563EB',
    variables JSON,
    is_automated TINYINT(1) NOT NULL DEFAULT 0,
    is_marketing TINYINT(1) NOT NULL DEFAULT 0,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    updated_by BIGINT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_email_template_key (template_key),
    INDEX idx_email_templates_category (category)
);

-- Seeded from the wording already in utils/lifecycleEmails.js, so editing a
-- template changes a real email rather than introducing a second one.
INSERT IGNORE INTO email_templates
    (template_key, name, description, category, subject, subheading, heading, body_html, cta_label, cta_url, accent, variables, is_automated, is_marketing, enabled)
VALUES
(
    'payment_pending',
    'Pending payment reminder',
    'Sent when a checkout was started but never paid. Runs on the morning sweep, once per order.',
    'lifecycle',
    'Your booking is waiting · {{product_title}}',
    'Incomplete payment',
    'You left something behind',
    '<p style="margin:0 0 16px; font-size:15px; color:#061B3A;">Hi <strong>{{guest_name}}</strong>,</p>\n<p style="margin:0 0 6px; font-size:14px; color:#334155; line-height:1.6;">You started booking <strong>{{product_title}}</strong> with us but the payment wasn''t completed, so nothing has been charged and the booking isn''t held yet.</p>\n{{reference_block}}\n{{details_table}}\n<p style="margin:18px 0 0; font-size:13px; color:#64748b;">Prices and availability can change, so it''s worth finishing soon.</p>',
    'Complete payment',
    '{{resume_url}}',
    '#D97706',
    '["guest_name","product_title","order_reference","amount","travel_date","reference_block","details_table","resume_url"]',
    1, 0, 1
),
(
    'trip_reminder_2d',
    'Trip reminder — 2 days before',
    'Sent two days before check-in to every paid, uncancelled booking.',
    'lifecycle',
    'In 2 days: {{product_title}} · {{booking_reference}}',
    'Trip reminder',
    'Your trip is in 2 days',
    '<p style="margin:0 0 16px; font-size:15px; color:#061B3A;">Hi <strong>{{guest_name}}</strong>,</p>\n<p style="margin:0 0 6px; font-size:14px; color:#334155; line-height:1.6;">Just a reminder that your trip is coming up in <strong>2 days</strong>.</p>\n{{reference_block}}\n{{details_table}}\n<p style="margin:18px 0 0; font-size:13px; color:#64748b;">Please carry your voucher — you can download it any time from your dashboard.</p>',
    'View my trip',
    '{{dashboard_url}}',
    '#2563EB',
    '["guest_name","product_title","booking_reference","check_in","check_out","travellers","reference_block","details_table","dashboard_url"]',
    1, 0, 1
),
(
    'trip_today',
    'Trip reminder — day of travel',
    'Sent on the morning the trip starts.',
    'lifecycle',
    'Today: {{product_title}} · {{booking_reference}}',
    'Your trip starts today',
    'Your trip starts today',
    '<p style="margin:0 0 16px; font-size:15px; color:#061B3A;">Hi <strong>{{guest_name}}</strong>,</p>\n<p style="margin:0 0 6px; font-size:14px; color:#334155; line-height:1.6;">Today''s the day — your booking with us starts today. We hope you have a wonderful time.</p>\n{{reference_block}}\n{{details_table}}\n<p style="margin:18px 0 0; font-size:13px; color:#64748b;">Please carry your voucher — you can download it any time from your dashboard.</p>',
    'View my trip',
    '{{dashboard_url}}',
    '#2563EB',
    '["guest_name","product_title","booking_reference","check_in","check_out","travellers","reference_block","details_table","dashboard_url"]',
    1, 0, 1
),
(
    'post_stay',
    'Post-stay thank you',
    'Sent the day after the stay ends, with a nudge for feedback.',
    'lifecycle',
    'Thank you for travelling with us · {{booking_reference}}',
    'Thank you',
    'Thank you for travelling with us',
    '<p style="margin:0 0 16px; font-size:15px; color:#061B3A;">Hi <strong>{{guest_name}}</strong>,</p>\n<p style="margin:0 0 6px; font-size:14px; color:#334155; line-height:1.6;">We hope you had a wonderful time at <strong>{{product_title}}</strong>. Thank you for choosing Holiday Seychelles — it was a pleasure having you with us.</p>\n{{reference_block}}\n{{details_table}}\n<p style="margin:18px 0 0; font-size:14px; color:#334155; line-height:1.6;">If you have a moment, we''d love to hear how it went — and we''d be delighted to help plan your next trip to the islands.</p>',
    'Share your feedback',
    '{{feedback_url}}',
    '#059669',
    '["guest_name","product_title","booking_reference","stayed","reference_block","details_table","feedback_url"]',
    1, 0, 1
),
(
    'admin_message',
    'Message from admin',
    'The blank template used when an operator writes to one customer from the Customers screen.',
    'transactional',
    '{{subject}}',
    'A message from our team',
    '{{subject}}',
    '<p style="margin:0 0 16px; font-size:15px; color:#061B3A;">Hi <strong>{{guest_name}}</strong>,</p>\n<div style="font-size:14px; color:#334155; line-height:1.6;">{{message_html}}</div>',
    NULL,
    NULL,
    '#2563EB',
    '["guest_name","subject","message_html"]',
    0, 0, 1
),
(
    'campaign_offer',
    'Seasonal offer',
    'Marketing campaign template. Honours unsubscribes and carries an unsubscribe link.',
    'marketing',
    '{{subject}}',
    'Holiday Seychelles',
    '{{heading}}',
    '<p style="margin:0 0 16px; font-size:15px; color:#061B3A;">Hi <strong>{{guest_name}}</strong>,</p>\n<div style="font-size:14px; color:#334155; line-height:1.6;">{{message_html}}</div>',
    'See the offer',
    '{{site_url}}',
    '#0891B2',
    '["guest_name","subject","heading","message_html","site_url"]',
    0, 1, 1
),
(
    'campaign_occasion',
    'Occasion greeting',
    'Birthday, anniversary and holiday greetings. Marketing, so unsubscribes apply.',
    'marketing',
    '{{subject}}',
    'Holiday Seychelles',
    '{{heading}}',
    '<p style="margin:0 0 16px; font-size:15px; color:#061B3A;">Hi <strong>{{guest_name}}</strong>,</p>\n<div style="font-size:14px; color:#334155; line-height:1.6;">{{message_html}}</div>',
    'Plan your next trip',
    '{{site_url}}',
    '#7C3AED',
    '["guest_name","subject","heading","message_html","site_url"]',
    0, 1, 1
);
