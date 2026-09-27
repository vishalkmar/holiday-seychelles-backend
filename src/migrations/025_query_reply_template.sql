-- The support reply email, moved into the editable template system.
--
-- Replies used to build their own HTML in utils/mailer.js and were never
-- written to `email_notifications`, so a reply the customer swore never arrived
-- left no trace anywhere. Routing it through a template puts it in the same log
-- as everything else and lets the wording be edited without a deploy.
--
-- Transactional, not marketing: a customer who asked us a question is owed the
-- answer whether or not they unsubscribed from offers.
INSERT IGNORE INTO email_templates
    (template_key, name, description, category, subject, subheading, heading, body_html, cta_label, cta_url, accent, variables, is_automated, is_marketing, enabled)
VALUES
(
    'query_reply',
    'Support reply',
    'Sent when an operator replies to a customer query from the support console.',
    'transactional',
    'Re: {{subject}}',
    'Support',
    'We have replied to your question',
    '<p style="margin:0 0 16px; font-size:15px; color:#061B3A;">Hi <strong>{{guest_name}}</strong>,</p>\n<div style="font-size:14px; color:#334155; line-height:1.6;">{{reply_html}}</div>\n<div style="margin:22px 0 0; padding:16px 20px; background:#f8fafc; border-left:3px solid #cbd5e1;">\n  <p style="margin:0 0 6px; font-size:11px; text-transform:uppercase; letter-spacing:1px; color:#94a3b8; font-weight:700;">Your original message</p>\n  <div style="font-size:13px; color:#64748b; line-height:1.6;">{{original_html}}</div>\n</div>\n<p style="margin:18px 0 0; font-size:13px; color:#64748b;">Reply to this email or from your dashboard and it reaches the same conversation.</p>',
    'Open the conversation',
    '{{conversation_url}}',
    '#2563EB',
    '["guest_name","subject","reply_html","original_html","conversation_url","reference"]',
    0, 0, 1
);
