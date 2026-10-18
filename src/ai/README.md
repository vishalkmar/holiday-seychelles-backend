# src/ai: AI assistant module

The RAG knowledge base, live tools, conversation memory and Bot Connection flows for the website assistant. The design and the phase plan are in [`docs/rag-system/`](../../../docs/rag-system/README.md).

## Rules

- **Talk to the rest of the backend only through `ports/`.** No `require('../../services/…')` elsewhere in this folder. This keeps the module liftable into its own service later.
- **Own tables only:** `rag_*`, `chat_*`, `bot_*`. Migrations live in `src/migrations/03x_*.sql` and are listed in `db.js` (`AI_MIGRATIONS`), which also applies them lazily.
- **Audit** goes to the shared `admin_audit_log` via `ports.audit({ entityType: 'rag_…' })`.
- **TourVisio** calls only via `ports.tourvisio`, which uses the connect-retry transport.
- **No secrets in responses or logs.** API keys come from env, or from `rag_settings` encrypted with `RAG_SECRET_KEY`.
- The live server runs **Node 18**, so check a new dependency's `engines` field before adding it.

## Layout

| Path | What | Phase |
|---|---|---|
| `index.js` | `mountAi(app)`: mounts `/api/admin/rag` and `/api/chat` | 1 |
| `config.js` | Env loader with defaults and warnings (never throws) | 1 |
| `ports/` | Doors into the backend: db, audit, security, mail, tourvisio, auth | 1 |
| `db.js` | `ensureAiTables()`: lazy migrations | 1 |
| `storage.js` | Private document storage (`storage/rag`) | 1 |
| `health.js` | Admin overview checks | 1 |
| `routes/` | `admin.js`, `chat.js` | 1 |
| `llm/` | NVIDIA chat / embed / rerank gateway | 2 |
| `vector/` | Vector store adapter: `mysql`, `pinecone` | 3 |
| `ingest/` | Parse, clean, chunk, embed worker | 4–5 |
| `knowledge/` | Destinations and FAQs | 6–7 |
| `retrieve/` | Hybrid retrieval | 8 |
| `tools/` | Allow-listed live tools | 9 |
| `orchestrator/` | Intent, routing, tool loop, grounding | 10 |
| `prompt/` | 4-layer prompt and versions | 11–12 |
| `memory/` | Conversation memory | 13 |
| `flows/` | Bot Connection engine | 16 |

## Tests

```
node --test src/ai/ai.test.js
```
