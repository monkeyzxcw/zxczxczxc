const clean = (value, max = 500) => String(value ?? '').replace(/[\\r\\n\\0]/g, ' ').trim().slice(0, max);
const normalize = (value) => String(value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();

function indexes(resourceIndex) {
  const localizations = new Map((resourceIndex?.localizationEntries || []).map((row) => [String(row.key), row.text]));
  const talents = new Map((resourceIndex?.talentDefinitions || []).flatMap((row) =>
    [row.id, row.rowName].filter((value) => value != null).map((value) => [String(value), row])));
  const items = new Map((resourceIndex?.itemDefinitions || []).filter((row) => row.id != null).map((row) => [String(row.id), row]));
  const affixes = new Map((resourceIndex?.affixDefinitions || []).filter((row) => row.id != null).map((row) => [String(row.id), row]));
  const attributes = new Map();
  for (const row of resourceIndex?.attributeDefinitions || []) {
    const type = String(row.enumType || row.sourcePath || '');
    for (const [pattern, target] of [
      [/gameequipslot|equipmentslot|equipslot/i, 'slot'],
      [/affixattrtype/i, 'affix'],
    ]) if (pattern.test(type)) {
      for (const key of [row.enumId, row.valueRaw, row.id, row.rowName]) if (key != null) attributes.set(target+':'+String(key), row);
    }
  }
  return { localizations, talents, items, affixes, attributes };
}
function localized(row, ix, fields = ['nameKeyRaw','textKeyRaw','descriptionKeyRaw']) {
  for (const field of fields) {
    const key = row?.[field];
    if (key && ix.localizations.has(String(key))) return ix.localizations.get(String(key));
  }
  return null;
}
function definitionName(row, ix) {
  return row?.name || localized(row, ix) || row?.rowName || null;
}

/** Resolves observed IDs only through the exact IDs and localization keys in the user's imported game resources. */
export function resolveCharacterIntelNames(intel = {}, resourceIndex = null) {
  const ix = indexes(resourceIndex);
  const talents = (intel.talents || []).map((row) => {
    const definition = ix.talents.get(String(row.id)) || (row.nameKey ? { nameKeyRaw: row.nameKey } : null);
    const name = row.name || definitionName(definition, ix) || localized(row, ix);
    return { ...row, name, description: definition?.descriptionRaw || localized(definition, ix, ['descriptionKeyRaw']) || null,
      catalogResolved: Boolean(name && name !== row.id) };
  });
  const skills = (intel.skills || []).map((row) => ({ ...row, name: row.name || localized(row, ix), catalogResolved: Boolean(row.name || localized(row, ix)) }));
  const explicitEquipment = (intel.explicitEquipment || []).map((item) => {
    const definition = ix.items.get(String(item.itemId));
    const name = item.name && !/^Предмет #\\d+$/.test(item.name) ? item.name : definitionName(definition, ix) || item.name;
    const slotDefinition = item.slotRaw ? ix.attributes.get('slot:'+String(item.slotRaw)) : null;
    const slotName = slotDefinition?.enumName || slotDefinition?.name || localized(slotDefinition, ix) || null;
    const affixes = (item.affixes || []).map((affix) => {
      const affixDefinition = ix.affixes.get(String(affix.id));
      const attr = affixDefinition?.attributeRaw ? ix.attributes.get('affix:'+String(affixDefinition.attributeRaw)) : null;
      return { ...affix, name: affix.name || definitionName(affixDefinition, ix),
        attributeName: attr?.enumName || attr?.name || localized(attr, ix) || null,
        catalogResolved: Boolean(affixDefinition) };
    });
    return { ...item, name, slotName, affixes, catalogResolved: Boolean(definition) };
  });
  const inventorySnapshots = (intel.inventorySnapshots || []).map((snapshot) => ({
    ...snapshot, items: (snapshot.items || []).map((item) => {
      const definition = ix.items.get(String(item.itemId));
      return { ...item, name: item.name && !/^Предмет #\\d+$/.test(item.name) ? item.name : definitionName(definition, ix) || item.name };
    }),
  }));
  const latestInventory = inventorySnapshots.at(-1) || intel.latestInventory || null;
  return { ...intel, talents, skills, explicitEquipment, inventorySnapshots, latestInventory,
    catalogResolution: { imported: Boolean(resourceIndex), talentDefinitions: ix.talents.size,
      itemDefinitions: ix.items.size, affixDefinitions: ix.affixes.size,
      resolvedTalents: talents.filter((row) => row.catalogResolved).length,
      resolvedItems: explicitEquipment.filter((row) => row.catalogResolved).length,
      resolvedAffixes: explicitEquipment.reduce((sum, row) => sum + row.affixes.filter((a) => a.catalogResolved).length, 0) } };
}
