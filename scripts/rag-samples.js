/**
 * Writes one sample file of each supported type to docs/rag-system/samples,
 * for trying the Document Training Center. Run: node scripts/rag-samples.js
 */
const fs = require('fs');
const path = require('path');
const f = require('../src/ai/ingest/fixtures');

const out = path.join(__dirname, '..', '..', 'docs', 'rag-system', 'samples');

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const files = {
    'island-guide.pdf': await f.pdf(),
    'cancellation-policy.docx': await f.docx(),
    'transfer-rates.xlsx': await f.xlsx(),
    'excursions.csv': f.csv(),
    'visitor-permits.txt': f.txt(),
  };
  for (const [name, buf] of Object.entries(files)) {
    fs.writeFileSync(path.join(out, name), buf);
    console.log('wrote', name, buf.length, 'bytes');
  }
})();
