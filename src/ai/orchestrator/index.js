/**
 * Orchestrator (DESIGN.md §3.6): one visitor message → one structured reply.
 *
 *   rules pre-pass → intent & slots (LLM, JSON) → route →
 *     smalltalk / handoff          canned, no model call
 *     flow_entry / live_search     ask the next missing slot (one at a time), or
 *                                  run the product's tool with the slots
 *     knowledge / both             retriever (+ tool for both)
 *     out_of_scope                 a short refusal in the brand voice
 *   → answer (model may call up to 3 tools in total this turn) → grounding check
 *   → { text, cards, chips, sources, followUps } + trace
 *
 * Never throws: when the model is down the visitor gets a canned message, any
 * live results already fetched (as cards), and a "contact the team" chip.
 *
 * Dependencies are injectable (llm, tools, retriever, now) so the scenario
 * tests run without a network.
 */

const defaultLlm = require('../llm');
const defaultTools = require('../tools');
const defaultRetriever = require('../retrieve');
const settingsStore = require('../settings');
const { prepass } = require('./rules');
const { extract } = require('./extract');
const { ground, looksLikeToolCall } = require('./grounding');
const { createSafeStream } = require('./stream');
const prompt = require('../prompt');
const { links } = require('../tools/catalog/site');

const MAX_TOOL_CALLS = 3;

const ISLANDS = /^(mah[eé]|praslin|la digue|silhouette|curieuse|cousin|aride|bird|denis|fr[eé]gate|desroches|north|moyenne|f[eé]licit[eé]|alphonse)( island)?$/i;
const ON_TOPIC = /seychell|mah[eé]\b|praslin|la digue|silhouette|curieuse|vall[eé]e de mai|beau vallon|anse |victoria|sainte anne|hotel|resort|villa|excursion|tour\b|cruise|snorkel|diving|transfer|ferry|airport|beach|island|office|address|phone|e-?mail|contact|company|owner|who are you|about (you|us)/i;
// A few very common English words: enough to tell English from French/German/Italian/Hinglish.
const ENGLISH = /\b(the|how|what|which|is|are|cost|price|much|does|can|we|for|and|best|show|me)\b/i;

// ── Canned replies (D8: the visitor's language; English for anything else) ──
const T = {
  greeting: {
    en: 'Hello! I can help you plan your Seychelles trip — islands, hotels, excursions and transfers. What would you like to do?',
    fr: 'Bonjour ! Je peux vous aider à préparer votre voyage aux Seychelles — îles, hôtels, excursions et transferts. Que souhaitez-vous faire ?',
    de: 'Hallo! Ich helfe Ihnen bei der Planung Ihrer Seychellen-Reise — Inseln, Hotels, Ausflüge und Transfers. Womit kann ich helfen?',
    it: 'Ciao! Posso aiutarti a organizzare il tuo viaggio alle Seychelles — isole, hotel, escursioni e transfer. Cosa ti serve?',
    hi: 'Namaste! Main aapki Seychelles trip plan karne mein madad kar sakta hoon — islands, hotels, excursions aur transfers. Aap kya dekhna chahenge?',
  },
  thanks: { en: "You're welcome! Anything else I can help with for your trip?", fr: 'Avec plaisir ! Puis-je vous aider pour autre chose ?', de: 'Gern geschehen! Kann ich sonst noch helfen?', it: 'Prego! Posso aiutarti con altro?', hi: 'Aapka swagat hai! Trip ke liye aur kuch madad chahiye?' },
  bye: { en: 'Have a wonderful trip! Come back any time.', fr: 'Excellent voyage ! Revenez quand vous voulez.', de: 'Gute Reise! Kommen Sie jederzeit wieder.', it: 'Buon viaggio! Torna quando vuoi.', hi: 'Aapki trip shandaar ho! Kabhi bhi wapas aaiye.' },
  handoff: {
    en: 'Of course — our team will be happy to help. Call +248 437 6666, email info@holidays-seychelles.com, or send us a query and we will reply by email, usually within a few hours.',
    fr: 'Bien sûr — notre équipe se fera un plaisir de vous aider. Envoyez-nous une demande et nous répondrons par e-mail.',
    de: 'Gern — unser Team hilft Ihnen. Senden Sie uns eine Anfrage, wir antworten per E-Mail.',
    it: 'Certo — il nostro team sarà felice di aiutarti. Inviaci una richiesta e ti risponderemo via email.',
    hi: 'Zaroor — hamari team madad karegi. +248 437 6666 par call kijiye, info@holidays-seychelles.com par email kijiye, ya ek query bhejiye — hum email par jawab denge.',
  },
  down: {
    en: "Sorry, I can't answer properly right now. You can browse live prices on the website or send our team a query.",
    fr: 'Désolé, je ne peux pas répondre correctement pour le moment. Consultez les prix en direct sur le site ou envoyez une demande à notre équipe.',
    de: 'Entschuldigung, ich kann gerade nicht richtig antworten. Live-Preise finden Sie auf der Website, oder senden Sie unserem Team eine Anfrage.',
    it: 'Spiacente, al momento non riesco a rispondere. Puoi vedere i prezzi aggiornati sul sito o inviare una richiesta al team.',
    hi: 'Maaf kijiye, abhi main theek se jawab nahi de pa raha. Website par live prices dekh sakte hain ya team ko query bhej sakte hain.',
  },
  outOfScope: {
    en: "That's outside what I can help with — I'm here for your Seychelles trip. Would you like ideas for islands, hotels or excursions?",
    fr: "Cela sort de mon domaine — je suis là pour votre voyage aux Seychelles. Voulez-vous des idées d'îles, d'hôtels ou d'excursions ?",
    de: 'Dabei kann ich leider nicht helfen — ich bin für Ihre Seychellen-Reise da. Möchten Sie Ideen zu Inseln, Hotels oder Ausflügen?',
    it: 'Questo esula da ciò in cui posso aiutarti — sono qui per il tuo viaggio alle Seychelles. Vuoi idee su isole, hotel o escursioni?',
    hi: 'Is mein main madad nahi kar sakta — main aapki Seychelles trip ke liye hoon. Islands, hotels ya excursions ke ideas chahiye?',
  },
  ownOnly: {
    en: "I only recommend hotels, excursions and transfers from our own live system, so you can see the details and book right here. Tell me the island and your dates and I'll show you the options.",
    fr: "Je recommande uniquement les hôtels, excursions et transferts de notre système en direct, réservables ici. Indiquez-moi l'île et vos dates et je vous montre les options.",
    de: 'Ich empfehle nur Hotels, Ausflüge und Transfers aus unserem Live-System, die Sie hier buchen können. Nennen Sie mir Insel und Reisedaten, dann zeige ich Ihnen die Angebote.',
    it: "Consiglio solo hotel, escursioni e transfer dal nostro sistema in tempo reale, prenotabili qui. Dimmi l'isola e le date e ti mostro le opzioni.",
    hi: 'Main sirf hamare live system ke hotels, excursions aur transfers hi suggest karta hoon, taaki aap details dekh kar yahin book kar sakein. Island aur dates batayiye, main options dikhata hoon.',
  },
  downWithResults: { en: 'Here are the live options I found. Open one to see details and book.', fr: 'Voici les options trouvées en direct. Ouvrez-en une pour voir les détails.', de: 'Hier sind die aktuellen Angebote. Öffnen Sie eines für Details.', it: 'Ecco le opzioni disponibili. Aprine una per i dettagli.', hi: 'Ye live options mile hain. Details aur booking ke liye kholiye.' },
};
const t = (key, lang) => T[key][lang] || T[key].en;

const ASK = {
  destination: { en: 'Which island would you like to stay on?', fr: 'Sur quelle île souhaitez-vous séjourner ?', de: 'Auf welcher Insel möchten Sie übernachten?', it: 'Su quale isola vorresti soggiornare?', hi: 'Aap kis island par rukna chahenge?' },
  checkIn: { en: 'What are your check-in and check-out dates?', fr: "Quelles sont vos dates d'arrivée et de départ ?", de: 'Wann möchten Sie an- und abreisen?', it: 'Quali sono le date di arrivo e partenza?', hi: 'Aapki check-in aur check-out dates kya hain?' },
  checkOut: { en: 'And your check-out date (or how many nights)?', fr: 'Et votre date de départ (ou combien de nuits) ?', de: 'Und Ihr Abreisedatum (oder wie viele Nächte)?', it: 'E la data di partenza (o quante notti)?', hi: 'Aur check-out date (ya kitni raatein)?' },
  transferFrom: { en: 'Where should the transfer pick you up — the airport, a jetty or a hotel?', fr: "Où le transfert doit-il vous prendre — à l'aéroport, à la jetée ou à l'hôtel ?", de: 'Wo sollen wir Sie abholen — Flughafen, Anleger oder Hotel?', it: "Dove ti veniamo a prendere — aeroporto, molo o hotel?", hi: 'Transfer aapko kahan se le — airport, jetty ya hotel?' },
  transferTo: { en: 'Where are you going — which hotel or area?', fr: 'Où allez-vous — quel hôtel ou quel quartier ?', de: 'Wohin möchten Sie — welches Hotel oder welche Gegend?', it: 'Dove vai — quale hotel o zona?', hi: 'Aapko kahan jaana hai — kaunsa hotel ya area?' },
  date: { en: 'Which date?', fr: 'Pour quelle date ?', de: 'An welchem Datum?', it: 'Per quale data?', hi: 'Kaunsi date?' },
};
const ask = (slot, lang) => (ASK[slot] ? ASK[slot][lang] || ASK[slot].en : ASK.date.en);

const REQUIRED = {
  hotels: ['destination', 'checkIn', 'checkOut'],
  excursions: [],
  transfers: ['transferFrom', 'transferTo', 'date'],
};
const ISLAND_CHIPS = ['Mahé', 'Praslin', 'La Digue'];
const START_CHIPS = [
  { label: 'Hotels', action: { type: 'message', text: 'I am looking for a hotel' } },
  { label: 'Excursions', action: { type: 'message', text: 'Show me excursions' } },
  { label: 'Transfers', action: { type: 'message', text: 'I need a transfer' } },
  { label: 'Which island?', action: { type: 'message', text: 'Which island should I choose?' } },
];
const HANDOFF_CHIP = { label: 'Contact our team', action: { type: 'handoff', url: links.dashboard({ tab: 'queries' }) } };

const { cardsFrom } = require('./cards');

const { hasBrand } = require('./names');

function productFromWords(text) {
  if (/\b(hotels?|stay|resorts?|villas?|accommodation|rooms?|guest ?houses?)\b/i.test(text) || hasBrand(text)) return 'hotels';
  if (/\b(excursions?|tours?|trips?|activit(y|ies)|cruises?|snorkel\w*|diving|boat)\b/i.test(text)) return 'excursions';
  if (/\b(transfers?|taxi|pick ?up|drop ?off|airport to)\b/i.test(text)) return 'transfers';
  return null;
}
// "Best hotel in Mahé", "recommend a snorkelling tour", "hotels from booking.com": a
// product request, answered with our live cards, never a list from the model.
const RECOMMEND = /\b(best|top|recommend\w*|suggest\w*|good|great|nice|cheap\w*|budget|luxury|luxurious|[345][- ]?star|five[- ]star|four[- ]star|which|compare|better|vs\.?|versus|rated|famous|popular|sasta|saste|sasti|achh?a|acchi|badhiya|mehenga|booking\.com|expedia|airbnb|trip ?advisor|google|internet)\b/i;

/** Transfer place names → ids: departures matching "from", then arrivals from it matching "to". */
async function resolveTransfer(tools, slots, ctx) {
  const words = (s) => String(s || '').replace(/\b(the|airport|international|hotel|resort|jetty)\b/gi, (w) => (/airport|jetty/i.test(w) ? w : '')).trim();
  const from = words(slots.transferFrom);
  let deps = await tools.run('transfers.departures', { query: from }, ctx);
  if (deps.ok && !deps.data.items.length && from.split(/\s+/).length > 1) deps = await tools.run('transfers.departures', { query: from.split(/\s+/).pop() }, ctx);
  if (!deps.ok || !deps.data.items.length) return { error: 'from', calls: [deps] };
  // "the airport" means the international airport on Mahé unless the visitor named Praslin.
  const fromText = String(slots.transferFrom).toLowerCase();
  const rank = (d) => (fromText.includes('praslin') ? /praslin/i.test(d.name) : /international/i.test(d.name)) ? 0 : 1;
  const candidates = deps.data.items.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 3);
  const to = words(slots.transferTo);
  const calls = [deps];
  for (const dep of candidates) {
    for (const q of [...new Set([to, to.split(/\s+/).slice(-2).join(' '), to.split(/\s+/)[0]])].filter(Boolean)) {
      // eslint-disable-next-line no-await-in-loop
      const arrs = await tools.run('transfers.arrivals', { departureId: dep.id, departureType: dep.type, query: q }, ctx);
      calls.push(arrs);
      if (arrs.ok && arrs.data.items.length) return { dep, arr: arrs.data.items[0], calls };
    }
  }
  return { error: 'to', dep: candidates[0], calls };
}

/** The product's search, straight from the slots (no model needed to pick it). */
async function runProduct(product, slots, tools, ctx) {
  if (product === 'hotels') {
    return [await tools.run('hotels.search', { destination: slots.destination, checkIn: slots.checkIn, checkOut: slots.checkOut, adults: slots.adults || 2, childAges: slots.childAges || [], ...(slots.budget ? { maxPrice: slots.budget } : {}) }, ctx)];
  }
  if (product === 'excursions') {
    const input = { adults: slots.adults || 2, childAges: slots.childAges || [] };
    if (slots.date || slots.checkIn) input.date = slots.date || slots.checkIn;
    if (slots.excursionName) input.name = slots.excursionName;
    if (slots.excursionCategory) input.category = slots.excursionCategory;
    // Only a whole island filters by island; a place on one ("Beau Vallon") is
    // matched in the excursion name instead ("Jet Ski | Beau Vallon").
    if (slots.destination && ISLANDS.test(slots.destination)) input.island = slots.destination;
    else if (slots.destination) input.name = [input.name, slots.destination].filter(Boolean).join(' ');
    return [await tools.run('excursions.search', input, ctx)];
  }
  if (product === 'transfers') {
    const r = await resolveTransfer(tools, slots, ctx);
    if (r.error) return r.calls.map((c) => c).concat([{ tool: 'transfers.search', ok: false, error: { code: 'PLACE_NOT_FOUND', message: r.error === 'from' ? `No transfer pick-up found for “${slots.transferFrom}”.` : `No transfer from ${r.dep.name} to “${slots.transferTo}” was found.` } }]);
    return [...r.calls, await tools.run('transfers.search', { departureId: r.dep.id, departureType: r.dep.type, departureName: r.dep.name, arrivalId: r.arr.id, arrivalType: r.arr.type, arrivalName: r.arr.name, date: slots.date || slots.checkIn, adults: slots.adults || 2, childAges: slots.childAges || [] }, ctx)];
  }
  return [];
}

function parseFollowUps(raw) {
  // Models often put a "---" rule before the follow-up line; drop it either way.
  const tidy = (s) => s.replace(/\s*-{3,}\s*$/, '').trim();
  const text = tidy(String(raw || ''));
  const m = text.match(/\n\s*(?:FOLLOW[- ]?UPS?|SUGGESTIONS?)\s*:\s*(.+)\s*$/i);
  if (!m) return { text, followUps: [] };
  return { text: tidy(text.slice(0, m.index)), followUps: m[1].split('|').map((s) => s.trim().replace(/^["“]|["”]$/g, '')).filter((s) => s && s.length <= 80 && !/^[a-c]$/i.test(s)).slice(0, 3) };
}

function todayInSeychelles(now) {
  // Seychelles is UTC+4 all year.
  return new Date(now.getTime() + 4 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * input: { message, history?: [{ role, content }], state?: { slots, product, language },
 *          userId?, sessionId?, audience?: 'public'|'admin' }
 * → { reply: { text, cards, chips, sources, followUps }, state, trace }
 */
async function handleTurn(input, deps = {}) {
  const llm = deps.llm || defaultLlm;
  const tools = deps.tools || defaultTools;
  const retriever = deps.retriever || defaultRetriever;
  const now = deps.now ? deps.now() : new Date();
  const t0 = Date.now();
  const today = todayInSeychelles(now);
  const message = String(input.message || '').trim().slice(0, 2000);
  const history = Array.isArray(input.history) ? input.history.slice(-10) : [];
  const state = { slots: {}, product: null, language: 'en', ...(input.state || {}) };
  const ctx = { audience: input.audience === 'admin' ? 'admin' : 'public', userId: input.userId || null, ...(deps.toolCtx || {}) };
  const trace = { today, message, steps: [], tools: [], retrieval: null, llm: [], route: null };
  const finish = (reply, extra = {}) => ({
    reply: { text: reply.text, cards: reply.cards || [], chips: reply.chips || [], sources: reply.sources || [], followUps: reply.followUps || [], ...(reply.input ? { input: reply.input } : {}) },
    state: { ...state, ...extra.state },
    trace: { ...trace, ms: Date.now() - t0, ...extra.trace },
  });

  if (!message) return finish({ text: t('greeting', state.language), chips: START_CHIPS }, { trace: { route: 'smalltalk' } });

  // 1. Rules pre-pass.
  const rules = prepass(message, { today });
  trace.rules = rules;
  if (rules.kind === 'greeting' || rules.kind === 'thanks' || rules.kind === 'bye') {
    const lang = /bonjour|bonsoir|salut|merci|au revoir/i.test(message) ? 'fr' : /hallo|danke|tschüss|tschuss/i.test(message) ? 'de' : /ciao|buongiorno|grazie|arrivederci/i.test(message) ? 'it' : /namaste|namaskar|dhanyavad|shukriya|alvida/i.test(message) ? 'hi' : state.language;
    return finish({ text: t(rules.kind, lang), chips: rules.kind === 'greeting' ? START_CHIPS : [] }, { state: { language: lang }, trace: { route: 'smalltalk', via: 'rules' } });
  }
  if (rules.kind === 'handoff') {
    return finish({ text: t('handoff', state.language), chips: [HANDOFF_CHIP] }, { trace: { route: 'handoff', via: 'rules' } });
  }

  const s = deps.settings || (await settingsStore.getEffective());

  // 2. Intent and slots.
  const tm = {};
  let tStep = Date.now();
  const x = await extract({ message, history, state, rules, today, llm, model: s.routerModel || undefined, sessionId: input.sessionId });
  trace.extract = { intent: x.intent, product: x.product, language: x.language, extracted: x.extracted, via: x.via, error: x.error };
  tm.extractMs = Date.now() - tStep;
  // The router sometimes calls plain English "fr" because of one accented name ("vallée de mai tour cost").
  const lang = x.language && x.language !== 'en' && ENGLISH.test(message) ? 'en' : x.language || state.language;
  let route = x.intent;
  let product = x.product;
  const slots = x.slots;
  // The router sometimes names the intent but forgets the product ("I am looking
  // for a hotel" → flow_entry, product null): words decide then.
  if (!product && ['live_search', 'flow_entry', 'both'].includes(route)) {
    product = productFromWords(message);
    if (product) trace.steps.push(`product from words: ${product}`);
  }
  // "Is La Digue good for cycling?" after a hotel search is a question about the
  // place, not another search: no booking words and no new dates → knowledge.
  const asking = /^(is|are|what|which|how|can|do|does|where|when|why|tell me)\b/i.test(message) || /\?\s*$/.test(message);
  const wantsLive = /\b(hotels?|stay|rooms?|villas?|resorts?|prices?|cost|rates?|book|availab|nights?|cheap|cheaper|cheapest|budget|expensive|dates?|options?|excursions?|tours?|trips?|cruises?|transfers?|taxi|pick ?up|snorkel|diving)\b/i.test(message) || /^(what|how) about\b/i.test(message) || x.extracted.checkIn || x.extracted.date;
  if (route === 'live_search' && asking && !wantsLive && !state.pending) {
    trace.steps.push('live_search → knowledge: a question about a place, no booking words');
    route = 'knowledge';
  }
  // We just asked for a detail (island, dates, pick-up…) and the reply is short:
  // it is the answer, whatever the router thought ("Praslin" is not a
  // knowledge question right after "Which island?").
  if (state.pending && state.product && message.length <= 60 && !['handoff', 'out_of_scope'].includes(route) && !(x.product && x.product !== state.product)) {
    if (route !== 'live_search' && route !== 'flow_entry') trace.steps.push(`continued ${state.product} flow (router said ${route})`);
    route = 'live_search';
    product = state.product;
    const answer = message.replace(/[.!?]+$/, '').trim();
    if (state.pending === 'destination' && !x.extracted.destination) slots.destination = answer;
    if (state.pending === 'transferFrom' && !x.extracted.transferFrom) slots.transferFrom = answer;
    if (state.pending === 'transferTo' && !x.extracted.transferTo) slots.transferTo = answer;
  }
  // pending is set again only when this turn asks for a detail; otherwise it is cleared.
  const nextState = { slots, product: product || state.product, language: lang, pending: null };

  if (!route) {
    // The router model is down: try to keep going on the main model later, as a knowledge question.
    route = 'knowledge';
    trace.steps.push('router failed → knowledge');
  }
  if (route === 'handoff') return finish({ text: t('handoff', lang), chips: [HANDOFF_CHIP] }, { state: nextState, trace: { route } });
  // A fixed, friendly refusal: no model call, so it can't be argued with and costs nothing.
  // A message that names a Seychelles place or one of our products is never out of scope.
  if (route === 'out_of_scope' && ON_TOPIC.test(message)) {
    route = 'knowledge';
    trace.steps.push('out_of_scope overridden: on-topic words');
  }
  if (['knowledge', 'smalltalk'].includes(route) && RECOMMEND.test(message) && productFromWords(message)) {
    product = productFromWords(message);
    route = 'flow_entry';
    nextState.product = product;
    trace.steps.push(`product request → live ${product} search (never a list from memory)`);
  }
  if (route === 'out_of_scope') return finish({ text: t('outOfScope', lang), chips: START_CHIPS }, { state: nextState, trace: { route } });
  if (route === 'smalltalk' && message.length < 40) return finish({ text: t('greeting', lang), chips: START_CHIPS }, { state: nextState, trace: { route } });
  if ((route === 'live_search' || route === 'flow_entry' || route === 'both') && !product) route = route === 'both' ? 'knowledge' : 'flow_entry';

  // 3. Missing slots → ask one at a time.
  if ((route === 'live_search' || route === 'flow_entry') && product) {
    const missing = REQUIRED[product].filter((k) => !slots[k] && !(k === 'date' && slots.checkIn));
    if (missing.length) {
      const slot = missing[0];
      const chips = slot === 'destination' ? ISLAND_CHIPS.map((i) => ({ label: i, action: { type: 'message', text: i } })) : slot === 'transferFrom' ? [{ label: 'Seychelles International Airport', action: { type: 'message', text: 'From Seychelles International Airport' } }] : [];
      // A hint for the widget: show a date picker instead of making the visitor type dates.
      const input = slot === 'checkIn' || slot === 'checkOut' ? { type: 'dateRange', slot, min: today } : slot === 'date' ? { type: 'date', slot, min: today } : undefined;
      return finish({ text: ask(slot, lang), chips, input }, { state: { ...nextState, pending: slot }, trace: { route, missing } });
    }
    if (route === 'flow_entry' && product === 'excursions' && !Object.keys(x.extracted).length) {
      // "Show me excursions" with nothing else: still search (today onwards).
    }
    route = 'live_search';
  }
  trace.route = route;

  // 4. Gather: knowledge and/or live results.
  const results = [];
  let retrieval = null;
  tStep = Date.now();
  if (route === 'knowledge' || route === 'both') {
    try {
      retrieval = await retriever.retrieve(message, { audience: ctx.audience, destination: slots.island || (slots.destination && /^[a-z-]+$/.test(slots.destination) ? slots.destination : undefined) });
      trace.retrieval = { insufficient: retrieval.insufficient, bestScore: retrieval.bestScore, chunkIds: retrieval.hits.map((h) => h.chunkId), sources: retrieval.sources.map((x2) => x2.title) };
    } catch (err) {
      trace.retrieval = { error: err.message };
    }
  }
  tm.retrievalMs = Date.now() - tStep;
  tStep = Date.now();
  if ((route === 'live_search' || route === 'both') && product) {
    const r = await runProduct(product, slots, tools, ctx);
    results.push(...r);
  }
  // API connectors (extra track 2.3 / 2.4): a question that matches one gets
  // its data. One with only fixed parameters is called now; one the model has
  // to fill in gets a tool round, even while streaming.
  let connectorRound = false;
  if (route !== 'out_of_scope' && route !== 'smalltalk' && route !== 'handoff') {
    const matched = deps.connectors !== undefined ? deps.connectors : await require('../tools/connectors').match(message).catch(() => []);
    for (const c of matched) {
      if ((c.params || []).some((p) => p.value === undefined && p.required)) { connectorRound = true; continue; }
      // eslint-disable-next-line no-await-in-loop
      results.push(await tools.run(c.tool, {}, ctx));
    }
    if (matched.length) trace.steps.push(`API connectors matched: ${matched.map((c) => c.tool).join(', ')}`);
  }
  const apiData = results.some((r) => r.ok && String(r.tool).startsWith('api.'));
  tm.toolsMs = Date.now() - tStep;
  tStep = Date.now();
  trace.timings = tm;
  trace.tools = results.map((r) => ({ tool: r.tool, ok: r.ok, ms: r.ms, cached: r.cached, error: r.error?.code, total: r.data?.total }));

  // 5. Answer with the model (it may call more tools: details, links).
  const enabled = route === 'out_of_scope' ? [] : await tools.forModel({ userId: ctx.userId }).catch(() => []);
  // L2: the published business instructions, unless the playground passes a draft.
  const business = deps.business || (await prompt.publishedBusiness().catch(() => require('../prompt/store').SEED));
  const manifest = deps.manifest !== undefined ? deps.manifest : (await require('../prompt/manifest').get().catch(() => ({ text: '' }))).text;
  const routeNote = {
    knowledge: apiData ? 'Answer from the live data below (tool results) and the knowledge if it is relevant (cite knowledge).' : connectorRound ? 'If a live data tool fits the question, call it; otherwise answer from the knowledge below and cite it.' : retrieval?.insufficient ? 'The knowledge below has nothing relevant: say so briefly and offer to connect the visitor with the team. Do not answer from general knowledge.' : 'Answer from the knowledge below and cite it.',
    live_search: 'Summarise the live results below in 1–3 sentences (the visitor also sees them as cards). If there are none, say so and suggest other dates or islands.',
    both: 'Combine the knowledge (cite it) with the live results below.',
    out_of_scope: 'This request is outside what you help with. Decline in one friendly sentence and offer help with a Seychelles trip.',
    smalltalk: 'Reply briefly and offer help with the trip.',
    flow_entry: 'Help the visitor get started.',
  }[route] || '';
  const built = prompt.buildMessages({
    business,
    manifest,
    today,
    slots,
    signedIn: Boolean(ctx.userId),
    memory: deps.memory || '',
    history,
    message,
    routeNote: `${routeNote}\nEnd your reply with one line starting "FOLLOWUPS:" followed by up to 3 short questions the visitor might ask next, in their language, separated by " | " (for example: FOLLOWUPS: Which beach is best for swimming? | Show hotels on La Digue). If none fit, leave the line out.`,
    knowledge: retrieval && !retrieval.insufficient ? retrieval.context : null,
    toolResults: results.filter((r) => r.tool !== 'transfers.departures' && r.tool !== 'transfers.arrivals'),
    budget: s.promptBudgetTokens || prompt.DEFAULT_BUDGET,
  });
  const messages = built.messages;
  const known = [retrieval?.context, deps.memory, ...history.map((h) => h.content)].filter(Boolean).join(' ');
  trace.prompt = { tokens: built.tokens, trimmed: built.trimmed, draft: Boolean(deps.business) };

  let text = null;
  let calls = results.length ? 1 : 0; // the product search counts as one
  // Streaming (Phase 14): the answer is streamed without tools, through the
  // safe streamer. Only a turn about a result already shown ("rooms at the
  // second one") first gets one non-streamed round in which the model may call a tool.
  const streaming = typeof deps.onToken === 'function';
  let streamed = '';
  try {
    for (let round = 0; round <= MAX_TOOL_CALLS; round += 1) {
      const allowTools = enabled.length && calls < MAX_TOOL_CALLS && (!streaming || ((Boolean(deps.reference) || connectorRound) && round === 0));
      if (!allowTools && round > 0) messages.push({ role: 'system', content: 'No more tool calls this turn. Answer the visitor now from the results above.' });
      let r;
      try {
        if (streaming && !allowTools) {
          const safe = createSafeStream({ evidence: { toolData: results.filter((x) => x.ok).map((x) => x.data), slots, userText: message, known }, emit: deps.onToken });
          // eslint-disable-next-line no-await-in-loop
          r = await llm.chatStream({ messages, purpose: 'answer', sessionId: input.sessionId, onToken: (d) => safe.push(d) });
          streamed = safe.end();
          r.toolCalls = [];
        } else {
          // eslint-disable-next-line no-await-in-loop
          r = await llm.chat({ messages, tools: allowTools ? enabled : undefined, purpose: 'answer', sessionId: input.sessionId });
        }
      } catch (err) {
        // Every model refused the request with tools (or failed): answer once
        // more without them, from what was already gathered.
        if (!allowTools) throw err;
        trace.steps.push(`answer with tools failed (${err.code || 'ERROR'}) → retry without tools`);
        // eslint-disable-next-line no-await-in-loop
        r = await llm.chat({ messages, purpose: 'answer', sessionId: input.sessionId });
        r.toolCalls = [];
      }
      trace.llm.push({ model: r.model, ms: r.latencyMs, failed: (r.failures || []).map((f) => `${f.model}: ${f.code}`), tokensIn: r.usage?.prompt_tokens, tokensOut: r.usage?.completion_tokens, fallbackUsed: r.fallbackUsed, toolCalls: r.toolCalls?.length || 0 });
      if (!r.toolCalls?.length || !allowTools) {
        text = r.text;
        break;
      }
      messages.push({ role: 'assistant', content: r.text || '', tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) });
      for (const c of r.toolCalls) {
        const name = String(c.name || '').replace('_', '.');
        let res;
        if (calls >= MAX_TOOL_CALLS) res = { tool: name, ok: false, error: { code: 'LIMIT', message: 'Tool limit for this turn reached.' } };
        // eslint-disable-next-line no-await-in-loop
        else res = await tools.run(name, c.args || {}, ctx);
        calls += 1;
        results.push(res);
        trace.tools.push({ tool: res.tool, ok: res.ok, ms: res.ms, cached: res.cached, error: res.error?.code, total: res.data?.total, byModel: true });
        messages.push({ role: 'tool', tool_call_id: c.id, content: `<data kind="tool-result" tool="${name}">\n${prompt.fence(JSON.stringify(res.ok ? res.data : res.error).slice(0, 12000))}\n</data>` });
      }
    }
  } catch (err) {
    trace.llmError = { code: err.code || 'ERROR', message: err.message };
  }

  tm.answerMs = Date.now() - tStep;
  if (text && looksLikeToolCall(text)) {
    trace.steps.push('the model wrote a tool call as its answer → not shown');
    text = null;
  }
  const cards = cardsFrom(results);
  const listUrl = results.find((r) => r.ok && r.data?.url)?.data.url;
  if (!text) {
    return finish({ text: t(cards.length ? 'downWithResults' : 'down', lang), cards, chips: [...(listUrl ? [{ label: 'View on the website', action: { type: 'link', url: listUrl } }] : []), HANDOFF_CHIP] }, { state: nextState, trace: { route, fallback: 'canned' } });
  }

  // 6. Grounding check, citations, follow-ups.
  const fu = parseFollowUps(text);
  const toolData = results.filter((r) => r.ok).map((r) => r.data);
  const g = ground(fu.text, { toolData, slots, userText: message, known });
  trace.grounding = { removed: g.removed };
  const chips = [];
  const outside = g.removed.some((r) => r.kind === 'name' || r.kind === 'site');
  if (outside) {
    const p = product || productFromWords(message) || 'hotels';
    chips.push({ label: 'Search live', action: { type: 'message', text: { hotels: 'I am looking for a hotel', excursions: 'Show me excursions', transfers: 'I need a transfer' }[p] } });
  }
  if (!g.text.trim()) g.text = t('ownOnly', lang);
  if (g.removed.some((r) => r.kind === 'price')) chips.push({ label: 'Check live price', action: { type: 'link', url: listUrl || links.home() } });
  else if (listUrl) chips.push({ label: 'View all on the website', action: { type: 'link', url: listUrl } });
  if (route === 'knowledge' && retrieval?.insufficient) chips.push(HANDOFF_CHIP);
  const cited = new Set([...g.text.matchAll(/\[S(\d+)\]/g)].map((m) => `S${m[1]}`));
  const sources = (retrieval?.sources || []).filter((src) => cited.has(src.id));

  return finish({ text: g.text, cards: cardsFrom(results, { prefer: g.text }), chips, sources, followUps: fu.followUps }, { state: nextState, trace: { route, streamedChars: streaming ? streamed.length : undefined } });
}

module.exports = { handleTurn, cardsFrom, parseFollowUps, todayInSeychelles, REQUIRED, START_CHIPS, greeting: (lang) => t('greeting', lang) };
