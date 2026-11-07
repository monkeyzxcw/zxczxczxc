import fs from 'node:fs';
import path from 'node:path';
import { parseTree, parseUeTimestamp } from './ueLog.js';

export const FE_CURRENCY_ID = 100300;
const OWN_PRICE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const COMMUNITY_REFRESH_MS = 15 * 60 * 1000;
const COMMUNITY_PAGE_SIZE = 1000;
const COMMUNITY_MAX_PAGES = 20;

// Read-only public community-price endpoint used by the Gorn reference app.
// No player identity, game log content, or account data is uploaded by Nexus.
const COMMUNITY_BASE_URL = 'https://qhjulyngunwiculnharg.supabase.co';
const COMMUNITY_PUBLIC_KEY = 'sb_publishable_YgqYSMUarrM_IKvcNpJlBw_KwTpp7ho';

function directScalar(node, key) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const raw = node[key];
  if (Array.isArray(raw)) {
    for (let i = raw.length - 1; i >= 0; i--) {
      if (typeof raw[i] === 'string' || typeof raw[i] === 'number') return String(raw[i]);
    }
    return undefined;
  }
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined;
}

function findScalar(node, key) {
  if (Array.isArray(node)) {
    for (const item of node) { const found = findScalar(item, key); if (found !== undefined) return found; }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const direct = directScalar(node, key);
  if (direct !== undefined) return direct;
  for (const child of Object.values(node)) { const found = findScalar(child, key); if (found !== undefined) return found; }
  return undefined;
}

function findProperty(node, key) {
  if (Array.isArray(node)) {
    for (const item of node) { const found = findProperty(item, key); if (found !== undefined) return found; }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  if (Object.hasOwn(node, key)) return node[key];
  for (const child of Object.values(node)) { const found = findProperty(child, key); if (found !== undefined) return found; }
  return undefined;
}

function numericLeaves(node, out = []) {
  if (Array.isArray(node)) { for (const value of node) numericLeaves(value, out); return out; }
  if (typeof node === 'string' || typeof node === 'number') {
    const n = Number(node);
    if (Number.isFinite(n) && n > 0) out.push(n);
    return out;
  }
  if (node && typeof node === 'object') for (const value of Object.values(node)) numericLeaves(value, out);
  return out;
}

export function percentile(values, p) {
  const sorted = [...values].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * Math.max(0, Math.min(1, p));
  const low = Math.floor(index), high = Math.ceil(index);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/**
 * Captures Exchange price searches exactly as the game writes them to UE_game.log.
 * SendMessage remembers synId -> refer (ConfigBaseId); the matching response
 * contributes its FE listings. We never send messages to the game.
 */
export class ExchangePriceTracker {
  constructor() { this.pending = new Map(); this.observations = 0; this.unmatched = 0; this.lastObservation = null; }

  handle(message) {
    if (!message || message.action !== 'XchgSearchPrice') return null;
    const tree = parseTree(message.body || []);
    const synId = String(message.synId ?? '');
    if (/^SendMessage$/i.test(message.kind || '')) {
      const refer = Number(findScalar(tree, 'refer'));
      if (Number.isSafeInteger(refer) && refer > 0 && synId) this.pending.set(synId, refer);
      return null;
    }

    const configBaseId = this.pending.get(synId);
    if (configBaseId === undefined) { this.unmatched++; return null; }
    this.pending.delete(synId);

    const pricesNode = findProperty(tree, 'prices');
    const groups = pricesNode && typeof pricesNode === 'object' ? Object.values(pricesNode) : [];
    let selected = null;
    let fallback = null;
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const unitPricesNode = Object.hasOwn(group, 'unitPrices') ? group.unitPrices : findProperty(group, 'unitPrices');
      if (unitPricesNode === undefined) continue;
      const unitPrices = numericLeaves(unitPricesNode);
      if (!unitPrices.length) continue;
      const currencyRaw = directScalar(group, 'currency');
      const currency = currencyRaw === undefined ? FE_CURRENCY_ID : Number(currencyRaw);
      const candidate = { currency, unitPrices };
      if (!fallback) fallback = candidate;
      if (currency === FE_CURRENCY_ID) { selected = candidate; break; }
    }
    selected ||= fallback;
    if (!selected || selected.currency !== FE_CURRENCY_ID) return null;

    const sorted = [...selected.unitPrices].sort((a, b) => a - b);
    const observedAt = parseUeTimestamp(message.time) ?? Date.now();
    const observation = {
      configBaseId, fe: percentile(sorted, 0.1), median: percentile(sorted, 0.5),
      min: sorted[0], sampleSize: sorted.length, observedAt, source: 'exchange',
    };
    if (!observation.fe || !Number.isFinite(observation.fe)) return null;
    this.observations++;
    this.lastObservation = { ...observation, synId };
    return observation;
  }

  resetPending() { this.pending.clear(); }
}

export class PriceBook {
  constructor({ ownCachePath = null } = {}) {
    this.ownCachePath = ownCachePath;
    this.own = new Map();
    this.community = new Map();
    this.seasonId = null;
    this.loadOwnCache();
  }

  loadOwnCache() {
    if (!this.ownCachePath) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.ownCachePath, 'utf8'));
      for (const row of data.prices || []) {
        if (Number.isSafeInteger(row.configBaseId) && Number.isFinite(row.fe) && row.fe > 0 && Number.isFinite(row.observedAt)) {
          this.own.set(row.configBaseId, row);
        }
      }
    } catch {}
  }

  saveOwnCache() {
    if (!this.ownCachePath) return;
    try {
      fs.mkdirSync(path.dirname(this.ownCachePath), { recursive: true });
      fs.writeFileSync(this.ownCachePath, JSON.stringify({ version: 1, prices: [...this.own.values()] }), 'utf8');
    } catch {}
  }

  setOwn(observation) {
    if (!observation || observation.configBaseId === FE_CURRENCY_ID || !Number.isFinite(observation.fe) || observation.fe <= 0) return false;
    const previous = this.own.get(observation.configBaseId);
    if (previous && previous.observedAt > observation.observedAt) return false;
    this.own.set(observation.configBaseId, { ...observation, seasonId: observation.seasonId ?? this.seasonId, source: 'exchange' });
    this.saveOwnCache();
    return true;
  }

  setSeason(seasonId) { this.seasonId = Number(seasonId) || null; this.community.clear(); }

  setCommunity(rows, seasonId) {
    if (Number(seasonId) !== Number(this.seasonId)) return;
    this.community.clear();
    for (const row of rows || []) {
      if (Number.isSafeInteger(row.configBaseId) && Number.isFinite(row.fe) && row.fe > 0) {
        this.community.set(row.configBaseId, { ...row, source: 'community' });
      }
    }
  }

  get(id, now = Date.now()) {
    const configBaseId = Number(id);
    if (configBaseId === FE_CURRENCY_ID) return { configBaseId, fe: 1, source: 'fixed', updatedAt: null };
    const rawOwn = this.own.get(configBaseId) || null;
    const own = rawOwn && (this.seasonId === null || Number(rawOwn.seasonId) === Number(this.seasonId)) ? rawOwn : null;
    const community = this.community.get(configBaseId) || null;
    if (own && (!community || now - own.observedAt < OWN_PRICE_TTL_MS || (Date.parse(community.updatedAt) || 0) <= own.observedAt)) {
      return { ...own, source: 'exchange' };
    }
    return community ? { ...community } : own ? { ...own, source: 'exchange (устарела)' } : null;
  }

  all(now = Date.now()) {
    const ids = new Set([...this.own.keys(), ...this.community.keys()]);
    return [...ids].map((configBaseId) => this.get(configBaseId, now)).filter(Boolean);
  }

  status() {
    return { ownCount: this.own.size, communityCount: this.community.size, seasonId: this.seasonId };
  }
}

/** Read-only seasonal community prices, cached locally and refreshed every 15 min. */
export class CommunityPriceFeed {
  constructor({ cachePath = null, fetchImpl = globalThis.fetch, onUpdate = () => {} } = {}) {
    this.cachePath = cachePath;
    this.fetchImpl = fetchImpl;
    this.onUpdate = onUpdate;
    this.seasonId = null;
    this.prices = new Map();
    this.cursor = null;
    this.timer = null;
    this.fetchedAt = null;
    this.stale = false;
    this.error = null;
    this.fetching = false;
  }

  start(seasonId) {
    const next = Number(seasonId);
    if (!Number.isSafeInteger(next) || next <= 0 || next === this.seasonId) return;
    this.stop();
    this.seasonId = next;
    this.prices.clear(); this.cursor = null; this.fetchedAt = null; this.stale = false; this.error = null;
    this.loadCache();
    this.onUpdate(this.snapshot());
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), COMMUNITY_REFRESH_MS);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  loadCache() {
    if (!this.cachePath) return;
    try {
      const cached = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (Number(cached.seasonId) !== this.seasonId || !Array.isArray(cached.prices)) return;
      for (const row of cached.prices) this.prices.set(Number(row.configBaseId), row);
      this.cursor = cached.cursor || null;
      this.fetchedAt = cached.fetchedAt ? Date.parse(cached.fetchedAt) : null;
    } catch {}
  }

  saveCache() {
    if (!this.cachePath || !this.seasonId) return;
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify({
        version: 1, seasonId: this.seasonId, cursor: this.cursor,
        fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
        prices: [...this.prices.values()],
      }), 'utf8');
    } catch {}
  }

  async fetchPage(offset, since) {
    const url = new URL('/rest/v1/aggregated_prices', COMMUNITY_BASE_URL);
    url.searchParams.set('select', 'config_base_id,price_fe_median,price_fe_p10,submission_count,unique_devices,updated_at');
    url.searchParams.set('season_id', `eq.${this.seasonId}`);
    url.searchParams.set('order', 'updated_at.asc,config_base_id.asc');
    if (since) url.searchParams.set('updated_at', `gt.${since}`);
    const response = await this.fetchImpl(url, {
      headers: { apikey: COMMUNITY_PUBLIC_KEY, Authorization: `Bearer ${COMMUNITY_PUBLIC_KEY}`, Range: `${offset}-${offset + COMMUNITY_PAGE_SIZE - 1}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async refresh() {
    if (this.seasonId === null || this.fetching || typeof this.fetchImpl !== 'function') return 0;
    this.fetching = true;
    try {
      let offset = 0, changed = 0;
      const since = this.cursor;
      for (let page = 0; page < COMMUNITY_MAX_PAGES; page++) {
        const rows = await this.fetchPage(offset, since);
        if (!Array.isArray(rows)) throw new Error('Некорректный ответ базы цен');
        for (const row of rows) {
          const configBaseId = Number(row.config_base_id);
          const fe = Number(row.price_fe_median);
          if (!Number.isSafeInteger(configBaseId) || !Number.isFinite(fe) || fe <= 0 || !row.updated_at) continue;
          this.prices.set(configBaseId, {
            configBaseId, fe, p10: Number(row.price_fe_p10) || null,
            submissions: Number(row.submission_count) || 0,
            devices: Number(row.unique_devices) || 0,
            updatedAt: row.updated_at, source: 'community',
          });
          if (!this.cursor || row.updated_at > this.cursor) this.cursor = row.updated_at;
          changed++;
        }
        if (rows.length < COMMUNITY_PAGE_SIZE) break;
        offset += COMMUNITY_PAGE_SIZE;
      }
      this.fetchedAt = Date.now(); this.stale = false; this.error = null;
      if (changed > 0) this.saveCache();
      this.onUpdate(this.snapshot());
      return changed;
    } catch (error) {
      this.stale = true;
      this.error = String(error?.message || error);
      this.onUpdate(this.snapshot());
      return 0;
    } finally { this.fetching = false; }
  }

  snapshot() {
    return { seasonId: this.seasonId, count: this.prices.size, fetchedAt: this.fetchedAt,
      stale: this.stale, error: this.error, fetching: this.fetching };
  }

  all() { return [...this.prices.values()]; }
}

export function summarizeLoot(totals, priceBook, nameOf) {
  const rows = [];
  let totalValueFe = 0, pricedTypes = 0, unpricedTypes = 0, pricedQuantity = 0, totalQuantity = 0;
  for (const [rawId, rawQty] of totals) {
    const id = Number(rawId), qty = Number(rawQty);
    if (!Number.isSafeInteger(id) || !Number.isFinite(qty) || qty <= 0) continue;
    totalQuantity += qty;
    const name = nameOf(id);
    // Bound items cannot be sold; Gorn excludes them from net valuation.
    const isBound = /^(?:\u0421\u0432\u044f\u0437\u0430\u043d\u043d\u044b\u0439\s*[:：-]?|Bound\s+)/i.test(String(name || ''));
    const price = isBound ? { fe: 0, source: 'bound' } : priceBook.get(id);
    const unitPrice = price?.fe ?? null;
    const valueFe = unitPrice === null ? null : unitPrice * qty;
    if (valueFe !== null) { totalValueFe += valueFe; pricedTypes++; pricedQuantity += qty; }
    else unpricedTypes++;
    rows.push({ id, name, count: qty, unitPrice, valueFe,
      priceSource: price?.source ?? null, priceUpdatedAt: price?.updatedAt ?? price?.observedAt ?? null });
  }
  rows.sort((a, b) => {
    if (a.valueFe === null && b.valueFe !== null) return 1;
    if (a.valueFe !== null && b.valueFe === null) return -1;
    return (b.valueFe ?? 0) - (a.valueFe ?? 0) || b.count - a.count || a.name.localeCompare(b.name, 'ru');
  });
  return { rows, totalValueFe, pricedTypes, unpricedTypes, pricedQuantity, totalQuantity };
}
