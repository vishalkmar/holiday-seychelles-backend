/**
 * Retrieval eval (Phase 8): runs every case in eval-cases.json through the
 * retriever and reports hit@k (an expected source among the top-k sources)
 * and MRR. Used from the admin (POST /api/admin/rag/retrieval/eval) and the CLI:
 *
 *   node src/ai/retrieve/eval.js [k]
 */

// The CLI needs .env before the database config is loaded.
if (require.main === module) require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { retrieve } = require('./index');

const CASES = path.join(__dirname, 'eval-cases.json');

const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, "'").toLowerCase().trim();

function loadCases() {
  return JSON.parse(fs.readFileSync(CASES, 'utf8')).cases;
}

const matches = (hit, want) => (!want.type || hit.type === want.type) && fold(hit.title).startsWith(fold(want.title));

async function run({ k = 5 } = {}) {
  const cases = loadCases();
  const results = [];
  let hits = 0;
  let rr = 0;
  for (const c of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await retrieve(c.q, { audience: 'public', k });
    // Rank by source (what the answer cites), not by chunk.
    const ranked = [];
    for (const h of r.hits) if (!ranked.some((x) => x.sourceId === h.sourceId)) ranked.push(h);
    const top = ranked.slice(0, k);
    const pos = top.findIndex((h) => c.expect.some((w) => matches(h, w)));
    if (pos >= 0) { hits += 1; rr += 1 / (pos + 1); }
    results.push({
      q: c.q,
      hit: pos >= 0,
      rank: pos >= 0 ? pos + 1 : null,
      expected: c.expect.map((w) => w.title),
      got: top.map((h) => `${h.title} (${h.semantic})`),
      insufficient: r.insufficient,
      bestScore: r.bestScore,
    });
  }
  return { k, total: cases.length, hits, hitRate: Number((hits / cases.length).toFixed(3)), mrr: Number((rr / cases.length).toFixed(3)), results };
}

module.exports = { run, loadCases };

if (require.main === module) {
  const k = Number(process.argv[2]) || 5;
  run({ k })
    .then((r) => {
      r.results.forEach((x) => console.log(`${x.hit ? '✔' : '✖'} ${x.rank ? `#${x.rank}` : '  '} ${x.q}${x.hit ? '' : `\n     expected ${x.expected.join(' / ')}\n     got      ${x.got.join(' | ')}`}`));
      console.log(`\nhit@${r.k}: ${r.hits}/${r.total} = ${(r.hitRate * 100).toFixed(1)}%   MRR ${r.mrr}`);
    })
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => require('../../config/db').pool.end?.());
}
