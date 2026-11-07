import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, dedup TEXT UNIQUE NOT NULL,
  ts INTEGER, time TEXT, type TEXT NOT NULL, action TEXT, syn_id TEXT, ordinal INTEGER DEFAULT 0,
  item_id INTEGER, count INTEGER, count_inferred INTEGER, area TEXT, player TEXT,
  path TEXT, parse_status TEXT, truncated INTEGER DEFAULT 0, raw TEXT, session_id INTEGER, source TEXT,
  area_kind TEXT, item_instance TEXT, drop_source TEXT, extra TEXT);
CREATE INDEX IF NOT EXISTS ix_ev_item ON events(item_id);
CREATE INDEX IF NOT EXISTS ix_ev_ts ON events(ts);
CREATE INDEX IF NOT EXISTS ix_ev_sess ON events(session_id);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY, started_ts INTEGER, last_ts INTEGER, player TEXT, first_area TEXT, note TEXT, costs REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, name TEXT, rarity TEXT, category TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS prices(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, price REAL NOT NULL, currency TEXT NOT NULL, ts INTEGER NOT NULL, source TEXT);
CREATE INDEX IF NOT EXISTS ix_pr_item ON prices(item_id, ts);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
`;

export class Store {
  constructor(file = ':memory:') { this.db = new DatabaseSync(file); this.db.exec(SCHEMA); }
  close() { this.db.close(); }
  kvGet(k) { const r = this.db.prepare('SELECT v FROM kv WHERE k=?').get(k); return r ? JSON.parse(r.v) : null; }
  kvSet(k, v) { this.db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v)); }

  /** Insert events; duplicates (re-imports, overlapping tails) are ignored. Returns number actually inserted. */
  insertEvents(events, { source = 'log', sessionIdOf = () => null, player = null } = {}) {
    const st = this.db.prepare(`INSERT OR IGNORE INTO events
      (dedup,ts,time,type,action,syn_id,ordinal,item_id,count,count_inferred,area,player,path,parse_status,truncated,raw,session_id,source,area_kind,item_instance,drop_source,extra)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    let n = 0;
    this.db.exec('BEGIN');
    try {
      for (const e of events) {
        const dedup = crypto.createHash('sha1').update([e.time, e.action, e.synId, e.ordinal, e.raw].join('\u0001')).digest('hex');
        const r = st.run(dedup, e.ts ?? null, e.time, e.type, e.action, e.synId ?? null, e.ordinal ?? 0, e.itemId ?? null, e.count ?? null,
          e.countInferred ? 1 : 0, e.area ?? null, e.playerName ?? player, e.path ?? null, e.parseStatus, e.truncated ? 1 : 0, e.raw ?? null, sessionIdOf(e), source,
          e.areaKind ?? null, e.itemInstance ?? null, e.dropSource ?? null, e.extra ? JSON.stringify(e.extra) : null);
        n += Number(r.changes);
      }
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
    return n;
  }
  upsertItems(map, source = 'import') {
    const st = this.db.prepare('INSERT INTO items(id,name,source) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, source=excluded.source');
    this.db.exec('BEGIN'); for (const [id, name] of Object.entries(map)) st.run(Number(id), name, source); this.db.exec('COMMIT');
  }
  addPrice(itemId, price, currency, ts = Date.now(), source = 'manual') {
    this.db.prepare('INSERT INTO prices(item_id,price,currency,ts,source) VALUES(?,?,?,?,?)').run(itemId, price, currency, ts, source);
  }
  newSession(startedTs, player, firstArea) {
    return Number(this.db.prepare('INSERT INTO sessions(started_ts,last_ts,player,first_area) VALUES(?,?,?,?)').run(startedTs, startedTs, player, firstArea).lastInsertRowid);
  }
  touchSession(id, ts) { this.db.prepare('UPDATE sessions SET last_ts=MAX(COALESCE(last_ts,0),?) WHERE id=?').run(ts, id); }
  all(sql, ...p) { return this.db.prepare(sql).all(...p); }
  get(sql, ...p) { return this.db.prepare(sql).get(...p); }
}

/** parse "id<TAB or spaces>name" lines (itemId.txt-like). Lines that do not match are counted, not guessed. */
export function parseItemMap(text) {
  const map = {}; let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s*[\t,=:]?\s*(.+?)\s*$/.exec(line);
    if (m) map[m[1]] = m[2]; else skipped++;
  }
  return { map, skipped };
}
