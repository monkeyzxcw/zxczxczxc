import { parseTree, parseUeTimestamp } from './ueLog.js';
import { collectItems, playerIdentity } from './lootEvents.js';
import { getItemName, getItemInfo } from './itemCatalog.js';
import { extractItemAffixEvidence, extractItemMetadata } from './itemObservation.js';

const normalizeKey = (key) => String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const SKILL_ID_KEYS = new Set(['skillid', 'skillbaseid', 'skillconfigid', 'activeskillid', 'supportskillid', 'skilluid']);
const TALENT_ID_KEYS = new Set(['talentid', 'talentbaseid', 'talentnodeid', 'talentpointid', 'talentconfigid', 'talentnodeconfigid']);
const EQUIPMENT_CONTEXT = /(^|\.)(equipment|equipments|equippeditems|wornitems|wornslots|wear|wearitems|equiplist)(\.|$)/i;
const EQUIPMENT_ID_KEYS = ['ItemBaseId','ItemId','ItemID','EquipmentId','EquipmentBaseId','ConfigBaseId','BaseId'];
const EQUIPMENT_SLOT_KEYS = ['EquipSlot','EquipmentSlot','WearSlot','SlotName','PartName','PositionName'];
const AFFIX_ID_KEYS = new Set(['affixid','baseaffixid','affixconfigid','affixbaseid']);
const toNumber = (value) => value !== undefined && value !== null && /^-?\d+(?:\.\d+)?$/.test(String(value).trim()) ? Number(value) : null;
const capText = (value, max = 160) => String(value ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);

const direct = (node, names) => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
  const wanted = new Set(names.map(normalizeKey));
  for (const [key, raw] of Object.entries(node)) {
    if (!wanted.has(normalizeKey(key))) continue;
    const value = Array.isArray(raw) ? raw.at(-1) : raw;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return undefined;
};

const findObject = (node, names) => {
  const wanted = new Set(names.map(normalizeKey));
  if (!node || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node)) {
    if (wanted.has(normalizeKey(key))) {
      const candidate = Array.isArray(value) ? value.at(-1) : value;
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) return candidate;
    }
  }
  return null;
};

// Keys are intentionally explicit. Unknown fields are listed in fieldSchema,
// but are not silently converted into stats with guessed meanings.
const STAT_FIELDS = new Map([
  ['MaxLife', 'life'], ['LifeMax', 'life'], ['MaxHp', 'life'], ['HPMax', 'life'], ['MaxHP', 'life'], ['MaxHealth', 'life'], ['HealthMax', 'life'],
  ['MaxEnergyShield', 'energyShield'], ['EnergyShieldMax', 'energyShield'], ['MaxES', 'energyShield'], ['MaxShield', 'energyShield'],
  ['MaxMana', 'mana'], ['ManaMax', 'mana'],
  ['Armor', 'armor'], ['Armour', 'armor'], ['Evasion', 'evasion'],
  ['PhysicalDamage', 'physicalDamage'], ['FireDamage', 'fireDamage'], ['ColdDamage', 'coldDamage'],
  ['LightningDamage', 'lightningDamage'], ['ErosionDamage', 'erosionDamage'],
  ['FireResistance', 'fireRes'], ['FireResist', 'fireRes'], ['FireRes', 'fireRes'],
  ['ColdResistance', 'coldRes'], ['ColdResist', 'coldRes'], ['ColdRes', 'coldRes'],
  ['LightningResistance', 'lightningRes'], ['LightningResist', 'lightningRes'], ['LightningRes', 'lightningRes'],
  ['ErosionResistance', 'erosionRes'], ['ErosionResist', 'erosionRes'], ['ErosionRes', 'erosionRes'],
  ['CritChance', 'critChance'], ['CriticalStrikeChance', 'critChance'],
  ['CritDamage', 'critMultiplier'], ['CritMultiplier', 'critMultiplier'], ['CriticalStrikeMultiplier', 'critMultiplier'],
  ['AttackSpeed', 'attackSpeed'], ['CastSpeed', 'castSpeed'], ['MoveSpeed', 'moveSpeed'],
  ['Penetration', 'penetration'], ['FirePenetration', 'firePenetration'], ['ColdPenetration', 'coldPenetration'],
  ['LightningPenetration', 'lightningPenetration'], ['ErosionPenetration', 'erosionPenetration'],
  ['TotalDamageConversionPercent', 'conversionPercent'], ['DamageConversionPercent', 'conversionPercent'],
]);
const STAT_KEY_MAP = new Map([...STAT_FIELDS.entries()].map(([raw, canonical]) => [normalizeKey(raw), canonical]));
const INTERESTING_KEY = /(skill|talent|hero|equip|affix|stat|attribute|life|mana|resist|crit|damage|armor|armour|evasion|attack|cast|penetrat|level|special|player|item|baseid|quality|rare|enhance)/i;

function walk(node, path = [], visit = () => {}) {
  if (Array.isArray(node)) { node.forEach((value, index) => walk(value, [...path, String(index)], visit)); return; }
  if (!node || typeof node !== 'object') return;
  visit(node, path);
  for (const [key, value] of Object.entries(node)) walk(value, [...path, key], visit);
}

function scalarEntries(node) {
  const out = [];
  walk(node, [], (current, currentPath) => {
    for (const [key, raw] of Object.entries(current)) {
      const value = Array.isArray(raw) ? raw.at(-1) : raw;
      if (typeof value === 'string' || typeof value === 'number') out.push({ key, value: String(value), path: [...currentPath, key].join('.') });
    }
  });
  return out;
}

function identityFromTree(tree) {
  const player = findObject(tree, ['player']) || tree?.player || tree?.Player || null;
  if (!player) return null;
  const base = playerIdentity(tree) || {};
  const playerId = direct(player, ['PlayerId', 'PlayerID', 'Id']) ?? base.playerId;
  const seasonId = direct(player, ['SeasonId', 'SeasonID']) ?? base.seasonId;
  if (!playerId || !seasonId) return null;
  return {
    playerId: capText(playerId, 80), name: capText(direct(player, ['Name', 'PlayerName']) ?? base.name, 100),
    seasonId: toNumber(seasonId), heroId: capText(direct(player, ['HeroId', 'HeroID', 'HeroBaseId']) ?? base.heroId, 80) || null,
    heroName: capText(direct(player, ['HeroName', 'HeroDisplayName']), 100) || null,
    level: toNumber(direct(player, ['Level', 'PlayerLevel', 'HeroLevel']) ?? base.level),
    specializationId: capText(direct(player, ['SpecializationId', 'HeroTraitId', 'HeroSpecializationId', 'TraitId']), 80) || null,
    specializationName: capText(direct(player, ['SpecializationName', 'HeroTraitName', 'TraitName']), 100) || null,
    serverId: capText(direct(player, ['ServerId', 'ServerID', 'RegionId']), 80) || null,
  };
}

function extractNodeRows(tree, idKeys, type, messageMeta) {
  const rows = new Map();
  walk(tree, [], (node, nodePath) => {
    const idKey = Object.keys(node).find((key) => idKeys.has(normalizeKey(key)));
    if (!idKey) return;
    const rawId = direct(node, [idKey]);
    if (!rawId || rawId.length > 100) return;
    const id = capText(rawId, 100);
    const levelKey = Object.keys(node).find((key) => ['skilllevel', 'talentlevel', 'nodelevel', 'level', 'lv'].includes(normalizeKey(key))) || null;
    const level = levelKey ? toNumber(direct(node, [levelKey])) : null;
    const slot = direct(node, ['SkillSlot', 'SkillPosition', 'SlotIndex', 'TalentSlot']);
    const name = direct(node, ['SkillName', 'TalentName', 'TalentTitle', 'NodeName', 'SkillTitle', 'Name', 'DisplayName']);
    const nameKey = direct(node, ['TalentNameKey', 'SkillNameKey', 'NodeNameKey', 'NameKey', 'TextKey', 'LocKey', 'TitleKey']);
    const descriptionKey = direct(node, ['TalentDescriptionKey', 'DescriptionKey', 'DescKey', 'EffectTextKey']);
    const key = `${type}:${id}:${slot ?? ''}`;
    rows.set(key, {
      id, idField: capText(idKey, 80), name: name ? capText(name, 100) : null,
      nameKey: nameKey ? capText(nameKey, 240) : null, descriptionKey: descriptionKey ? capText(descriptionKey, 240) : null,
      level, levelField: levelKey ? capText(levelKey, 80) : null, slot: slot ? capText(slot, 40) : null,
      kind: type, sourceAction: messageMeta.action, sourceKind: messageMeta.kind,
      observedAt: messageMeta.at, path: [...nodePath, idKey].join('.'), confidence: 'explicit-id',
    });
  });
  return [...rows.values()];
}

function extractStats(tree, messageMeta) {
  const values = new Map();
  const isPlayerSnapshot = /^GetPlayerData$/i.test(messageMeta.action || '');
  const statContext = /(^|\.)(player|character|charactervalue|stats|derivedstats|attributes|attribute)(\.|$)/i;
  const nonCharacterContext = /(^|\.)(item|items|equipment|equip|affix|baseaffix|inventory|bag|warehouse|skill|skills|talent|talents)(\.|$)/i;
  for (const entry of scalarEntries(tree)) {
    // An item's MaxLife affix is not the character's current life value.
    if (nonCharacterContext.test(entry.path)) continue;
    if (!isPlayerSnapshot && !statContext.test(entry.path)) continue;
    const canonical = STAT_KEY_MAP.get(normalizeKey(entry.key));
    const value = toNumber(entry.value);
    if (!canonical || value === null || !Number.isFinite(value)) continue;
    values.set(canonical, {
      key: canonical, value, rawKey: entry.key, path: entry.path,
      sourceAction: messageMeta.action, sourceKind: messageMeta.kind,
      observedAt: messageMeta.at, confidence: 'explicit-field',
    });
  }
  return [...values.values()];
}

function extractAffixEvidence(itemNode, itemPath) {
  return extractItemAffixEvidence(itemNode, itemPath).map((row) => ({
    ...row,
    values: (row.values || []).map((value) => ({
      key: value.key,
      value: capText(value.value, 100),
      path: value.path || null,
    })),
  })).slice(0, 40);
}

function extractExplicitEquipment(tree, messageMeta) {
  const rows = new Map();
  walk(tree, [], (node, nodePath) => {
    const path = nodePath.join('.');
    if (!EQUIPMENT_CONTEXT.test(path)) return;
    const rawId = direct(node, EQUIPMENT_ID_KEYS);
    const itemId = toNumber(rawId);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) return;
    const info = getItemInfo(itemId);
    const slotKey = Object.keys(node).find((key) => EQUIPMENT_SLOT_KEYS.map(normalizeKey).includes(normalizeKey(key)));
    const slotRaw = slotKey ? capText(direct(node, [slotKey]), 80) : null;
    const rowKey = `${itemId}:${slotRaw || ''}`;
    const previous = rows.get(rowKey);
    const metadata = extractItemMetadata(node);
    rows.set(rowKey, {
      itemId, name: getItemName(itemId), itemType: info?.typeRu || info?.type || metadata.itemTypeRaw || 'Тип неизвестен',
      iconUrl: info?.iconUrl || null, slotRaw: slotRaw || metadata.slotRaw || previous?.slotRaw || null,
      slotField: slotKey || previous?.slotField || null,
      count: Math.max(1, Number(direct(node, ['Count','Num','Quantity'])) || 1),
      ...metadata,
      affixes: [...(previous?.affixes || []), ...extractAffixEvidence(node, nodePath)].slice(0, 40),
      sourceAction: messageMeta.action, sourceKind: messageMeta.kind, observedAt: messageMeta.at,
      path, confidence: slotRaw ? 'explicit-equipment-id-and-slot' : 'explicit-equipment-id-slot-unknown',
      rawFields: Object.entries(node).filter(([, raw]) => {
        const value = Array.isArray(raw) ? raw.at(-1) : raw;
        return typeof value === 'string' || typeof value === 'number';
      }).slice(0, 40).map(([key, raw]) => ({ key, value: capText(Array.isArray(raw) ? raw.at(-1) : raw, 100) })),
    });
  });
  return [...rows.values()];
}

function extractFieldSchema(tree, messageMeta) {
  const fields = new Map();
  for (const entry of scalarEntries(tree)) {
    if (!INTERESTING_KEY.test(entry.key) && !INTERESTING_KEY.test(entry.path)) continue;
    const key = entry.path.slice(-160);
    if (!fields.has(key)) fields.set(key, { path: key, key: entry.key, sampleValueType: /^-?\d/.test(entry.value) ? 'number-like' : 'text-like', action: messageMeta.action });
  }
  return [...fields.values()].slice(0, 300);
}

function itemRows(items = [], messageMeta = {}) {
  const map = new Map();
  for (const item of items) {
    const id = Number(item.itemId ?? item.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const info = getItemInfo(id);
    const previous = map.get(id);
    map.set(id, {
      itemId: id, name: getItemName(id), itemType: info?.typeRu || info?.type || 'Тип неизвестен',
      iconUrl: info?.iconUrl || null, count: (previous?.count || 0) + Math.max(1, Number(item.count) || 1),
      itemInstance: item.itemInstance || previous?.itemInstance || null,
      extra: { ...(previous?.extra || {}), ...(item.extra || {}) },
      affixes: [...(previous?.affixes || []), ...(item.extra?.affixes || [])].slice(-40),
      itemLevelRaw: item.extra?.itemLevelRaw ?? previous?.itemLevelRaw ?? null,
      rarityRaw: item.extra?.rarityRaw ?? previous?.rarityRaw ?? null,
      qualityRaw: item.extra?.qualityRaw ?? previous?.qualityRaw ?? null,
      enhanceLevelRaw: item.extra?.enhanceLevelRaw ?? previous?.enhanceLevelRaw ?? null,
      slotRaw: item.extra?.slotRaw ?? previous?.slotRaw ?? null,
      affixCountRaw: item.extra?.affixCountRaw ?? previous?.affixCountRaw ?? null,
      itemTypeRaw: item.extra?.itemTypeRaw ?? previous?.itemTypeRaw ?? null,
      rawFields: [...(previous?.rawFields || []), ...(item.extra?.rawFields || [])].slice(-160),
      details: [...(previous?.details || []), ...(item.extra?.details || [])].slice(-100),
      sourceAction: messageMeta.action || 'snapshot', sourceKind: messageMeta.kind || null,
      observedAt: messageMeta.at || Date.now(), evidencePath: item.path || null,
    });
  }
  return [...map.values()];
}

function inventorySnapshotKey(row) { return `${row.action || 'snapshot'}:${Number(row.observedAt) || 0}`; }

/**
 * Evidence-first profile parser. It stores only explicit IDs and numeric fields
 * present in UE socket messages. Unknown paths are surfaced for diagnostics;
 * they are not guessed into skills, talents, stats, affixes or gear slots.
 */
export class CharacterIntel {
  constructor(seed = null) {
    this.identity = seed?.identity ? { ...seed.identity } : null;
    this.stats = new Map((Array.isArray(seed?.stats) ? seed.stats : []).map((row) => [row.key, { ...row }]));
    this.skills = new Map((Array.isArray(seed?.skills) ? seed.skills : []).map((row) => [`${row.kind}:${row.id}:${row.slot || ''}`, { ...row }]));
    this.talents = new Map((Array.isArray(seed?.talents) ? seed.talents : []).map((row) => [`${row.kind}:${row.id}:${row.slot || ''}`, { ...row }]));
    this.explicitEquipment = new Map((Array.isArray(seed?.explicitEquipment) ? seed.explicitEquipment : []).map((row) => [`${row.itemId}:${row.slotRaw || ''}`, { ...row }]));
    this.inventorySnapshots = Array.isArray(seed?.inventorySnapshots) ? seed.inventorySnapshots.slice(-12) : [];
    this.fieldSchema = new Map((Array.isArray(seed?.fieldSchema) ? seed.fieldSchema : []).map((row) => [row.path, { ...row }]));
    this.actions = new Map(Object.entries(seed?.actions || {}));
    this.lastObservedAt = Number(seed?.lastObservedAt) || null;
    this.messagesAnalyzed = Math.max(0, Number(seed?.messagesAnalyzed) || 0);
    this.lastAction = seed?.lastAction || null;
    this.lastUpdate = seed?.lastUpdate || null;
  }

  #storeInventorySnapshot(row) {
    const key = inventorySnapshotKey(row);
    const index = this.inventorySnapshots.findIndex((existing) => inventorySnapshotKey(existing) === key);
    if (index >= 0) this.inventorySnapshots[index] = row;
    else this.inventorySnapshots.push(row);
    this.inventorySnapshots.sort((a, b) => Number(a.observedAt || 0) - Number(b.observedAt || 0));
    this.inventorySnapshots = this.inventorySnapshots.slice(-12);
  }

  ingestMessage(message) {
    if (!message || !Array.isArray(message.body)) return { changed: false };
    const tree = parseTree(message.body);
    const at = parseUeTimestamp(message.time) ?? Date.now();
    const meta = { action: capText(message.action, 80), kind: capText(message.kind, 40), at };
    const identity = /^GetPlayerData$/i.test(meta.action) && /^Recv/i.test(meta.kind) ? identityFromTree(tree) : null;
    let changed = false;
    if (identity) {
      this.identity = { ...(this.identity || {}), ...identity, observedAt: at, sourceAction: meta.action, sourceKind: meta.kind };
      changed = true;
    }

    const statRows = extractStats(tree, meta);
    for (const row of statRows) {
      const previous = this.stats.get(row.key);
      if (!previous || row.observedAt >= previous.observedAt) { this.stats.set(row.key, row); changed = true; }
    }
    const skillRows = extractNodeRows(tree, SKILL_ID_KEYS, 'skill', meta);
    for (const row of skillRows) {
      const key = `${row.kind}:${row.id}:${row.slot || ''}`;
      const previous = this.skills.get(key);
      if (!previous || Number(row.observedAt) >= Number(previous.observedAt)) { this.skills.set(key, row); changed = true; }
    }
    const talentRows = extractNodeRows(tree, TALENT_ID_KEYS, 'talent', meta);
    for (const row of talentRows) {
      const key = `${row.kind}:${row.id}:${row.slot || ''}`;
      const previous = this.talents.get(key);
      if (!previous || Number(row.observedAt) >= Number(previous.observedAt)) { this.talents.set(key, row); changed = true; }
    }

    const equipmentRows = extractExplicitEquipment(tree, meta);
    for (const row of equipmentRows) {
      const key = `${row.itemId}:${row.slotRaw || ''}`;
      const previous = this.explicitEquipment.get(key);
      if (!previous || Number(row.observedAt) >= Number(previous.observedAt)) { this.explicitEquipment.set(key, row); changed = true; }
    }

    const schemaRows = extractFieldSchema(tree, meta);
    for (const row of schemaRows) {
      const previous = this.fieldSchema.get(row.path);
      this.fieldSchema.set(row.path, { ...row, seenCount: (previous?.seenCount || 0) + 1, lastSeenAt: at });
      if (!previous) changed = true;
    }

    const snapshotAction = /^(ResetItemsLayout|GetWareHousePage)$/i.test(meta.action) && /^Recv/i.test(meta.kind);
    if (snapshotAction) {
      const items = itemRows(collectItems(tree), meta);
      this.#storeInventorySnapshot({ action: meta.action, kind: meta.kind, observedAt: at, items, itemCount: items.length,
        completeness: message.truncated ? 'truncated' : 'snapshot', source: 'socket item snapshot', truncated: message.truncated === true });
      changed = true;
    }

    this.messagesAnalyzed++;
    this.actions.set(meta.action, (Number(this.actions.get(meta.action)) || 0) + 1);
    if (changed) {
      this.lastObservedAt = Math.max(this.lastObservedAt || 0, at);
      this.lastAction = meta.action;
      this.lastUpdate = { ...meta, hasIdentity: Boolean(identity), statsFound: statRows.length,
        skillsFound: skillRows.length, talentsFound: talentRows.length, equipmentFound: equipmentRows.length, snapshotFound: snapshotAction };
    }
    return { changed, identity, stats: statRows, skills: skillRows, talents: talentRows, equipment: equipmentRows, snapshotAction };
  }

  applyEvent(event) {
    if (!event || event.type !== 'snapshot' || !Array.isArray(event.items)) return false;
    const at = Number(event.ts) || parseUeTimestamp(event.time) || Date.now();
    const meta = { action: event.snapshotKind || event.action, kind: event.kind, at };
    const items = itemRows(event.items, meta);
    this.#storeInventorySnapshot({ action: meta.action, kind: meta.kind || null, observedAt: at,
      items, itemCount: items.length, completeness: event.truncated ? 'truncated' : 'snapshot',
      source: 'socket item snapshot', truncated: event.truncated === true });
    this.lastObservedAt = Math.max(this.lastObservedAt || 0, at);
    this.lastAction = meta.action;
    this.lastUpdate = { ...meta, snapshotFound: true, itemCount: items.length };
    return true;
  }

  merge(other) {
    const incoming = other instanceof CharacterIntel ? other.exportState() : (other || {});
    if (incoming.identity && (!this.identity || Number(incoming.identity.observedAt || 0) >= Number(this.identity.observedAt || 0))) this.identity = { ...incoming.identity };
    for (const row of incoming.stats || []) {
      const previous = this.stats.get(row.key);
      if (!previous || Number(row.observedAt || 0) >= Number(previous.observedAt || 0)) this.stats.set(row.key, { ...row });
    }
    for (const row of incoming.skills || []) {
      const key = `${row.kind}:${row.id}:${row.slot || ''}`, previous = this.skills.get(key);
      if (!previous || Number(row.observedAt || 0) >= Number(previous.observedAt || 0)) this.skills.set(key, { ...row });
    }
    for (const row of incoming.talents || []) {
      const key = `${row.kind}:${row.id}:${row.slot || ''}`, previous = this.talents.get(key);
      if (!previous || Number(row.observedAt || 0) >= Number(previous.observedAt || 0)) this.talents.set(key, { ...row });
    }
    for (const row of incoming.explicitEquipment || []) {
      const key = `${row.itemId}:${row.slotRaw || ''}`, previous = this.explicitEquipment.get(key);
      if (!previous || Number(row.observedAt || 0) >= Number(previous.observedAt || 0)) this.explicitEquipment.set(key, { ...row });
    }
    for (const row of incoming.inventorySnapshots || []) this.#storeInventorySnapshot(row);
    for (const row of incoming.fieldSchema || []) {
      const previous = this.fieldSchema.get(row.path);
      this.fieldSchema.set(row.path, { ...row, seenCount: Math.max(Number(previous?.seenCount) || 0, Number(row.seenCount) || 0) });
    }
    for (const [action, count] of Object.entries(incoming.actions || {})) this.actions.set(action, Math.max(Number(this.actions.get(action)) || 0, Number(count) || 0));
    this.messagesAnalyzed = Math.max(this.messagesAnalyzed, Number(incoming.messagesAnalyzed) || 0);
    this.lastObservedAt = Math.max(this.lastObservedAt || 0, Number(incoming.lastObservedAt) || 0) || null;
    if (Number(incoming.lastObservedAt || 0) >= Number(this.lastUpdate?.at || 0)) {
      this.lastAction = incoming.lastAction || this.lastAction;
      this.lastUpdate = incoming.lastUpdate || this.lastUpdate;
    }
    return this.snapshot();
  }

  exportState() {
    return { identity: this.identity ? { ...this.identity } : null, stats: [...this.stats.values()].map((x) => ({ ...x })),
      skills: [...this.skills.values()].map((x) => ({ ...x })), talents: [...this.talents.values()].map((x) => ({ ...x })),
      explicitEquipment: [...this.explicitEquipment.values()].map((x) => ({ ...x, affixes: (x.affixes || []).map((a) => ({ ...a, values: (a.values || []).map((v) => ({ ...v })) })), rawFields: (x.rawFields || []).map((v) => ({ ...v })) })),
      inventorySnapshots: this.inventorySnapshots.map((x) => ({
        ...x,
        items: (x.items || []).map((i) => ({
          ...i,
          extra: { ...(i.extra || {}) },
          affixes: (i.affixes || []).map((a) => ({ ...a, values: (a.values || []).map((v) => ({ ...v })) })),
          details: (i.details || []).map((d) => ({ ...d })),
        })),
      })),
      fieldSchema: [...this.fieldSchema.values()].slice(-300).map((x) => ({ ...x })), actions: Object.fromEntries(this.actions),
      lastObservedAt: this.lastObservedAt, messagesAnalyzed: this.messagesAnalyzed, lastAction: this.lastAction,
      lastUpdate: this.lastUpdate ? { ...this.lastUpdate } : null };
  }

  snapshot() {
    const state = this.exportState();
    const latestInventory = state.inventorySnapshots.at(-1) || null;
    const identityFields = Object.keys(state.identity || {}).filter((key) => !['observedAt', 'sourceAction', 'sourceKind'].includes(key));
    const sections = {
      identity: { status: state.identity ? 'observed' : 'missing', count: identityFields.length, source: state.identity?.sourceAction || null },
      stats: { status: state.stats.length ? 'partial' : 'missing', count: state.stats.length },
      skills: { status: state.skills.length ? 'partial' : 'missing', count: state.skills.length },
      talents: { status: state.talents.length ? 'partial' : 'missing', count: state.talents.length },
      inventory: { status: latestInventory ? 'observed' : 'missing', count: latestInventory?.itemCount || 0 },
      equipment: { status: state.explicitEquipment.length ? 'observed' : 'missing', count: state.explicitEquipment.length },
    };
    const observedSections = Object.values(sections).filter((x) => x.status !== 'missing').length;
    const actionRows = Object.entries(state.actions).sort((a, b) => b[1] - a[1]).map(([action, count]) => ({ action, count }));
    return { ...state, sections, observedSections, totalSections: Object.keys(sections).length,
      completeness: Math.round(observedSections / Object.keys(sections).length * 100),
      completenessLabel: `${observedSections} из ${Object.keys(sections).length} разделов имеют данные`,
      latestInventory, actionRows,
      explicitEquipment: state.explicitEquipment,
      limitations: [
        'Значения добавляются только если присутствуют в разобранном сообщении UE_game.log.',
        'ID навыков и талантов пока не переводятся в названия без актуального разрешённого каталога данных.',
        'ResetItemsLayout / GetWareHousePage — это снимки инвентаря/хранилища, не доказательство надетых слотов.',
        'Явная экипировка отображается только если путь содержит equipment/equipped/worn и сообщение содержит ItemBaseId/ConfigBaseId; слот показывается только из явного EquipSlot/EquipmentSlot/WearSlot/SlotName.',
        'Слоты экипировки, аффиксы и точные значения роллов не выводятся из одного ConfigBaseId.',
        'Поля, не найденные в доступных сообщениях, должны быть подтверждены отдельным источником или введены вручную.',
      ] };
  }
}
