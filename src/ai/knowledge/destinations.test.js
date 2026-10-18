const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { islandFor, sectionsFromWebsite, compose, SECTIONS } = require('./destinations');
const { chunkContent } = require('../ingest/chunk');

// destinations.js loads ports, which creates (but never uses) the MySQL pool.
after(async () => {
  const { pool } = require('../../config/db');
  await pool.end?.().catch?.(() => {});
});

test('islandFor: main islands, own islands, and places mapped to their island', () => {
  assert.equal(islandFor('mahe', 'Mahé · Seychelles'), 'mahe');
  assert.equal(islandFor('curieuse', 'Near Praslin · Seychelles'), 'curieuse');
  assert.equal(islandFor('anse-lazio', 'Northwest Praslin · Seychelles'), 'praslin');
  assert.equal(islandFor('anse-severe', 'North La Digue · Seychelles'), 'la-digue');
  assert.equal(islandFor('beau-vallon', 'Northwest Mahé · Seychelles'), 'mahe');
  assert.equal(islandFor('moyenne', 'Sainte Anne Marine Park · Seychelles'), 'moyenne');
  assert.equal(islandFor('sainte-anne-marine-park', 'Off Mahé · Seychelles'), 'mahe');
  assert.equal(islandFor('somewhere', 'Northern Seychelles'), 'other');
});

const WEB = {
  tagline: 'Granite peaks and quiet bays',
  shortDescription: 'The main island.',
  longDescription: 'Home to Victoria and the airport.',
  bestTime: 'April–May and October–November are calm.',
  thingsToDo: ['Hike Morne Blanc', 'Swim at Beau Vallon'],
  whereToStay: [{ area: 'Beau Vallon', description: 'Lively beach with restaurants.' }],
  weekend: 'Victoria morning, beach afternoon.',
  threeDays: 'Add a south-coast drive.',
  food: 'Creole curries and grilled fish.',
  couples: 'Sunset dinner by the sea.',
  comparison: 'Busier than La Digue.',
  faqs: [{ question: 'How do I get there?', answer: 'Fly into Mahé.' }],
};

test('sectionsFromWebsite: every website field lands in a section', () => {
  const s = sectionsFromWebsite(WEB);
  assert.ok(s.overview.startsWith('Granite peaks'));
  assert.equal(s.thingsToDo, '- Hike Morne Blanc\n- Swim at Beau Vallon');
  assert.equal(s.whereToStay, '- **Beau Vallon** — Lively beach with restaurants.');
  assert.ok(s.itineraries.includes('### A weekend') && s.itineraries.includes('### Three days') && !s.itineraries.includes('Four days'));
  assert.equal(s.faqs, '**Q: How do I get there?**\nA: Fly into Mahé.');
  assert.equal(s.transport, '');
});

test('compose: name header, only filled sections, in fixed order; places name their island', () => {
  const md = compose({ name: 'Mahé Island', island: 'mahe', sections_json: sectionsFromWebsite(WEB) });
  assert.ok(md.startsWith('# Mahé Island\n\n## Overview'));
  assert.ok(!md.includes('## Travel tips'), 'empty sections skipped');
  const order = SECTIONS.map((s) => md.indexOf(`## ${s.label}`)).filter((i) => i >= 0);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.ok(compose({ name: 'Anse Lazio', island: 'praslin', sections_json: { overview: 'Famous beach.' } }).startsWith('# Anse Lazio (Praslin)'));
  assert.equal(compose({ name: 'Empty', island: 'mahe', sections_json: {} }), '');
});

test('composed document chunks by section with the heading path', () => {
  const md = compose({ name: 'Mahé Island', island: 'mahe', sections_json: sectionsFromWebsite(WEB) });
  const chunks = chunkContent({ format: 'markdown', content: md }, { targetTokens: 500, mergeSmall: false });
  // 9 filled sections; "Suggested itineraries" has two ### sub-sections, so 10.
  assert.equal(chunks.length, 10, 'one chunk per filled section / sub-section');
  assert.ok(chunks.some((c) => c.heading === 'Mahé Island › Suggested itineraries › A weekend'));
  assert.ok(chunks.some((c) => c.heading === 'Mahé Island › Best time to visit'));
  assert.ok(chunks.every((c) => (c.heading || '').startsWith('Mahé Island')));
  assert.ok(chunks.some((c) => c.text.includes('April–May')));
});
