import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 60 * 60 * 1000;
const MAX_PER_ITEM = 120;
const DEFAULT_RETENTION_DAYS = 120;

export class PriceHistoryStore {
  constructor({ filePath = null, retentionDays = DEFAULT_RETENTION_DAYS } = {}) {
    this.filePath = filePath;
    this.retentionDays = Math.max(7, Math.min(365, Number(retentionDays) || DEFAULT_RETENTION_DAYS));
    this.byItem = new Map();
    this.load();
  }

  load() {
    if (!this.filePath) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      for (const [rawId, rows] of Object.entries(data.items || {})) {
        const id = Number(rawId);
        if (!Number.isSafeInteger(id) || !Array.isArray(rows)) continue;
        const clean = rows.filter((row) => Number.isFinite(Number(row.at)) && Number.isFinite(Number(row.fe)) && Number(row.fe) > 0)
          .slice(-MAX_PER_ITEM).map((row) => ({ ...row, at: Number(row.at), fe: Number(row.fe) }));
        if (clean.length) this.byItem.set(id, clean);
      }
    } catch {}
    this.prune();
  }

  save() {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const items = Object.fromEntries([...this.byItem.entries()].map(([id, rows]) => [id, rows]));
      const temp = `${this.filePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, savedAt: Date.now(), items }), 'utf8');
      fs.renameSync(temp, this.filePath);
    } catch {}
  }

  prune(now = Date.now()) {
    const cutoff = now - this.retentionDays * DAY;
    for (const [id, rows] of this.byItem) {
      const keep = rows.filter((row) => row.at >= cutoff).slice(-MAX_PER_ITEM);
      if (keep.length) this.byItem.set(id, keep); else this.byItem.delete(id);
    }
  }

  record(price, { seasonId = null, at = Date.now(), force = false, persist = true } = {}) {
    const id = Number(price?.configBaseId);
    const fe = Number(price?.fe);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(fe) || fe <= 0) return false;
    const rows = this.byItem.get(id) || [];
    const previous = rows.at(-1);
    const sameSeason = previous && Number(previous.seasonId || 0) === Number(seasonId || 0);
    const dayElapsed = !previous || at - previous.at >= DAY;
    const changed = !previous || !sameSeason || Math.abs(fe - previous.fe) / previous.fe >= 0.02;
    if (!force && previous && !dayElapsed && !changed) return false;
    rows.push({ at, fe, source: String(price.source || 'unknown'), seasonId: seasonId ? Number(seasonId) : null,
      samples: Number(price.sampleSize ?? price.submissions ?? 0) || 0,
      devices: Number(price.devices || 0) || 0 });
    this.byItem.set(id, rows.slice(-MAX_PER_ITEM));
    this.prune(at);
    if (persist) this.save();
    return true;
  }

  recordMany(prices, options = {}) {
    let changed = 0;
    for (const price of prices || []) if (this.record(price, { ...options, persist: false })) changed++;
    if (changed) this.save();
    return changed;
  }

  get(itemId, days = 30, now = Date.now(), { seasonId = undefined } = {}) {
    const id = Number(itemId);
    const safeDays = Math.max(1, Math.min(this.retentionDays, Number(days) || 30));
    const cutoff = now - safeDays * DAY;
    const rows = (this.byItem.get(id) || []).filter((row) => row.at >= cutoff &&
      (seasonId === undefined || Number(row.seasonId || 0) === Number(seasonId || 0)));
    const seasons = [...new Set(rows.map((row) => row.seasonId ?? null))];
    if (!rows.length) return { itemId: id, days: safeDays, points: [], minimum: null, maximum: null, latest: null, seasons: [], changePercent: null };
    const values = rows.map((row) => row.fe);
    const latest = rows.at(-1).fe, first = rows[0].fe;
    return { itemId: id, days: safeDays, points: rows,
      minimum: Math.min(...values), maximum: Math.max(...values), latest, seasons,
      changePercent: first > 0 ? (latest - first) / first * 100 : null };
  }


  exportSnapshot() {
    return {
      schemaVersion: 1,
      retentionDays: this.retentionDays,
      exportedAt: Date.now(),
      items: Object.fromEntries([...this.byItem.entries()].map(([id, rows]) => [id, rows.map((row) => ({ ...row }))])),
    };
  }

  importSnapshot(snapshot, { merge = true } = {}) {
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.items || typeof snapshot.items !== 'object' || Array.isArray(snapshot.items)) {
      throw new Error('Некорректный снимок истории цен');
    }
    if (!merge) this.byItem.clear();
    let imported = 0;
    for (const [rawId, values] of Object.entries(snapshot.items)) {
      const id = Number(rawId);
      if (!Number.isSafeInteger(id) || id <= 0 || !Array.isArray(values)) continue;
      const current = this.byItem.get(id) || [];
      const combined = [...current];
      for (const row of values) {
        const at = Number(row?.at), fe = Number(row?.fe);
        if (!Number.isFinite(at) || !Number.isFinite(fe) || fe <= 0) continue;
        const clean = { at, fe, source: String(row.source || 'imported'),
          seasonId: row.seasonId == null ? null : Number(row.seasonId),
          samples: Number(row.samples) || 0, devices: Number(row.devices) || 0 };
        if (!combined.some((old) => old.at === clean.at && old.fe === clean.fe && old.seasonId === clean.seasonId && old.source === clean.source)) {
          combined.push(clean); imported++;
        }
      }
      combined.sort((a, b) => a.at - b.at);
      const kept = combined.slice(-MAX_PER_ITEM);
      if (kept.length) this.byItem.set(id, kept);
    }
    this.prune();
    this.save();
    return imported;
  }

  snapshot() {
    let points = 0;
    for (const rows of this.byItem.values()) points += rows.length;
    return { items: this.byItem.size, points, retentionDays: this.retentionDays };
  }
}
