import { getItemInfo, getItemName } from './itemCatalog.js';

const EQUIP_ON_PROTO = /^PutOn$/i;
const EQUIP_OFF_PROTO = /^PutOff$/i;
const nowOr = (value) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : Date.now();

/**
 * Tracks only equipment transitions that are explicitly visible as BagMgr
 * inventory deltas inside PutOn / PutOff transactions. It deliberately does
 * not invent equipment slots, item affixes, rolls, quality, or initial gear.
 */
export class EquipmentTracker {
  constructor(seed = null) {
    this.items = new Map();
    for (const row of Array.isArray(seed?.items) ? seed.items : []) {
      const itemId = Number(row.itemId);
      const count = Math.max(0, Math.floor(Number(row.count) || 0));
      if (!Number.isSafeInteger(itemId) || itemId <= 0 || count <= 0) continue;
      const info = getItemInfo(itemId);
      this.items.set(itemId, {
        itemId,
        name: String(row.name || getItemName(itemId)),
        itemType: String(row.itemType || info?.typeRu || info?.type || 'Тип неизвестен'),
        iconUrl: info?.iconUrl || row.iconUrl || null,
        count,
        lastEquippedAt: nowOr(row.lastEquippedAt),
        source: 'PutOn / PutOff · BagMgr',
      });
    }
    this.stats = {
      putOnTransactions: Math.max(0, Number(seed?.stats?.putOnTransactions) || 0),
      putOffTransactions: Math.max(0, Number(seed?.stats?.putOffTransactions) || 0),
      unmatchedPutOff: Math.max(0, Number(seed?.stats?.unmatchedPutOff) || 0),
      ignoredDeltas: Math.max(0, Number(seed?.stats?.ignoredDeltas) || 0),
    };
    this.transitions = Array.isArray(seed?.transitions) ? seed.transitions.slice(-30) : [];
    this.lastTransition = seed?.lastTransition || null;
  }

  applyInventoryDelta(delta, event = {}) {
    if (!delta || !Number.isSafeInteger(Number(delta.configBaseId)) || Number(delta.configBaseId) <= 0) return null;
    const proto = String(delta.proto || '');
    const itemId = Number(delta.configBaseId);
    const amount = Math.abs(Math.floor(Number(delta.qty) || 0));
    if (amount <= 0) return null;

    let action = null;
    if (EQUIP_ON_PROTO.test(proto) && Number(delta.qty) < 0) action = 'put-on';
    else if (EQUIP_OFF_PROTO.test(proto) && Number(delta.qty) > 0) action = 'put-off';
    else if (EQUIP_ON_PROTO.test(proto) || EQUIP_OFF_PROTO.test(proto)) this.stats.ignoredDeltas++;
    if (!action) return null;

    const at = nowOr(event.ts);
    const previous = this.items.get(itemId);
    const info = getItemInfo(itemId);
    if (action === 'put-on') {
      this.stats.putOnTransactions++;
      this.items.set(itemId, {
        itemId,
        name: getItemName(itemId),
        itemType: info?.typeRu || info?.type || 'Тип неизвестен',
        iconUrl: info?.iconUrl || null,
        count: (previous?.count || 0) + amount,
        lastEquippedAt: at,
        source: 'PutOn / PutOff · BagMgr',
        lastInventoryPageId: Number(delta.pageId) || null,
        lastInventorySlotId: Number(delta.slotId) || null,
      });
    } else {
      this.stats.putOffTransactions++;
      if (!previous || previous.count < amount) {
        this.stats.unmatchedPutOff++;
        if (previous) this.items.delete(itemId);
      } else if (previous.count === amount) this.items.delete(itemId);
      else this.items.set(itemId, { ...previous, count: previous.count - amount });
    }

    const transition = {
      action,
      itemId,
      name: getItemName(itemId),
      quantity: amount,
      at,
      pageId: Number(delta.pageId) || null,
      slotId: Number(delta.slotId) || null,
      transaction: proto,
      evidence: String(event.raw || event.body || '').slice(0, 700),
    };
    this.lastTransition = transition;
    this.transitions.push(transition);
    this.transitions = this.transitions.slice(-30);
    return transition;
  }

  exportState() {
    return {
      items: [...this.items.values()].map((row) => ({ ...row })),
      stats: { ...this.stats },
      transitions: this.transitions.map((row) => ({ ...row })),
      lastTransition: this.lastTransition ? { ...this.lastTransition } : null,
    };
  }

  snapshot() {
    const rows = [...this.items.values()].map((row) => ({ ...row }));
    return {
      items: rows,
      itemTypes: rows.length,
      totalItems: rows.reduce((sum, row) => sum + row.count, 0),
      stats: { ...this.stats },
      transitions: this.transitions.slice(-12).map((row) => ({ ...row })),
      lastTransition: this.lastTransition ? { ...this.lastTransition } : null,
      completeness: 'partial',
      completenessLabel: 'Частичный снимок',
      slotMapping: 'not-available',
      source: 'BagMgr inventory delta inside PutOn / PutOff',
      limitations: [
        'Считываются только изменения, попавшие в лог после начала наблюдения.',
        'Игра не раскрыла подтверждённое соответствие ConfigBaseId конкретному слоту экипировки.',
        'Аффиксы, значения роллов, качество и уровень предмета этим событием не подтверждаются.',
      ],
    };
  }
}
