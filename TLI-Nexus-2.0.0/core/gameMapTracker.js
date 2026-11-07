const HUB_SEGMENTS = new Set([
  'town', 'city', 'hub', 'stronghold', 'settlement', 'hideout', 'sanctuary',
  'camp', 'lobby', 'safezone', 'safe', 'home', 'mainbase', 'maincity',
  'mainhub', 'village',
]);
const MAX_MAP_HISTORY = 100;

function clean(value, max = 120) {
  return String(value ?? '').replace(/[\u0000\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Game logs report all level transitions through LevelMgr. Paths under Maps
 * include town/hideout hubs as well as Atlas and other instanced areas, so
 * explicitly exclude known social hubs and leave unknown path-less transitions
 * alone rather than inventing a map boundary.
 */
export function classifyGameArea(event = {}) {
  const zone = clean(event.mapZone, 100);
  const asset = clean(event.asset, 120);
  if (!zone && !asset) return 'unknown';
  const tokens = `${zone}/${asset}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => HUB_SEGMENTS.has(token)) ? 'hub' : 'map';
}

function identityFor(event) {
  return [
    clean(event.levelUid, 40),
    clean(event.areaId, 40),
    clean(event.mapZone, 100),
    clean(event.asset, 120),
  ].join(':');
}

function serializeMap(map) {
  if (!map) return null;
  return {
    id: map.id,
    identity: map.identity,
    name: map.name,
    mapZone: map.mapZone,
    asset: map.asset,
    areaId: map.areaId,
    levelUid: map.levelUid,
    levelType: map.levelType,
    startedAt: map.startedAt,
    endedAt: map.endedAt,
    durationSec: map.durationSec,
    completionReason: map.completionReason || null,
    drops: map.drops,
    pickupEvents: map.pickupEvents,
    feGained: map.feGained,
    loot: [...map.lootTotals.entries()].map(([itemId, count]) => ({ itemId, count })),
  };
}

export class GameMapTracker {
  constructor({ maxHistory = MAX_MAP_HISTORY } = {}) {
    this.maxHistory = Math.max(1, Math.min(500, Number(maxHistory) || MAX_MAP_HISTORY));
    this.reset();
  }

  reset() {
    this.currentMap = null;
    this.lastMap = null;
    this.completedMaps = [];
    this.mapSequence = 0;
  }

  enterArea(event, now = Date.now()) {
    const kind = classifyGameArea(event);
    if (kind === 'unknown') return { kind, started: false, completed: null };
    if (kind === 'hub') {
      const completed = this.finishCurrentMap(now, 'hub');
      return { kind, started: false, completed };
    }

    const identity = identityFor(event);
    if (this.currentMap?.identity === identity) {
      return { kind, started: false, duplicate: true, completed: null };
    }

    const completed = this.finishCurrentMap(now, 'next-map');
    const sequence = ++this.mapSequence;
    const name = clean(event.area, 120) || clean(event.asset, 120) ||
      (event.areaId ? `Зона ${event.areaId}` : 'Карта');
    this.currentMap = {
      id: `map-${sequence}-${Number(now) || Date.now()}`,
      identity,
      name,
      mapZone: clean(event.mapZone, 100) || null,
      asset: clean(event.asset, 120) || null,
      areaId: event.areaId ?? null,
      levelUid: event.levelUid ?? null,
      levelType: event.levelType ?? null,
      startedAt: Number(now) || Date.now(),
      endedAt: null,
      durationSec: 0,
      completionReason: null,
      drops: 0,
      pickupEvents: 0,
      feGained: 0,
      lootTotals: new Map(),
    };
    return { kind, started: true, completed };
  }

  addLoot(delta) {
    if (!this.currentMap || !delta || delta.kind !== 'loot' ||
        Number(delta.qty) <= 0 || !Number.isSafeInteger(Number(delta.configBaseId))) return false;
    const itemId = Number(delta.configBaseId);
    const count = Number(delta.qty);
    this.currentMap.drops += count;
    this.currentMap.pickupEvents += 1;
    this.currentMap.lootTotals.set(itemId, (this.currentMap.lootTotals.get(itemId) || 0) + count);
    if (itemId === 100300) this.currentMap.feGained += count;
    return true;
  }

  finishCurrentMap(now = Date.now(), reason = 'left-area') {
    if (!this.currentMap) return null;
    const endedAt = Number(now) || Date.now();
    this.currentMap.endedAt = endedAt;
    this.currentMap.durationSec = Math.max(0, Math.floor((endedAt - this.currentMap.startedAt) / 1000));
    this.currentMap.completionReason = reason;
    const finished = serializeMap(this.currentMap);
    this.lastMap = finished;
    this.completedMaps.push(finished);
    this.completedMaps = this.completedMaps.slice(-this.maxHistory);
    this.currentMap = null;
    return finished;
  }

  snapshot() {
    return {
      current: serializeMap(this.currentMap),
      last: this.lastMap ? { ...this.lastMap, loot: this.lastMap.loot.map((row) => ({ ...row })) } : null,
      completedCount: this.completedMaps.length,
      history: this.completedMaps.map((row) => ({ ...row, loot: row.loot.map((item) => ({ ...item })) })),
    };
  }
}
