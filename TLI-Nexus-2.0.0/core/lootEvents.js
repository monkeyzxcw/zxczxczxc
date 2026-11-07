import { parseTree, parseUeTimestamp } from './ueLog.js';

// Event names and payload keys taken from ETor's tor/main.js. Its parser does not
// validate the shape of PickItem/PickItems: it parses the complete tree and
// forwards it. Nexus keeps that behaviour, then extracts item fields when known.
export const FIELDS = {
  baseId: ['BaseId', 'BaseID', 'ItemBaseId', 'itemBaseId', 'baseId', 'itemId'],
  instanceId: ['Id', 'ItemInstanceId', 'instanceId'],
  count: ['Num', 'Count', 'Amount', 'count', 'num'],
  pageId: ['PageId'],
  dropSource: ['DropSource'],
  rare: ['RareValue'],
  affixNum: ['AffixNum'],
  level: ['Level'],
  mapId: ['mapId', 'MapID', 'MapId'],
  areaId: ['areaId', 'AreaID', 'AreaId'],
  areaKind: ['checkType', 'CheckType'],
  areaInstance: ['AreaUniqueId', 'areaUniqueId'],
  levelId: ['levelId', 'LevelID', 'LevelId'],
  frameId: ['frameId', 'FrameId'],
};
export const PICK_ACTIONS = new Set(['PickItem', 'PickItems']);
export const AREA_ACTIONS = new Set(['EnterArea', 'InputArea', 'Spv3Open', 'Spv3Enter']);
export const SNAPSHOT_ACTIONS = new Set(['ResetItemsLayout', 'GetWareHousePage']);
const INSTANCE_RE = /^(\d+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const scalar = (node, names) => {
  if (!node || typeof node !== 'object') return undefined;
  const want = new Set(names.map((n) => n.toLowerCase()));
  for (const [k, raw] of Object.entries(node)) {
    if (!want.has(k.toLowerCase())) continue;
    // parseTree preserves duplicate leaf keys as arrays; ETor's original parser
    // overwrites them, so selecting the last scalar restores its effective value.
    const v = Array.isArray(raw) ? raw.at(-1) : raw;
    if (typeof v === 'string' || typeof v === 'number') return String(v);
  }
  return undefined;
};
const int = (v) => (v !== undefined && /^-?\d+$/.test(String(v).trim()) ? Number(v) : null);
const isObject = (x) => x !== null && typeof x === 'object';

function collectItemDetails(node, path = [], out = []) {
  if (Array.isArray(node)) { node.forEach((value, index) => collectItemDetails(value, [...path, String(index)], out)); return out; }
  if (!isObject(node)) return out;
  for (const [key, raw] of Object.entries(node)) {
    const value = Array.isArray(raw) ? raw.at(-1) : raw;
    const nextPath = [...path, key];
    if (typeof value === 'string' || typeof value === 'number') {
      if (/(affix|rare|level|quality|baseid|slot|pageid|num|name|type|enhance|stat|value|attr|prefix|suffix)/i.test(key)) {
        out.push({ key, path: nextPath.join('.'), value: String(value).slice(0, 160) });
      }
    } else collectItemDetails(value, nextPath, out);
    if (out.length >= 100) break;
  }
  return out;
}

/** Is this a concrete item node in ETor's parsed tree? */
export function asItem(node) {
  const inst = scalar(node, FIELDS.instanceId);
  const match = inst ? INSTANCE_RE.exec(inst) : null;
  const base = int(scalar(node, FIELDS.baseId)) ?? (match ? Number(match[1]) : null);
  if (base === null) return null;
  const count = int(scalar(node, FIELDS.count));
  return {
    itemId: base,
    itemInstance: match ? inst : null,
    count: count !== null && count > 0 ? count : 1,
    countInferred: count === null || count <= 0,
    dropSource: scalar(node, FIELDS.dropSource) ?? null,
    extra: {
      pageId: scalar(node, FIELDS.pageId),
      rareValue: scalar(node, FIELDS.rare),
      affixNum: scalar(node, FIELDS.affixNum),
      level: scalar(node, FIELDS.level),
      details: collectItemDetails(node).slice(0, 100),
    },
  };
}

/** Find every item node; once an item is found, do not descend into its affixes. */
export function collectItems(tree, path = [], out = []) {
  if (Array.isArray(tree)) { tree.forEach((v, i) => collectItems(v, [...path, String(i)], out)); return out; }
  if (!isObject(tree)) return out;
  const item = asItem(tree);
  if (item) { out.push({ ...item, path: path.join('.') }); return out; }
  for (const [key, value] of Object.entries(tree)) collectItems(value, [...path, key], out);
  return out;
}

export function firstFound(tree, names) {
  if (Array.isArray(tree)) {
    for (const value of tree) { const found = firstFound(value, names); if (found !== undefined) return found; }
    return undefined;
  }
  if (!isObject(tree)) return undefined;
  const direct = scalar(tree, names);
  if (direct !== undefined) return direct;
  for (const value of Object.values(tree)) { const found = firstFound(value, names); if (found !== undefined) return found; }
  return undefined;
}

/** ETor's identity source is GetPlayerData -> player.{PlayerId,SeasonId,...}. */
export function playerIdentity(tree) {
  const p = tree?.player || tree?.Player;
  if (!p || !p.PlayerId || !p.SeasonId) return null;
  return { name: p.Name || null, playerId: p.PlayerId, seasonId: p.SeasonId,
    heroId: p.HeroId || null, level: int(p.Level ?? p.PlayerLevel) };
}

function baseEvent(msg) {
  return { time: msg.time, ts: parseUeTimestamp(msg.time), action: msg.action, synId: msg.synId, kind: msg.kind, truncated: msg.truncated };
}
function areaFields(tree) {
  const mapId = firstFound(tree, FIELDS.mapId) ?? null;
  const areaId = firstFound(tree, FIELDS.areaId) ?? null;
  const levelId = firstFound(tree, FIELDS.levelId) ?? null;
  const checkType = firstFound(tree, FIELDS.areaKind) ?? null;
  const areaInstance = firstFound(tree, FIELDS.areaInstance) ?? null;
  const label = mapId || areaId || levelId || null;
  return { mapId, areaId, levelId, checkType, areaKind: checkType, areaInstance, extra: { areaInstance }, label };
}

function extractPick(msg, tree, base, raw) {
  // The server push/response is the confirmation. Client SendMessage requests are
  // retained in message diagnostics but are not counted as successful pickups.
  if (/^SendMessage$/i.test(msg.kind)) return [];
  const items = collectItems(tree);
  if (items.length) return items.map((item, index) => ({ ...base, type: 'pick', ...item,
    parseStatus: 'ok', raw, ordinal: index }));

  // Some builds send a compact payload (itemBaseId + Num) instead of an Item node.
  const compactId = int(firstFound(tree, FIELDS.baseId));
  if (compactId !== null) {
    const count = int(firstFound(tree, FIELDS.count));
    return [{ ...base, type: 'pick', itemId: compactId, itemInstance: null,
      count: count !== null && count > 0 ? count : 1, countInferred: count === null || count <= 0,
      dropSource: firstFound(tree, FIELDS.dropSource) ?? null,
      extra: { pageId: firstFound(tree, FIELDS.pageId) ?? null, rareValue: firstFound(tree, FIELDS.rare) ?? null,
        affixNum: firstFound(tree, FIELDS.affixNum) ?? null, level: firstFound(tree, FIELDS.level) ?? null },
      path: '(compact payload)', parseStatus: 'partial', raw, ordinal: 0 }];
  }

  // Do not discard ETor-recognised PickItem/PickItems messages merely because a
  // current game build changed the item's fields. Show the pickup event and keep
  // the raw body for diagnostics / later schema support.
  return [{ ...base, type: 'pick', itemId: null, itemInstance: null, count: null,
    countInferred: true, path: '', parseStatus: 'unrecognized', raw, tree, ordinal: 0 }];
}

/** Complete UE socket message -> domain events. Uses ETor action names and tree parser. */
export function extractEvents(msg) {
  const base = baseEvent(msg);
  const raw = msg.body.join('\n').slice(0, 16_384);
  const tree = parseTree(msg.body);

  if (PICK_ACTIONS.has(msg.action)) return extractPick(msg, tree, base, raw);

  if (msg.action === 'EnterArea') {
    // RecvMessage is the authoritative response in ETor's sample. Accept server
    // push variants too: protocol kind varies by game build.
    if (/^SendMessage$/i.test(msg.kind)) return [];
    const info = areaFields(tree);
    return [{ ...base, type: 'area', ...info, area: info.label, phase: 'entered',
      parseStatus: info.label ? 'ok' : 'unrecognized', raw, ordinal: 0 }];
  }

  if (msg.action === 'Spv3Open') {
    // ETor documents the outgoing map-open request: MapID, levelId, areaId.
    const info = areaFields(tree);
    if (!info.label) return [{ ...base, type: 'areaRequest', ...info, area: null,
      phase: /^Recv/i.test(msg.kind) ? 'open-response' : 'open-request', parseStatus: 'unrecognized', raw, ordinal: 0 }];
    return [{ ...base, type: 'areaRequest', ...info, area: info.label,
      phase: /^Recv/i.test(msg.kind) ? 'open-response' : 'open-request', parseStatus: 'ok', raw, ordinal: 0 }];
  }

  if (msg.action === 'Spv3Enter' && !/^SendMessage$/i.test(msg.kind)) {
    const info = areaFields(tree);
    return [{ ...base, type: 'areaTransition', ...info, area: info.label,
      phase: 'enter-confirmed', parseStatus: info.label ? 'ok' : 'partial', raw, ordinal: 0 }];
  }

  if (msg.action === 'InputArea') {
    // ETor specifically inspects InputArea when frameId < 3 as an in-area signal.
    const frameId = int(firstFound(tree, FIELDS.frameId));
    if (frameId !== null && frameId >= 0 && frameId < 3) {
      return [{ ...base, type: 'areaSignal', frameId,
        commands: collectCommandTypes(tree), raw, parseStatus: 'ok', ordinal: 0 }];
    }
    return [];
  }

  if (SNAPSHOT_ACTIONS.has(msg.action)) {
    const items = collectItems(tree);
    return [{ ...base, type: 'snapshot', snapshotKind: msg.action, itemCount: items.length,
      items: items.slice(0, 500), parseStatus: 'ok', raw: raw.slice(0, 512), ordinal: 0 }];
  }

  if (msg.action === 'GetPlayerData' && /^RecvMessage$/i.test(msg.kind)) {
    const identity = playerIdentity(tree);
    return [{ ...base, type: 'player', playerName: identity?.name ?? null,
      extra: identity, parseStatus: identity ? 'ok' : 'unrecognized', raw: '', ordinal: 0 }];
  }
  return [];
}

function collectCommandTypes(tree) {
  const out = [];
  const visit = (value) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key.toLowerCase() === 'type' && typeof child === 'string' && /^ECmd_/i.test(child)) out.push(child);
      else visit(child);
    }
  };
  visit(tree);
  return [...new Set(out)];
}
