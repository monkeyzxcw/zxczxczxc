// Every number carries its epistemic status:
//  observed = counted directly from your own sessions; estimate = derived using prices you entered.
// NOTHING here is a game drop rate. Observed frequency != real drop probability.

export function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/** Median of the latest N observations per item in one currency. Missing => null (never 0). */
export function priceTable(store, currency, lastN = 5) {
  const rows = store.all('SELECT item_id,price FROM prices WHERE currency=? ORDER BY ts DESC', currency);
  const by = new Map();
  for (const r of rows) { const l = by.get(r.item_id) || []; if (l.length < lastN) { l.push(r.price); by.set(r.item_id, l); } }
  return new Map([...by].map(([id, l]) => [id, { median: median(l), n: l.length }]));
}

export function sessionStats(store, sessionId, { currency = 'Flame' } = {}) {
  const s = store.get('SELECT * FROM sessions WHERE id=?', sessionId);
  if (!s) return null;
  const durationSec = Math.max(0, Math.round(((s.last_ts ?? s.started_ts) - s.started_ts) / 1000));
  const picks = store.all(`SELECT e.item_id id, SUM(e.count) qty, COUNT(*) events, i.name, i.rarity FROM events e LEFT JOIN items i ON i.id=e.item_id
    WHERE e.session_id=? AND e.type='pick' AND e.item_id IS NOT NULL GROUP BY e.item_id ORDER BY qty DESC`, sessionId);
  const unrecognized = store.get(`SELECT COUNT(*) c FROM events WHERE session_id=? AND type='pick' AND item_id IS NULL`, sessionId).c;
  const areaVisits = store.get(`SELECT COUNT(*) c FROM events WHERE session_id=? AND type='area'`, sessionId).c;
  const total = picks.reduce((a, p) => a + p.qty, 0);
  const prices = priceTable(store, currency);
  let revenue = 0, pricedQty = 0;
  const items = picks.map((p) => {
    const pr = prices.get(p.id);
    if (pr) { revenue += pr.median * p.qty; pricedQty += p.qty; }
    return { itemId: p.id, name: p.name ?? null, qty: p.qty, pickEvents: p.events, unitPrice: pr?.median ?? null, priceObservations: pr?.n ?? 0, observedShare: total ? p.qty / total : 0 };
  });
  const hours = durationSec / 3600;
  const rarityKnown = picks.some((p) => p.rarity);
  return {
    sessionId, player: s.player, startedTs: s.started_ts, lastTs: s.last_ts, durationSec, areaVisits,
    observed: { totalItems: total, distinctItems: picks.length, itemsPerHour: hours > 0 ? total / hours : null, unrecognizedPickEvents: unrecognized,
      rareItems: rarityKnown ? picks.filter((p) => /rare|legend|unique/i.test(p.rarity || '')).reduce((a, p) => a + p.qty, 0) : null },
    estimate: { currency, revenue: pricedQty ? revenue : null, priceCoverage: total ? pricedQty / total : 0, costs: s.costs, net: pricedQty ? revenue - s.costs : null,
      netPerHour: pricedQty && hours > 0 ? (revenue - s.costs) / hours : null,
      note: 'revenue counts only items that have a price in the prices table; see priceCoverage' },
    items,
  };
}

export function csvEscape(v) { return '"' + String(v ?? '').replaceAll('"', '""') + '"'; }
export function exportEventsCsv(store) {
  const rows = store.all(`SELECT e.time,e.type,e.action,e.session_id,e.area,e.player,e.item_id,i.name,e.count,e.count_inferred,e.parse_status FROM events e LEFT JOIN items i ON i.id=e.item_id ORDER BY e.ts,e.id`);
  const head = ['time_utc_assumed', 'type', 'action', 'session', 'area', 'player', 'item_id', 'item_name', 'count', 'count_inferred', 'parse_status'];
  return [head, ...rows.map((r) => Object.values(r))].map((r) => r.map(csvEscape).join(',')).join('\r\n');
}
