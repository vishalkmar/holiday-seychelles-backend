/**
 * Result cards for the widget, built by code from tool results (so prices are
 * exact). Used by the orchestrator and by flow `cards` nodes.
 */

// Accents and the hyphen variants models use ("Semi‑Submarine") don't stop a match.
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‐-―−]/g, '-').toLowerCase();

/**
 * prefer: the answer text — items it names come first, so the cards show what
 * the answer talks about ("the Semi-Submarine Tour…" is a card, not item 9).
 */
function cardsFrom(results, { prefer = '' } = {}) {
  const cards = [];
  const said = fold(prefer);
  for (const raw of results) {
    if (!raw.ok || !Array.isArray(raw.data?.items)) continue;
    const named = (x) => (said && (x.name || x.product) && said.includes(fold(x.name || x.product)) ? 0 : 1);
    const r = said ? { ...raw, data: { ...raw.data, items: raw.data.items.map((x, i) => [x, i]).sort((a, b) => named(a[0]) - named(b[0]) || a[1] - b[1]).map(([x]) => x) } } : raw;
    if (r.tool === 'hotels.search') {
      r.data.items.slice(0, 6).forEach((h) => cards.push({ type: 'hotel', id: h.id, title: h.name, subtitle: [h.stars ? `${h.stars}★` : null, h.area, h.board].filter(Boolean).join(' · '), price: h.price, priceNote: `${r.data.nights} nights total`, currency: h.currency, image: h.thumbnail, url: h.url }));
    } else if (r.tool === 'excursions.search') {
      r.data.items.slice(0, 6).forEach((e) => cards.push({ type: 'excursion', id: e.id, title: e.name, subtitle: [e.category, e.island, e.runsOnDate ? null : `next ${e.nextDate}`].filter(Boolean).join(' · '), price: e.price, currency: e.currency, image: e.thumbnail, url: e.url }));
    } else if (r.tool === 'bookings.mine') {
      r.data.items.slice(0, 6).forEach((x) => cards.push({ type: 'booking', id: x.reference, title: x.product || x.reference, subtitle: [x.reference, x.checkIn, x.status, x.confirmed && x.status !== 'confirmed' ? 'supplier confirmed' : null].filter(Boolean).join(' · '), price: x.amount || null, currency: x.currency, priceNote: x.paid ? 'paid' : 'not paid', url: r.data.url || '/dashboard?tab=trips' }));
    } else if (r.tool === 'transfers.search') {
      r.data.items.slice(0, 4).forEach((x) => cards.push({ type: 'transfer', title: x.name, subtitle: [x.vehicle, x.maxPax ? `up to ${x.maxPax}` : null].filter(Boolean).join(' · '), price: x.price, currency: x.currency, url: r.data.url }));
    }
  }
  return cards;
}

module.exports = { cardsFrom };
