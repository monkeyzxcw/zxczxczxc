const ID_KEYS = new Set([
  'id', 'affixid', 'baseaffixid', 'affixconfigid', 'affixbaseid', 'configid',
  'attrid', 'attributeid', 'propertyid', 'itemid', 'itembaseid', 'configbaseid',
]);
const AFFIx_CONTEXT = /(?:affix|prefix|suffix|baseaffix|randaffix|enchant|forge)/i;
const scalar = (value) => Array.isArray(value) ? value.at(-1) : value;
const isObject = (value) => value !== null && typeof value === 'object';
const text = (value, max = 160) => String(value ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);
const normalizeKey = (value) => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();

function walk(node, path = [], visit = () => {}) {
  if (Array.isArray(node)) {
    node.forEach((value, index) => walk(value, [...path, String(index)], visit));
    return;
  }
  if (!isObject(node)) return;
  visit(node, path);
  for (const [key, value] of Object.entries(node)) walk(value, [...path, key], visit);
}

function allScalars(node, prefix = [], out = []) {
  if (Array.isArray(node)) {
    node.forEach((value, index) => allScalars(value, [...prefix, String(index)], out));
    return out;
  }
  if (!isObject(node)) return out;
  for (const [key, raw] of Object.entries(node)) {
    const value = scalar(raw);
    const next = [...prefix, key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push({ key, path: next.join('.'), value: text(value, 220) });
    } else {
      allScalars(value, next, out);
    }
  }
  return out;
}

function directScalar(node, names) {
  if (!isObject(node) || Array.isArray(node)) return null;
  const wanted = new Set(names.map(normalizeKey));
  for (const [key, raw] of Object.entries(node)) {
    if (!wanted.has(normalizeKey(key))) continue;
    const value = scalar(raw);
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return null;
}

/**
 * Extract only explicitly nested affix structures. The source path is retained
 * so a later resource catalog can resolve the exact field IDs without guesses.
 */
export function extractItemAffixEvidence(itemNode, pathPrefix = []) {
  const rows = [];
  walk(itemNode, [], (node, nodePath) => {
    const fullPath = [...pathPrefix, ...nodePath];
    const contextPath = fullPath.join('.');
    if (!AFFIx_CONTEXT.test(contextPath)) return;

    const idKey = Object.keys(node).find((key) => ID_KEYS.has(normalizeKey(key)));
    const id = idKey ? directScalar(node, [idKey]) : null;
    const fields = allScalars(node).filter((field) => !ID_KEYS.has(normalizeKey(field.key)));
    if (!id && fields.length === 0) return;

    const values = fields.map((field) => ({
      key: field.key,
      path: field.path,
      value: field.value,
    }));
    const name = directScalar(node, [
      'AffixName', 'Name', 'DisplayName', 'NameKey', 'TextKey', 'DescKey',
    ]);
    const tier = directScalar(node, ['Tier', 'AffixTier', 'Level', 'AffixLevel']);
    const attrType = directScalar(node, [
      'AttrType', 'AffixAttrType', 'AttributeType', 'AttributeId', 'AttrId',
    ]);

    rows.push({
      id: id ? text(id, 100) : null,
      name: name ? text(name, 160) : null,
      tierRaw: tier ? text(tier, 40) : null,
      attributeRaw: attrType ? text(attrType, 100) : null,
      path: contextPath.slice(0, 300),
      values: values.slice(0, 80),
      confidence: id ? 'explicit-affix-id' : 'explicit-affix-context-fields',
    });
  });

  const deduped = new Map();
  for (const row of rows) {
    const key = [row.id || '', row.path, row.attributeRaw || ''].join('|');
    deduped.set(key, row);
  }
  return [...deduped.values()].slice(0, 40);
}

/**
 * Keep item metadata literal. Numeric rarity/quality values are deliberately
 * not translated into game labels until a verified enum resource is imported.
 */
export function extractItemMetadata(itemNode) {
  const value = (names) => {
    const found = directScalar(itemNode, names);
    return found === null ? null : text(found, 100);
  };
  return {
    itemLevelRaw: value(['ItemLevel', 'EquipLevel', 'RequiredLevel', 'Level']),
    rarityRaw: value(['RareValue', 'Rarity', 'RareType', 'QualityType']),
    qualityRaw: value(['Quality', 'QualityValue', 'EquipQuality']),
    enhanceLevelRaw: value(['EnhanceLevel', 'StrengthenLevel', 'ForgeLevel', 'Enhance']),
    slotRaw: value(['EquipSlot', 'EquipmentSlot', 'WearSlot', 'SlotName', 'PartName']),
    affixCountRaw: value(['AffixNum', 'BaseAffixNum', 'AffixCount', 'RandAffixNum']),
    itemTypeRaw: value(['ItemType', 'EquipType', 'EquipmentType', 'Type']),
  };
}

export function inspectItemObservation(itemNode, pathPrefix = []) {
  const metadata = extractItemMetadata(itemNode);
  const affixes = extractItemAffixEvidence(itemNode, pathPrefix);
  const rawFields = allScalars(itemNode).slice(0, 160).map((field) => ({
    key: field.key,
    path: [...pathPrefix, field.path].join('.').slice(0, 300),
    value: field.value,
  }));
  return {
    ...metadata,
    affixes,
    rawFields,
    evidence: 'UE_game parsed item tree',
    completeness: 'partial',
  };
}
