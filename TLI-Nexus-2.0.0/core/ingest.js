import { MessageAssembler } from './ueLog.js';
import { extractEvents } from './lootEvents.js';

/** Groups persistent imports by idle gap. Live overlay uses event callbacks and no database. */
export class SessionTracker {
  constructor(store, { idleGapMs = 10 * 60_000 } = {}) {
    this.store = store; this.idleGapMs = idleGapMs; this.area = null; this.player = null;
    const last = store.get('SELECT id,last_ts,player FROM sessions ORDER BY id DESC LIMIT 1');
    this.sessionId = null; this.lastTs = null;
    if (last) { this.sessionId = last.id; this.lastTs = last.last_ts; this.player = last.player; }
  }
  assign(e) {
    if (e.type === 'area' && e.area) this.area = e.area;
    if (e.type === 'player' && e.playerName) this.player = e.playerName;
    if (e.type !== 'pick' && e.type !== 'area') return this.sessionId;
    const ts = e.ts ?? this.lastTs ?? Date.now();
    if (this.sessionId === null || (this.lastTs !== null && ts - this.lastTs > this.idleGapMs)) {
      this.sessionId = this.store.newSession(ts, this.player, this.area);
    }
    this.lastTs = Math.max(this.lastTs ?? 0, ts);
    this.store.touchSession(this.sessionId, ts);
    return this.sessionId;
  }
}

/** Text chunks in -> complete protocol messages -> parsed events. */
export class Ingestor {
  constructor(store, opts = {}) {
    this.store = store; this.opts = opts; this.tracker = store ? new SessionTracker(store, opts) : null;
    this.onEvent = opts.onEvent || (() => {});
    this.onMessage = opts.onMessage || (() => {});
    this.counters = { messages: 0, events: 0, inserted: 0, unrecognized: 0, byAction: {} };
    this.asm = new MessageAssembler((message) => this.#onMessage(message));
    this.onEvents = opts.onEvents || (() => {});
  }
  #onMessage(message) {
    this.counters.messages++;
    this.counters.byAction[message.action] = (this.counters.byAction[message.action] || 0) + 1;
    this.onMessage(message); // ETor routes complete protocol messages before interpreting their action.
    const events = extractEvents(message);
    if (!events.length) return;
    this.counters.events += events.length;
    this.counters.unrecognized += events.filter((event) => event.parseStatus === 'unrecognized').length;
    for (const event of events) this.onEvent(event);
    if (!this.store) return;
    const n = this.store.insertEvents(events, {
      source: this.opts.source || 'log',
      sessionIdOf: (event) => this.tracker.assign(event),
      player: this.tracker.player,
    });
    this.counters.inserted += n;
    if (n) this.onEvents(events);
  }
  feed(text) { this.asm.feed(text); }
  finish() { this.asm.flush(); return this.counters; }
}
