/**
 * PII masking: for summaries (never stored) and analytics/admin views.
 * Emails, phone numbers, card numbers and passport-like ids become tags.
 */

const RULES = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[card]'],
  [/(?:\+|00)\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4}\b|\b\d{3}[\s-]\d{3,4}[\s-]\d{3,4}\b|\b\d{10}\b/g, '[phone]'],
  [/\b[A-Z]{1,2}\d{6,8}\b/g, '[id]'],
];

function mask(text) {
  let s = String(text ?? '');
  for (const [re, tag] of RULES) s = s.replace(re, tag);
  return s;
}

module.exports = { mask };
