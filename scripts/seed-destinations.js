// Validate with `node scripts/seed-destinations.js`; persist with --apply.
// Existing slugs and existing homepage configuration are never overwritten.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const guides = require('./data/destination-guides');
const { validateDestination, DEFAULT_CONFIG } = require('../src/services/destinations');
const { pool } = require('../src/config/db');

async function run() {
  const photos = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/destination-photos.json'), 'utf8'));
  const frontend = path.resolve(__dirname, '../../holidays-seychelles/public');
  const records = guides.map((guide, index) => {
    const images = photos[guide.slug].map((photo, i) => {
      if (!fs.existsSync(path.join(frontend, photo.url))) throw new Error(`Missing local photo: ${photo.url}`);
      return { ...photo, alt: `${guide.name} — ${i === 0 ? 'destination view' : `photo ${i + 1}`}`, licenseUrl: photo.licenseUrl?.replace(/^\/\//, 'https://') || '' };
    });
    return validateDestination({
      ...guide, heroImage: images[0], gallery: images.slice(1, 5), bannerImage: images[5],
      threeDays: guide.days.map((day, i) => `Day ${i + 1}: ${day}`).join('\n\n'),
      fourDays: `Follow the three-day suggestion above, then add a fourth day: ${guide.extra}`,
      whereToStay: guide.stays.map(([area, description]) => ({ area, description })),
      thingsToDo: guide.activities,
      faqs: [
        { question: `How do I get to ${guide.name}?`, answer: guide.access },
        { question: 'What should I know before visiting?', answer: guide.note },
        { question: 'How can I plan a short visit?', answer: guide.weekend },
      ],
      sources: guide.sources.map(([title, url]) => ({ title, url })),
      published: true, sortOrder: index + 1,
    });
  });
  if (new Set(records.map(item => item.slug)).size !== records.length) throw new Error('Duplicate seed slug.');
  fs.writeFileSync(path.join(__dirname, 'data/destinations.seed.json'), JSON.stringify(records, null, 2));
  console.log(`Validated ${records.length} complete destinations and ${records.length * 6} local photos.`);
  if (!process.argv.includes('--apply')) { await pool.end(); return; }
  const client = await pool.connect();
  try {
    const migration = '030_website_destinations.sql';
    await client.query(fs.readFileSync(path.join(__dirname, '../src/migrations', migration), 'utf8'));
    await client.query('INSERT IGNORE INTO migrations_log (filename) VALUES ($1)', [migration]);
    await client.query('BEGIN');
    let inserted = 0;
    for (const item of records) {
      const existing = await client.query('SELECT id FROM website_destinations WHERE slug=$1', [item.slug]);
      if (existing.rows.length) continue;
      await client.query('INSERT INTO website_destinations (id,slug,name,published,sort_order,content) VALUES ($1,$2,$3,$4,$5,$6)',
        [randomUUID(), item.slug, item.name, 1, item.sortOrder, JSON.stringify(item)]);
      inserted += 1;
    }
    await client.query('INSERT IGNORE INTO admin_settings (setting_key,setting_value) VALUES ($1,$2)',
      ['island_configuration', JSON.stringify({ ...DEFAULT_CONFIG, backgroundImage: '/images/islands-background.png' })]);
    await client.query('COMMIT');
    console.log(`Saved ${inserted} destinations; preserved ${records.length - inserted} existing records. Homepage configuration is ready.`);
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); await pool.end(); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; pool.end().catch(() => {}); });
