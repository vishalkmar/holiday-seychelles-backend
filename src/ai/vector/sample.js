/**
 * A small, clearly-labelled sample source for testing the vector index before
 * real knowledge exists (Phase 3). Added and removed from Vector Index in the
 * admin; it is type 'sample' so later phases can ignore or purge it.
 */

const crypto = require('crypto');
const { db } = require('../ports');
const { ensureAiTables } = require('../db');
const llm = require('../llm');
const { estimateTokens } = require('../llm/tokens');
const store = require('./index');

const TITLE = 'Sample knowledge (index test, safe to delete)';

const FACTS = [
  ['Mahé', 'Mahé is the largest island of the Seychelles and home to the capital, Victoria, and Seychelles International Airport.'],
  ['Praslin', 'Praslin is the second largest island; the Vallée de Mai nature reserve there is home to the rare coco de mer palm.'],
  ['La Digue', 'La Digue is a small island where most visitors get around by bicycle; Anse Source d’Argent beach is famous for its granite boulders.'],
  ['Seychelles', 'April–May and October–November are usually the calmest months for snorkelling and diving, between the two trade-wind seasons.'],
  ['Seychelles', 'The local currency is the Seychelles rupee (SCR); euros and US dollars are widely accepted by hotels and tour operators.'],
  ['Praslin', 'Ferries between Mahé and Praslin take about one hour; inter-island flights take about 15 minutes.'],
  ['Mahé', 'Beau Vallon on Mahé is a long sandy beach popular for swimming, water sports and sunset walks.'],
  ['Seychelles', 'Visitors from most countries receive a free visitor permit on arrival; a valid passport and a return ticket are required.'],
  ['Silhouette', 'Silhouette Island is a 20–35 minute boat ride from Mahé and is largely a protected national park.'],
  ['Seychelles', 'Aldabra Atoll, a UNESCO World Heritage Site, hosts the world’s largest population of giant tortoises.'],
];

async function findSample() {
  const { rows } = await db.query("SELECT id FROM rag_sources WHERE type = 'sample' LIMIT 1");
  return rows[0] ? Number(rows[0].id) : null;
}

async function addSample(adminId) {
  await ensureAiTables();
  let sourceId = await findSample();
  if (!sourceId) {
    await db.query(
      `INSERT INTO rag_sources (type, title, status, language, visibility, version, created_by)
       VALUES ('sample', $1, 'published', 'en', 'public', 1, $2)`,
      [TITLE, adminId || null]
    );
    sourceId = await findSample();
  }
  const texts = FACTS.map(([, t]) => t);
  const { vectors, model } = await llm.embed({ inputs: texts, inputType: 'passage', purpose: 'embed' });
  const chunks = FACTS.map(([destination, text]) => ({
    text,
    tokens: estimateTokens(text),
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    metadata: { sourceType: 'sample', visibility: 'public', destination: destination.toLowerCase(), language: 'en', title: TITLE },
  }));
  const r = await store.writeSource({ sourceId, version: 1, chunks, vectors, embedModel: model });
  return { sourceId, ...r };
}

async function removeSample() {
  await ensureAiTables();
  const sourceId = await findSample();
  if (!sourceId) return { removed: 0 };
  const r = await store.deleteSource(sourceId);
  await db.query('DELETE FROM rag_sources WHERE id = $1', [sourceId]);
  return r;
}

module.exports = { addSample, removeSample, findSample };
