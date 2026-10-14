/**
 * Website configuration (home hero, header logo), stored in `admin_settings`.
 *
 * The public site reads this on every page load, so the rule is the same as for
 * document settings: a bad or missing row must never break the home page. Every
 * value is normalised against the defaults on the way in AND on the way out, so
 * a hand-edited row or an older shape still renders something sensible.
 *
 * Slides are kept per hero type. Switching the type in the admin does not throw
 * away the slides of the other types — an operator trying "video" for a day can
 * switch back to the image carousel and find it exactly as they left it.
 */

const { pool } = require('../config/db');

const KEY = 'website_settings';

const HERO_TYPES = [
  'image_text_carousel',
  'image_carousel',
  'single_image',
  'single_video',
  'video_carousel',
];

/** Height presets are a share of the viewport; width presets a share of the page. */
const SIZE_PRESETS = ['full', '75', 'half', '25'];

const DEFAULTS = {
  branding: {
    logoUrl: null, // null → the built-in /logo.png
    logoWidth: 120,
    logoHeight: 56,
  },
  homeHero: {
    type: 'image_carousel',
    intervalSeconds: 3,
    autoplay: true,
    showArrows: true,
    showDots: true,
    overlay: 0, // 0–80, darkness over the media in percent
    height: { mode: 'preset', preset: 'full', value: 720, unit: 'px' },
    width: { mode: 'preset', preset: 'full', value: 100, unit: '%' },
    slides: {
      image_text_carousel: [],
      image_carousel: [],
      single_image: [],
      single_video: [],
      video_carousel: [],
    },
  },
};

const clone = (v) => JSON.parse(JSON.stringify(v));

function num(value, { min, max, fallback }) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/** Only http(s) URLs or our own /uploads paths may reach the page. */
function cleanUrl(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || s.startsWith('/uploads/') || s.startsWith('/images/')) {
    return s.slice(0, 1000);
  }
  return null;
}

function cleanText(value, max) {
  return String(value || '').slice(0, max);
}

function cleanSize(input, fallback, units) {
  const src = input && typeof input === 'object' ? input : {};
  const unit = units.includes(src.unit) ? src.unit : fallback.unit;
  const limits = unit === 'px' ? { min: 120, max: 3000 } : { min: 10, max: 100 };
  return {
    mode: src.mode === 'custom' ? 'custom' : 'preset',
    preset: SIZE_PRESETS.includes(String(src.preset)) ? String(src.preset) : fallback.preset,
    value: num(src.value, { ...limits, fallback: fallback.value }),
    unit,
  };
}

function cleanSlides(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};

  for (const type of HERO_TYPES) {
    const list = Array.isArray(src[type]) ? src[type] : [];
    const max = type.startsWith('single_') ? 1 : 12;

    out[type] = list
      .map((slide) => {
        const url = cleanUrl(slide?.url);
        if (!url) return null;
        const clean = { url };
        if (type === 'image_text_carousel') {
          clean.title = cleanText(slide.title, 120);
          clean.subtitle = cleanText(slide.subtitle, 240);
        }
        if (type === 'single_video' || type === 'video_carousel') {
          clean.posterUrl = cleanUrl(slide.posterUrl);
        }
        return clean;
      })
      .filter(Boolean)
      .slice(0, max);
  }

  return out;
}

/** Bring any stored or submitted shape back to a valid settings object. */
function normalise(input) {
  const src = input && typeof input === 'object' ? input : {};
  const d = DEFAULTS;
  const b = src.branding || {};
  const h = src.homeHero || {};

  return {
    branding: {
      logoUrl: cleanUrl(b.logoUrl),
      logoWidth: num(b.logoWidth, { min: 40, max: 400, fallback: d.branding.logoWidth }),
      logoHeight: num(b.logoHeight, { min: 24, max: 200, fallback: d.branding.logoHeight }),
    },
    homeHero: {
      type: HERO_TYPES.includes(h.type) ? h.type : d.homeHero.type,
      intervalSeconds: num(h.intervalSeconds, { min: 1, max: 30, fallback: d.homeHero.intervalSeconds }),
      autoplay: bool(h.autoplay, d.homeHero.autoplay),
      showArrows: bool(h.showArrows, d.homeHero.showArrows),
      showDots: bool(h.showDots, d.homeHero.showDots),
      overlay: num(h.overlay, { min: 0, max: 80, fallback: d.homeHero.overlay }),
      height: cleanSize(h.height, d.homeHero.height, ['px', 'vh']),
      width: cleanSize(h.width, d.homeHero.width, ['px', '%']),
      slides: cleanSlides(h.slides),
    },
  };
}

async function getSettings() {
  try {
    const { rows } = await pool.query(
      'SELECT setting_value FROM admin_settings WHERE setting_key = $1',
      [KEY]
    );
    if (!rows.length || !rows[0].setting_value) return clone(DEFAULTS);
    return normalise(JSON.parse(rows[0].setting_value));
  } catch (err) {
    console.error('[website] could not read settings, using defaults:', err.message);
    return clone(DEFAULTS);
  }
}

async function write(settings, adminId) {
  await pool.query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_by_admin_id)
     VALUES ($1, $2, $3)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                             updated_by_admin_id = VALUES(updated_by_admin_id)`,
    [KEY, JSON.stringify(settings), adminId || null]
  );
}

/** Replace the whole configuration with a normalised copy of `next`. */
async function saveSettings(next, adminId) {
  const settings = normalise(next);
  await write(settings, adminId);
  return settings;
}

async function resetSettings(adminId) {
  const settings = clone(DEFAULTS);
  await write(settings, adminId);
  return settings;
}

module.exports = {
  KEY,
  DEFAULTS,
  HERO_TYPES,
  normalise,
  getSettings,
  saveSettings,
  resetSettings,
};
