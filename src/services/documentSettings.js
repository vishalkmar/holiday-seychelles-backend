/**
 * Voucher and invoice appearance, stored in `admin_settings`.
 *
 * The layout is code; only the wording, the colour and the logo are settings.
 * That means a bad edit can make a voucher look wrong but never make it fail to
 * generate — and the defaults below are what ships if the row is missing,
 * empty, or holds unparseable JSON.
 */

const fs = require('fs');
const path = require('path');
const { pool } = require('../config/db');

const KEY = 'document_settings';

const DEFAULTS = {
  brandColor: '#2563EB',
  documentTitle: 'Booking Voucher & Payment Receipt',
  termsTitle: 'Terms & Conditions',
  terms: [
    'This voucher must be presented at check-in together with photo identification.',
    'Names on the voucher must match the travel documents of every guest.',
    'Cancellation and amendment charges follow the policy shown above.',
    'Holiday Seychelles is not responsible for services not listed on this voucher.',
  ],
  footerNote:
    'Please carry this voucher with you. For any assistance contact info@holidayseychelles.com. ' +
    'Payments are processed securely by CyberSource; Holiday Seychelles never stores your full card number.',
  logoFilename: null,
  companyName: 'Holiday Seychelles',
  companyAddress: '',
  companyEmail: 'info@holidayseychelles.com',
  companyPhone: '',
  taxNote: '',
  invoicePrefix: 'INV',
};

function uploadsDir() {
  return path.join(__dirname, '../..', process.env.UPLOAD_DIR || 'uploads');
}

/** The built-in logo, used when no custom one has been uploaded. */
function defaultLogoPath() {
  return path.join(__dirname, '..', 'assets', 'logo.png');
}

/**
 * Resolve the logo to an absolute path that actually exists.
 *
 * A settings row can outlive the file it points at, and the voucher generator
 * skips a missing logo silently — which would leave a branded document
 * unbranded with no explanation. Falling back here keeps the shipped logo.
 */
function logoPathFor(settings) {
  if (settings.logoFilename) {
    const candidate = path.join(uploadsDir(), path.basename(settings.logoFilename));
    if (fs.existsSync(candidate)) return candidate;
  }
  return defaultLogoPath();
}

async function getSettings() {
  try {
    const { rows } = await pool.query(
      'SELECT setting_value FROM admin_settings WHERE setting_key = $1',
      [KEY]
    );
    if (!rows.length || !rows[0].setting_value) return { ...DEFAULTS };

    const stored = JSON.parse(rows[0].setting_value);
    const merged = { ...DEFAULTS, ...stored };
    // An explicitly emptied list is a real choice; a malformed one is not.
    merged.terms = Array.isArray(stored.terms) ? stored.terms : DEFAULTS.terms;
    return merged;
  } catch (err) {
    console.error('[documents] could not read settings, using defaults:', err.message);
    return { ...DEFAULTS };
  }
}

/** Settings plus the resolved absolute logo path, ready for the PDF writers. */
async function getRenderSettings() {
  const settings = await getSettings();
  return { ...settings, logoPath: logoPathFor(settings) };
}

const EDITABLE = [
  'brandColor',
  'documentTitle',
  'termsTitle',
  'terms',
  'footerNote',
  'logoFilename',
  'companyName',
  'companyAddress',
  'companyEmail',
  'companyPhone',
  'taxNote',
  'invoicePrefix',
];

async function saveSettings(patch, adminId) {
  const current = await getSettings();
  const next = { ...current };

  for (const key of EDITABLE) {
    if (patch[key] === undefined) continue;
    next[key] = key === 'terms'
      ? (Array.isArray(patch[key]) ? patch[key].map(String).filter(Boolean) : current.terms)
      : patch[key];
  }

  if (next.brandColor && !/^#[0-9a-fA-F]{6}$/.test(next.brandColor)) {
    return { error: 'The brand colour must be a hex value like #2563EB' };
  }

  await pool.query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_by_admin_id)
     VALUES ($1, $2, $3)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                             updated_by_admin_id = VALUES(updated_by_admin_id)`,
    [KEY, JSON.stringify(next), adminId || null]
  );

  return { settings: next };
}

async function resetSettings(adminId) {
  await pool.query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_by_admin_id)
     VALUES ($1, $2, $3)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                             updated_by_admin_id = VALUES(updated_by_admin_id)`,
    [KEY, JSON.stringify(DEFAULTS), adminId || null]
  );
  return { ...DEFAULTS };
}

module.exports = {
  KEY,
  DEFAULTS,
  getSettings,
  getRenderSettings,
  saveSettings,
  resetSettings,
  uploadsDir,
  defaultLogoPath,
  logoPathFor,
};
