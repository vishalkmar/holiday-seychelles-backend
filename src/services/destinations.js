const { randomUUID } = require('crypto');
const slugify = require('slugify');
const { pool } = require('../config/db');

const CONFIG_KEY = 'island_configuration';
const DEFAULT_CONFIG = {
  enabled: true, badge: 'Discover', title: 'Islands and Famous Views in Seychelles',
  subtitle: 'Explore the most beautiful islands and iconic views that make Seychelles a paradise on earth.',
  backgroundImage: '', speed: 18,
};
function fail(message, status = 422) { const error = new Error(message); error.status = status; throw error; }
function text(value, max = 12000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function url(value, required = false) {
  const result = text(value, 2000);
  if (!result && !required) return '';
  if (/^\/(?:uploads|images)\/[a-zA-Z0-9/_% .()-]+$/.test(result)) return result;
  try { const parsed = new URL(result); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) return result; } catch { /* validation below */ }
  fail('Images and source links must use an HTTP(S) URL or a local /images/ or /uploads/ path.');
}
function image(input, required = false) {
  const value = typeof input === 'object' && input ? input : {};
  return { url: url(value.url, required), alt: text(value.alt, 250), credit: text(value.credit, 500), sourceUrl: url(value.sourceUrl), license: text(value.license, 120), licenseUrl: url(value.licenseUrl) };
}
function pairs(input, first, second, max = 30) {
  return (Array.isArray(input) ? input : []).slice(0, max).map(row => ({ [first]: text(row?.[first], 500), [second]: text(row?.[second], 3000) })).filter(row => row[first] && row[second]);
}
function validateDestination(input = {}) {
  const name = text(input.name, 160);
  const slug = slugify(text(input.slug, 160) || name, { lower: true, strict: true });
  if (!name || !slug) fail('Place name is required.');
  const heroImage = image(input.heroImage, true);
  const gallery = (Array.isArray(input.gallery) ? input.gallery : []).slice(0, 12).map(item => image(item, true));
  if (gallery.length < 4) fail('Add at least four gallery images in addition to the hero image.');
  if (new Set([heroImage.url, ...gallery.map(item => item.url)]).size !== gallery.length + 1) fail('Use different photos for the hero and each gallery image.');
  const out = {
    name, slug, region: text(input.region, 160) || 'Seychelles', tagline: text(input.tagline, 150),
    heroImage, gallery, bannerImage: image(input.bannerImage),
    shortDescription: text(input.shortDescription, 1200), longDescription: text(input.longDescription),
    threeDays: text(input.threeDays), fourDays: text(input.fourDays), weekend: text(input.weekend),
    whereToStay: pairs(input.whereToStay, 'area', 'description'), comparison: text(input.comparison),
    couples: text(input.couples), food: text(input.food), bestTime: text(input.bestTime),
    thingsToDo: (Array.isArray(input.thingsToDo) ? input.thingsToDo : []).map(item => text(item, 1000)).filter(Boolean).slice(0, 30),
    faqs: pairs(input.faqs, 'question', 'answer'),
    sources: (Array.isArray(input.sources) ? input.sources : []).slice(0, 20).map(item => ({ title: text(item?.title, 160), url: url(item?.url, true) })),
    published: input.published === true, sortOrder: Math.max(0, Math.min(10000, Math.trunc(Number(input.sortOrder) || 0))),
  };
  if (!out.shortDescription || !out.longDescription) fail('Short and long descriptions are required.');
  if (out.published) {
    for (const field of ['tagline', 'threeDays', 'fourDays', 'weekend', 'comparison', 'couples', 'food', 'bestTime']) {
      if (!out[field]) fail(`Complete ${field} before publishing.`);
    }
    if (!out.whereToStay.length || !out.thingsToDo.length || !out.faqs.length) fail('Add places to stay, things to do and FAQs before publishing.');
  }
  return out;
}
function parse(row) {
  const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
  return { ...content, id: row.id, slug: row.slug, name: row.name, published: Boolean(row.published), sortOrder: row.sort_order, version: row.version };
}
async function list(admin = false) {
  const { rows } = await pool.query(`SELECT * FROM website_destinations ${admin ? '' : 'WHERE published = 1'} ORDER BY sort_order, name`);
  return rows.map(parse);
}
async function get(slug) {
  const { rows } = await pool.query('SELECT * FROM website_destinations WHERE slug = $1 AND published = 1', [slug]);
  if (!rows.length) fail('Destination not found.', 404);
  return parse(rows[0]);
}
async function save(input, id) {
  const content = validateDestination(input);
  const values = [content.slug, content.name, content.published ? 1 : 0, content.sortOrder, JSON.stringify(content)];
  try {
    if (id) {
      const result = await pool.query('UPDATE website_destinations SET slug=$1, name=$2, published=$3, sort_order=$4, content=$5, version=version+1 WHERE id=$6 AND version=$7', [...values, id, Number(input.version)]);
      if (!result.rowCount) fail('This destination was changed or removed elsewhere. Reload before saving.', 409);
    } else {
      id = randomUUID();
      await pool.query('INSERT INTO website_destinations (slug, name, published, sort_order, content, id) VALUES ($1,$2,$3,$4,$5,$6)', [...values, id]);
    }
  } catch (error) { if (error.code === 'ER_DUP_ENTRY') fail('That page URL is already used by another destination.', 409); throw error; }
  const { rows } = await pool.query('SELECT * FROM website_destinations WHERE id=$1', [id]);
  return parse(rows[0]);
}
async function remove(id) {
  const result = await pool.query('DELETE FROM website_destinations WHERE id=$1', [id]);
  if (!result.rowCount) fail('Destination not found.', 404);
}
function validateConfig(input = {}) {
  return { enabled: input.enabled !== false, badge: text(input.badge, 80) || DEFAULT_CONFIG.badge,
    title: text(input.title, 200) || DEFAULT_CONFIG.title, subtitle: text(input.subtitle, 400),
    backgroundImage: url(input.backgroundImage), speed: Math.max(5, Math.min(40, Number(input.speed) || 18)) };
}
async function getConfig() {
  const { rows } = await pool.query('SELECT setting_value FROM admin_settings WHERE setting_key=$1', [CONFIG_KEY]);
  return rows.length ? validateConfig(JSON.parse(rows[0].setting_value)) : { ...DEFAULT_CONFIG };
}
async function saveConfig(input, adminId) {
  const config = validateConfig(input);
  await pool.query('INSERT INTO admin_settings (setting_key,setting_value,updated_by_admin_id) VALUES ($1,$2,$3) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value), updated_by_admin_id=VALUES(updated_by_admin_id)', [CONFIG_KEY, JSON.stringify(config), adminId || null]);
  return config;
}
module.exports = { validateDestination, validateConfig, list, get, save, remove, getConfig, saveConfig, DEFAULT_CONFIG };
