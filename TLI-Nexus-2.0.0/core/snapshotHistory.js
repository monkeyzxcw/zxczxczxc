import { createHash } from 'node:crypto';

const safeNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const sortByKey = (rows, key) => [...(Array.isArray(rows) ? rows : [])].sort((a, b) => String(a?.[key] ?? '').localeCompare(String(b?.[key] ?? '')));

function normalizedIntel(intel = {}, equipment = null) {
  const identity = intel.identity || {};
  const stats = sortByKey(intel.stats || [], 'key').map((row) => ({ key: row.key, value: safeNumber(row.value) }));
  const skills = sortByKey(intel.skills || [], 'id').map((row) => ({ id: String(row.id), level: safeNumber(row.level), slot: row.slot || null }));
  const talents = sortByKey(intel.talents || [], 'id').map((row) => ({ id: String(row.id), level: safeNumber(row.level), slot: row.slot || null }));
  const explicitEquipment = sortByKey(intel.explicitEquipment || [], 'itemId').map((row) => ({ itemId: Number(row.itemId), slotRaw: row.slotRaw || null, affixes: row.affixes || [] }));
  const partialEquipment = sortByKey(equipment?.items || [], 'itemId').map((row) => ({ itemId: Number(row.itemId), count: Number(row.count) || 0 }));
  const latestInventory = intel.latestInventory || (intel.inventorySnapshots || []).at(-1) || null;
  const inventory = sortByKey(latestInventory?.items || [], 'itemId').map((row) => ({ itemId: Number(row.itemId), count: Number(row.count) || 0 }));
  return {
    playerId: identity.playerId || null,
    name: identity.name || null,
    seasonId: safeNumber(identity.seasonId),
    heroId: identity.heroId || null,
    level: safeNumber(identity.level),
    specializationId: identity.specializationId || null,
    stats, skills, talents, explicitEquipment, partialEquipment, inventory,
  };
}

export function characterSnapshotFingerprint(intel, equipment = null) {
  const normalized = normalizedIntel(intel, equipment);
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 24);
}

export function createCharacterSnapshot(intel, equipment = null, at = Date.now()) {
  const identity = intel?.identity || null;
  const latestInventory = intel?.latestInventory || (intel?.inventorySnapshots || []).at(-1) || null;
  const fingerprint = characterSnapshotFingerprint(intel, equipment);
  return {
    id: `snap_${fingerprint}_${Number(at).toString(36)}`,
    fingerprint,
    capturedAt: Number(at) || Date.now(),
    playerId: identity?.playerId || null,
    name: identity?.name || null,
    seasonId: safeNumber(identity?.seasonId),
    heroId: identity?.heroId || null,
    heroName: identity?.heroName || null,
    level: safeNumber(identity?.level),
    specializationId: identity?.specializationId || null,
    statCount: Array.isArray(intel?.stats) ? intel.stats.length : 0,
    skillCount: Array.isArray(intel?.skills) ? intel.skills.length : 0,
    talentCount: Array.isArray(intel?.talents) ? intel.talents.length : 0,
    explicitEquipmentCount: Array.isArray(intel?.explicitEquipment) ? intel.explicitEquipment.length : 0,
    partialEquipmentCount: Array.isArray(equipment?.items) ? equipment.items.length : 0,
    inventoryItemTypes: Array.isArray(latestInventory?.items) ? latestInventory.items.length : 0,
    completeness: intel?.completeness ?? null,
    sourceAction: intel?.lastAction || null,
    sourceObservedAt: safeNumber(intel?.lastObservedAt),
    stats: (intel?.stats || []).map((row) => ({ ...row })),
    skills: (intel?.skills || []).map((row) => ({ ...row })),
    talents: (intel?.talents || []).map((row) => ({ ...row })),
    explicitEquipment: (intel?.explicitEquipment || []).map((row) => ({ ...row, affixes: (row.affixes || []).map((x) => ({ ...x })) })),
    partialEquipment: (equipment?.items || []).map((row) => ({ ...row })),
    inventorySnapshot: latestInventory ? { action: latestInventory.action, observedAt: latestInventory.observedAt,
      items: (latestInventory.items || []).map((row) => ({ itemId: row.itemId, name: row.name, count: row.count })) } : null,
  };
}

export function appendCharacterSnapshot(history = [], snapshot, { maxEntries = 60, retentionDays = 365 } = {}) {
  const now = Number(snapshot?.capturedAt) || Date.now();
  const retentionMs = Math.max(7, Number(retentionDays) || 365) * 86400000;
  const rows = (Array.isArray(history) ? history : []).filter((row) => now - Number(row.capturedAt || 0) <= retentionMs);
  if (snapshot?.fingerprint && rows.at(-1)?.fingerprint === snapshot.fingerprint) return rows.slice(-maxEntries);
  if (snapshot) rows.push(snapshot);
  return rows.slice(-Math.max(2, Number(maxEntries) || 60));
}

export function compareCharacterSnapshots(previous, current) {
  if (!previous || !current) return { available: false, rows: [], message: 'Нужно выбрать два снимка персонажа.' };
  const rows = [];
  const leftStats = new Map((previous.stats || []).map((row) => [row.key, row]));
  const rightStats = new Map((current.stats || []).map((row) => [row.key, row]));
  for (const key of new Set([...leftStats.keys(), ...rightStats.keys()])) {
    const left = leftStats.get(key)?.value ?? null;
    const right = rightStats.get(key)?.value ?? null;
    if (left !== right) rows.push({ kind: 'stat', key, before: left, after: right,
      delta: left === null || right === null ? null : Number((right - left).toFixed(4)) });
  }
  for (const [key, label] of [['skills', 'Навык'], ['talents', 'Талант']]) {
    const before = new Set((previous[key] || []).map((x) => `${x.id}:${x.slot || ''}`));
    const after = new Set((current[key] || []).map((x) => `${x.id}:${x.slot || ''}`));
    for (const value of after) if (!before.has(value)) rows.push({ kind: key, key, change: 'added', value: `${label} ${value}` });
    for (const value of before) if (!after.has(value)) rows.push({ kind: key, key, change: 'removed', value: `${label} ${value}` });
  }
  const gearKey = (row) => `${row.itemId}:${row.slotRaw || ''}`;
  for (const [key, label, prop] of [['explicitEquipment', 'Экипировка из явных полей лога', 'explicitEquipment'], ['partialEquipment', 'Наблюдаемое PutOn/PutOff', 'partialEquipment']]) {
    const summarize = (list) => {
      const map = new Map();
      for (const row of list || []) {
        const k = gearKey(row);
        const existing = map.get(k) || { count: 0, affixIds: [] };
        existing.count += Math.max(1, Number(row.count) || 1);
        existing.affixIds.push(...(row.affixes || []).map((x) => String(x.id ?? x.affixId ?? '')).filter(Boolean));
        map.set(k, existing);
      }
      for (const value of map.values()) value.affixIds = [...new Set(value.affixIds)].sort();
      return map;
    };
    const before = summarize(previous[prop]);
    const after = summarize(current[prop]);
    for (const [value, item] of after) {
      const prior = before.get(value);
      if (!prior) rows.push({ kind: key, change: 'added', value: `${label}: ${value}` });
      else {
        if (prior.count !== item.count) rows.push({ kind: key, change: 'quantity-changed', value: `${label}: ${value}`, before: prior.count, after: item.count });
        if (JSON.stringify(prior.affixIds) !== JSON.stringify(item.affixIds)) rows.push({ kind: key, change: 'affixes-changed', value: `${label}: ${value}`, before: prior.affixIds, after: item.affixIds });
      }
    }
    for (const value of before.keys()) if (!after.has(value)) rows.push({ kind: key, change: 'removed', value: `${label}: ${value}` });
  }
  return { available: true, rows, previousAt: previous.capturedAt, currentAt: current.capturedAt,
    added: rows.filter((x) => x.change === 'added').length,
    removed: rows.filter((x) => x.change === 'removed').length,
    statChanges: rows.filter((x) => x.kind === 'stat').length };
}
