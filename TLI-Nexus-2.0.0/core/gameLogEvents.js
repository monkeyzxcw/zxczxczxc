import { parseUeTimestamp } from './ueLog.js';
import { EquipmentTracker } from './equipmentTracker.js';

// Port of the proven line-level inventory/map approach used by Gorn 0.6.0.
// Unlike PickItem Socket payloads, these events are ordinary UE [Game] log lines.
const GAME_BODY_RE = /(?:^|\])\s*[\w.]+:\s*Display:\s*\[Game\]\s*(.*)$/;
const TIMESTAMP_RE = /^\[(\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\]/;
const ITEM_CHANGE_RE = /ItemChange@\s*ProtoName=(\w+)\s+(start|end)\b/i;
const ITEM_ADD_RE = /ItemChange@\s*Add\s+Id=(\d+)_([0-9a-fA-F-]+)\s+BagNum=(\d+)\s+in\s+PageId=(\d+)\s+SlotId=(\d+)/i;
const BAG_MODIFY_RE = /BagMgr@:(?:Modfy|Modify)\s+BagItem\s+PageId\s*=\s*(\d+)\s+SlotId\s*=\s*(\d+)\s+ConfigBaseId\s*=\s*(\d+)\s+Num\s*=\s*(\d+)/i;
const BAG_INIT_RE = /BagMgr@:InitBagData\s+PageId\s*=\s*(\d+)\s+SlotId\s*=\s*(\d+)\s+ConfigBaseId\s*=\s*(\d+)\s+Num\s*=\s*(\d+)/i;
const BAG_REMOVE_RE = /BagMgr@:RemoveBagItem\s+PageId\s*=\s*(\d+)\s+SlotId\s*=\s*(\d+)/i;
const ENTER_LEVEL_RE = /LevelMgr:_EnterLevelSuccess\(\)\s*(\d+)/i;
const LEVEL_PATH_RE = /LevelMgr@:LevelPath,\s*Model\s*=\s*Content\/Art\/Maps\/[^/]+\/([^/]+)\//i;
const LEVEL_IDS_RE = /LevelMgr@\s+LevelUid,\s*LevelType,\s*LevelId\s*=\s*(\d+)\s+(\d+)\s+(\d+)/i;
const PLAYER_LOGIN_RE = /PlayerIdTrace@SelectRoleNetMgr:_UserLoginStep3\s+buildLoginParm\s+playerId=(\d+)/i;

export const FE_ID = 100300;
export const FE_NAME_RU = 'Элементиевое пламя';

const PROTO_KIND = Object.freeze({
  PickItem: 'loot', PickItems: 'loot', PutOn: 'equipmentOn',
  Spv3Open: 'mapCost', ClimbTowerOpen: 'mapCost',
  XchgForSale: 'trade', XchgBuy: 'trade', XchgReceive: 'trade', XchgRecall: 'trade',
  BuyVendorGoods: 'neutral', RefreshVendorShop: 'neutral', Push2: 'neutral',
  PutOff: 'equipmentOff', BuySkill: 'neutral', LockOrUnlockItem: 'neutral', Evaluate: 'neutral',
  EvaluateOneKey: 'neutral', ExchangeItem: 'neutral', MoveWareHouseItems2: 'neutral',
  MoveWareHouseItems: 'neutral', ResetItemsLayout: 'neutral', WashGeniusAllPoint: 'neutral',
});

export function gameMapName(asset, areaId = null) {
  if (!asset) return areaId ? `Зона ${areaId}` : null;
  const cleaned = String(asset).replace(/^[A-Z]{2,4}_/, '').replace(/\d+$/, '').replace(/[_\s-]+$/, '');
  return cleaned || (areaId ? `Зона ${areaId}` : null);
}

const slotKey = (pageId, slotId) => `${pageId}:${slotId}`;
const n = (value) => Number.isSafeInteger(Number(value)) ? Number(value) : null;

/**
 * Stateful UE GameLog parser. It reconstructs bag slots from InitBagData and
 * detects loot from the positive inventory delta inside ItemChange/PickItem.
 */
export class GameLogParser {
  constructor(seed = null) {
    this.slots = new Map(seed?.slots || []);
    this.currentProto = seed?.currentProto ?? null;
    this.pendingAsset = seed?.pendingAsset ?? null;
    this.pendingLevelType = seed?.pendingLevelType ?? null;
    this.currentArea = seed?.currentArea ?? null;
    this.seasonId = seed?.seasonId ?? null;
    this.equipmentTracker = new EquipmentTracker(seed?.equipment ?? null);
    this.stats = {
      gameLines: 0, recognized: 0, itemChanges: 0, bagInit: 0, bagAdd: 0,
      bagModify: 0, bagRemove: 0, positiveDeltas: 0, lootDeltas: 0,
      slotRebases: 0, unseededModifies: 0, areaEvents: 0, equipmentPutOn: 0, equipmentPutOff: 0,
    };
    this.lastEvent = null;
  }

  parseLine(raw) {
    const bodyMatch = GAME_BODY_RE.exec(String(raw || ''));
    if (!bodyMatch) return null;
    const body = bodyMatch[1].trim();
    if (!body) return null;
    this.stats.gameLines++;
    const time = TIMESTAMP_RE.exec(raw)?.[1] ?? '';
    const ts = time ? parseUeTimestamp(time) : null;
    const base = { time, ts, raw: String(raw).slice(0, 1400), body };
    let m;

    // SeasonId is emitted in GetPlayerData and some ordinary GameLog lines.
    // It scopes community price data so a prior season's market is never used.
    if ((m = /\+SeasonId\s+\[(\d+)\]/i.exec(body))) {
      this.seasonId = Number(m[1]);
      return this.#remember({ type: 'season', seasonId: this.seasonId, ...base });
    }

    if ((m = ITEM_CHANGE_RE.exec(body))) {
      this.stats.itemChanges++;
      const proto = m[1];
      const phase = m[2].toLowerCase();
      if (phase === 'start') this.currentProto = proto;
      else this.currentProto = null;
      return this.#remember({ type: 'itemChange', proto, phase, ...base });
    }

    if ((m = BAG_INIT_RE.exec(body))) {
      const ev = { pageId: +m[1], slotId: +m[2], configBaseId: +m[3], qty: +m[4] };
      this.slots.set(slotKey(ev.pageId, ev.slotId), { configBaseId: ev.configBaseId, qty: ev.qty });
      this.stats.bagInit++;
      return this.#remember({ type: 'bagInit', ...ev, ...base });
    }

    if ((m = ITEM_ADD_RE.exec(body))) {
      const ev = { configBaseId: +m[1], bagNum: +m[3], pageId: +m[4], slotId: +m[5] };
      const key = slotKey(ev.pageId, ev.slotId);
      const previous = this.slots.get(key);
      if (!previous || previous.configBaseId !== ev.configBaseId) {
        // A new item placed into an empty/untracked slot starts at zero so the
        // following BagMgr Modify line can report the full positive delta.
        this.slots.set(key, { configBaseId: ev.configBaseId, qty: 0 });
      }
      this.stats.bagAdd++;
      return this.#remember({ type: 'bagAdd', ...ev, ...base });
    }

    if ((m = BAG_REMOVE_RE.exec(body))) {
      this.stats.bagRemove++;
      const pageId = +m[1], slotId = +m[2];
      const previous = this.slots.get(slotKey(pageId, slotId));
      this.slots.set(slotKey(pageId, slotId), { configBaseId: null, qty: 0 });
      if (!previous || previous.configBaseId === null || previous.qty <= 0) {
        return this.#remember({ type: 'bagRemove', pageId, slotId, delta: null, ...base });
      }
      const delta = { configBaseId: previous.configBaseId, qty: -previous.qty,
        proto: this.currentProto || 'unknown', kind: PROTO_KIND[this.currentProto] || 'unknown', pageId, slotId };
      return this.#remember({ type: 'bagDelta', delta, ...base });
    }

    if ((m = BAG_MODIFY_RE.exec(body))) {
      this.stats.bagModify++;
      const ev = { pageId: +m[1], slotId: +m[2], configBaseId: +m[3], qty: +m[4] };
      const key = slotKey(ev.pageId, ev.slotId);
      const previous = this.slots.get(key);
      this.slots.set(key, { configBaseId: ev.configBaseId, qty: ev.qty });
      if (!previous) {
        this.stats.unseededModifies++;
        return this.#remember({ type: 'bagModify', delta: null, reason: 'slot-not-seeded', ...ev, ...base });
      }
      let deltaQty = null;
      if (previous.configBaseId === null) deltaQty = ev.qty;
      else if (previous.configBaseId === ev.configBaseId) deltaQty = ev.qty - previous.qty;
      if (deltaQty === null) {
        this.stats.slotRebases++;
        return this.#remember({ type: 'bagModify', delta: null, reason: 'slot-rebased', ...ev, ...base });
      }
      if (deltaQty === 0) return this.#remember({ type: 'bagModify', delta: null, ...ev, ...base });
      const proto = this.currentProto || 'unknown';
      const delta = { configBaseId: ev.configBaseId, qty: deltaQty, proto,
        kind: PROTO_KIND[proto] || 'unknown', pageId: ev.pageId, slotId: ev.slotId };
      if (deltaQty > 0) this.stats.positiveDeltas++;
      if (delta.kind === 'loot' && deltaQty > 0) this.stats.lootDeltas++;
      return this.#remember({ type: 'bagDelta', delta, ...base });
    }

    if ((m = LEVEL_PATH_RE.exec(body))) {
      this.pendingAsset = m[1];
      this.stats.areaEvents++;
      return this.#remember({ type: 'levelPath', asset: m[1], ...base });
    }
    if ((m = LEVEL_IDS_RE.exec(body))) {
      this.pendingLevelType = +m[2];
      this.stats.areaEvents++;
      return this.#remember({ type: 'levelIds', levelUid: +m[1], levelType: +m[2], levelId: +m[3], ...base });
    }
    if ((m = ENTER_LEVEL_RE.exec(body))) {
      const areaId = +m[1];
      const area = gameMapName(this.pendingAsset, areaId);
      this.currentArea = { areaId, asset: this.pendingAsset, levelType: this.pendingLevelType, name: area };
      this.pendingAsset = null;
      this.pendingLevelType = null;
      this.stats.areaEvents++;
      return this.#remember({ type: 'areaEnter', areaId, asset: this.currentArea.asset,
        levelType: this.currentArea.levelType, area, ...base });
    }
    if ((m = PLAYER_LOGIN_RE.exec(body))) {
      return this.#remember({ type: 'playerLogin', playerId: m[1], ...base });
    }
    return null;
  }

  #remember(event) {
    if (event.type === 'bagDelta' && event.delta) {
      event.equipmentTransition = this.equipmentTracker.applyInventoryDelta(event.delta, event);
      if (event.equipmentTransition?.action === 'put-on') this.stats.equipmentPutOn++;
      if (event.equipmentTransition?.action === 'put-off') this.stats.equipmentPutOff++;
    }
    this.stats.recognized++;
    this.lastEvent = { type: event.type, time: event.time, body: event.body, raw: event.raw,
      proto: event.proto ?? event.delta?.proto ?? this.currentProto ?? null,
      delta: event.delta ? { ...event.delta } : null,
      area: event.area ?? null };
    return event;
  }

  exportState() {
    return { slots: [...this.slots.entries()].map(([key, slot]) => [key, { ...slot }]),
      currentProto: this.currentProto, pendingAsset: this.pendingAsset,
      pendingLevelType: this.pendingLevelType, currentArea: this.currentArea ? { ...this.currentArea } : null, seasonId: this.seasonId,
      equipment: this.equipmentTracker.exportState() };
  }

  snapshot() {
    return { ...this.stats, slots: this.slots.size, currentProto: this.currentProto,
      currentArea: this.currentArea ? { ...this.currentArea } : null, seasonId: this.seasonId,
      equipment: this.equipmentTracker.snapshot(), lastEvent: this.lastEvent ? { ...this.lastEvent } : null };
  }
}
