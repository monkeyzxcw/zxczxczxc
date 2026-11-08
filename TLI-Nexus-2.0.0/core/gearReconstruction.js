const SLOT_ALIASES = new Map([
  ['helmet', 'helmet'], ['head', 'helmet'], ['headgear', 'helmet'],
  ['amulet', 'amulet'], ['necklace', 'amulet'], ['pendant', 'amulet'],
  ['chest', 'chest'], ['body', 'chest'], ['armor', 'chest'], ['chestarmor', 'chest'],
  ['gloves', 'gloves'], ['glove', 'gloves'], ['hands', 'gloves'],
  ['belt', 'belt'], ['waist', 'belt'],
  ['boots', 'boots'], ['boot', 'boots'], ['feet', 'boots'],
  ['ring1', 'ring1'], ['firstring', 'ring1'], ['ringleft', 'ring1'],
  ['ring2', 'ring2'], ['secondring', 'ring2'], ['ringright', 'ring2'],
  ['weapon1', 'weapon1'], ['mainhand', 'weapon1'], ['mainweapon', 'weapon1'],
  ['weapon2', 'weapon2'], ['offhand', 'weapon2'], ['secondaryweapon', 'weapon2'],
]);
const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (value, max = 300) => String(value ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function resolveSlot(raw) {
  const key = normalize(raw);
  if (!key) return null;
  // Accept only known textual slot labels. Numeric enum values need the matching
  // GameEquipSlot table and are deliberately not guessed here.
  return SLOT_ALIASES.get(key) || null;
}

function isAuthoritativeEquipmentSnapshot(item) {
  const action = String(item?.sourceAction || '');
  const kind = String(item?.sourceKind || '');
  return /^(GetPlayerData|GetEquipment|GetPlayerEquipment|GetEquipData)$/i.test(action) && (!kind || /^Recv/i.test(kind));
}

function explicitRawLines(item) {
  const lines = [];
  for (const affix of Array.isArray(item.affixes) ? item.affixes : []) {
    const raw = affix?.raw_text ?? affix?.rawText ?? affix?.modifierText ?? affix?.affixText;
    if (typeof raw === 'string' && raw.trim()) lines.push(clean(raw, 1200));
    for (const field of Array.isArray(affix?.values) ? affix.values : []) {
      if (/^(rawtext|modifiertext|affixtext|effecttext)$/i.test(String(field?.key || '').replace(/[^a-z]/gi, ''))) {
        if (typeof field.value === 'string' && field.value.trim()) lines.push(clean(field.value, 1200));
      }
    }
  }
  for (const field of Array.isArray(item.rawFields) ? item.rawFields : []) {
    if (/^(legendaryeffecttext|uniqueeffecttext|specialeffecttext|effectraw|legendaryeffectraw)$/i.test(String(field?.key || '').replace(/[^a-z]/gi, ''))) {
      if (typeof field.value === 'string' && field.value.trim()) lines.push(clean(field.value, 1200));
    }
  }
  return [...new Set(lines)].slice(0, 40);
}

function explicitGrantedTalents(item) {
  const raw = item.grantedTalents ?? item.granted_talents;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x) => typeof x === 'string' && x.trim()).map((x) => clean(x, 180)))].slice(0, 20);
}

/**
 * Reconstructs only slot/item relationships explicitly observed under CharacterIntel's
 * equipment/equipped/worn paths. This is a conservative GearEngineItem bridge:
 * raw modifier lines are forwarded through unresolved_texts for TLIBuilder's own
 * resolver; structured affix IDs/individual scalar fields are never converted to stats.
 */
export function reconstructObservedGear(intel = {}, configuredGear = []) {
  const warnings = [];
  const observed = Array.isArray(intel.explicitEquipment) ? intel.explicitEquipment : [];
  const bySlot = new Map();
  const unresolvedSlotItems = [];
  const nonSnapshotItems = [];
  for (const item of observed) {
    if (!isAuthoritativeEquipmentSnapshot(item)) {
      nonSnapshotItems.push(item);
      continue;
    }
    const slot = resolveSlot(item?.slotRaw);
    if (!slot) {
      unresolvedSlotItems.push(item);
      continue;
    }
    const previous = bySlot.get(slot);
    if (!previous || Number(item.observedAt || 0) >= Number(previous.observedAt || 0)) bySlot.set(slot, item);
  }

  const gear = [];
  for (const [slot, item] of bySlot) {
    const rawLines = explicitRawLines(item);
    const itemName = clean(item.name || (item.itemId ? `Предмет #${item.itemId}` : 'Предмет'), 140);
    const isShield = /shield|щит/i.test(`${item.itemType || ''} ${item.itemTypeRaw || ''} ${item.name || ''}`);
    const row = {
      contributions: [],
      item_name: itemName,
      slot,
      is_shield: isShield,
      ...(rawLines.length ? { unresolved_texts: rawLines } : {}),
    };
    const grants = explicitGrantedTalents(item);
    if (grants.length) row.granted_talents = grants;
    const blend = clean(item.beltBlend ?? item.belt_blend, 120);
    if (slot === 'belt' && blend) row.belt_blend = blend;
    gear.push(row);
    if (!rawLines.length) warnings.push(`«${itemName}» (${slot}): слот и предмет наблюдались, но полные строки аффиксов не получены; вклад в расчёт не восстановлен.`);
    if (Array.isArray(item.affixes) && item.affixes.some((a) => a?.id) && !rawLines.length) {
      warnings.push(`«${itemName}»: обнаружены ID аффиксов, но нет проверенной таблицы ID → модификатор TLIBuilder. ID не преобразованы в выдуманные статы.`);
    }
  }
  if (unresolvedSlotItems.length) warnings.push(`${unresolvedSlotItems.length} предмет(ов) имеют явный ID, но слот не удалось подтвердить. Они не отправлены в gear.`);
  if (nonSnapshotItems.length) warnings.push(`${nonSnapshotItems.length} записей экипировки пришли не из подтверждённого snapshot-ответа GetPlayerData/GetEquipment. События PutOn/PutOff и исторические наблюдения пока не используются как текущее состояние.`);

  const configured = Array.isArray(configuredGear) ? configuredGear.slice(0, 40) : [];
  // Manual engineConfig remains the authoritative override. Automatically observed items
  // fill the request only when no manual gear has been supplied.
  const useConfigured = configured.length > 0;
  const selectedGear = useConfigured ? configured : gear;
  if (useConfigured && gear.length) warnings.push('Для расчёта используется ручной engineConfig.gear; автоматически наблюдаемая экипировка показана только в coverage и не подмешивается во избежание дублей.');
  if (!selectedGear.length) warnings.push('Надетые предметы не восстановлены: нет явных записей экипировки с распознанными слотами.');
  const effectiveGear = selectedGear.filter((row) =>
    (Array.isArray(row?.contributions) && row.contributions.length > 0) ||
    (Array.isArray(row?.unresolved_texts) && row.unresolved_texts.length > 0) ||
    (Array.isArray(row?.granted_talents) && row.granted_talents.length > 0) ||
    Boolean(row?.belt_blend)
  );
  return {
    gear: selectedGear,
    warnings: [...new Set(warnings)],
    coverage: {
      observedItems: observed.length,
      authoritativeSnapshots: observed.length - nonSnapshotItems.length,
      recognizedSlots: gear.length,
      unresolvedSlots: unresolvedSlotItems.length,
      itemsWithRawAffixLines: gear.filter((row) => row.unresolved_texts?.length).length,
      effectiveEngineItems: effectiveGear.length,
      source: useConfigured ? 'manual-engine-config' : 'explicit-character-intel',
      complete: gear.length > 0 && gear.every((row) => row.unresolved_texts?.length || row.granted_talents?.length || row.belt_blend),
    },
  };
}
