const DIRECTIONS = new Set(['higher', 'lower', 'presence']);
const MAX_RULES = 50;
const MAX_ITEMS = 100;
const TECHNICAL_ID_KEYS = new Set([
  'id', 'baseid', 'affixid', 'baseaffixid', 'affixconfigid', 'affixbaseid',
  'itemid', 'itembaseid', 'itemconfigid', 'equipmentid', 'equipmentbaseid', 'configbaseid',
]);
const STRUCTURAL_AFFIX_KEYS = new Set([
  'attrtype', 'affixtype', 'attributetype', 'tier', 'affixtier', 'level', 'affixlevel',
  'name', 'affixname', 'displayname', 'namekey', 'textkey', 'desckey', 'descriptionkey',
  'min', 'minvalue', 'valuemin', 'minroll', 'max', 'maxvalue', 'valuemax', 'maxroll',
]);

const normalizeKey = (value) => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const cleanText = (value, max = 160) =>
  String(value ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);

function normalizeDirection(value) {
  const direction = String(value ?? '').trim().toLowerCase();
  if (DIRECTIONS.has(direction)) return direction;
  if (['выше', 'больше', 'максимум', 'увеличение'].includes(direction)) return 'higher';
  if (['ниже', 'меньше', 'минимум', 'снижение'].includes(direction)) return 'lower';
  if (['наличие', 'есть', 'присутствие'].includes(direction)) return 'presence';
  return null;
}

/**
 * Rules are owned by the user. No game-specific stat weights or directions
 * are inferred here.
 *
 * Syntax: exactRawKey | label | weight (1–5) | higher/lower/presence
 */
export function normalizePriorityRules(input) {
  let rows = input;

  if (typeof rows === 'string') {
    rows = rows.split(/\r?\n/).map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return null;

      const [rawKey, label, weight, direction] = trimmed
        .split('|')
        .map((part) => part.trim());

      return { rawKey, label, weight, direction };
    }).filter(Boolean);
  }

  if (!Array.isArray(rows) && Array.isArray(rows?.rules)) rows = rows.rules;
  if (!Array.isArray(rows)) return [];

  const rules = new Map();
  for (const entry of rows.slice(0, MAX_RULES * 2)) {
    if (!entry || typeof entry !== 'object') continue;

    const rawKey = cleanText(entry.rawKey ?? entry.key, 100);
    const weight = Number(entry.weight);
    const direction = normalizeDirection(entry.direction);

    if (!rawKey || !Number.isInteger(weight) || weight < 1 || weight > 5 || !direction) {
      continue;
    }

    rules.set(rawKey, {
      rawKey,
      label: cleanText(entry.label || rawKey, 100),
      weight,
      direction,
    });

    if (rules.size >= MAX_RULES) break;
  }

  return [...rules.values()];
}

function normalizeItem(item, index = 0) {
  if (!item || typeof item !== 'object') return null;

  const itemId = Number(item.itemId ?? item.id);
  const affixes = Array.isArray(item.affixes) ? item.affixes : [];
  const values = [];
  const normalizedAffixes = [];

  for (const affix of affixes) {
    if (!affix || typeof affix !== 'object') continue;

    const affixId = cleanText(affix.id, 100) || null;
    const affixValues = [];
    for (const field of Array.isArray(affix.values) ? affix.values : []) {
      if (!field || typeof field !== 'object') continue;

      const rawKey = cleanText(field.key, 100);
      if (
        !rawKey ||
        TECHNICAL_ID_KEYS.has(normalizeKey(rawKey)) ||
        STRUCTURAL_AFFIX_KEYS.has(normalizeKey(rawKey)) ||
        field.value === undefined ||
        field.value === null
      ) {
        continue;
      }

      const value = {
        rawKey,
        value: cleanText(field.value, 100),
        path: cleanText(field.path, 240) || null,
        affixId,
        attributeRaw: cleanText(affix.attributeRaw, 100) || null,
      };
      values.push(value);
      affixValues.push(value);
    }
    normalizedAffixes.push({
      id: affixId,
      name: cleanText(affix.name, 140) || null,
      tierRaw: cleanText(affix.tierRaw, 40) || null,
      attributeRaw: cleanText(affix.attributeRaw, 100) || null,
      path: cleanText(affix.path, 300) || null,
      confidence: cleanText(affix.confidence, 80) || 'explicit-affix-evidence',
      values: affixValues,
    });
  }

  // Repeated keys from different affixes remain ambiguous evidence.
  const deduped = [
    ...new Map(
      values.map((row) => [
        row.rawKey + '\0' + row.value + '\0' + (row.affixId || ''),
        row,
      ]),
    ).values(),
  ];

  return {
    key: (Number.isSafeInteger(itemId) && itemId > 0 ? itemId : 'unknown') +
      ':' + cleanText(item.slotRaw, 80) + ':' + index,
    itemId: Number.isSafeInteger(itemId) && itemId > 0 ? itemId : null,
    name: cleanText(
      item.name || (itemId ? 'Предмет #' + itemId : 'Предмет без ID'),
      140,
    ),
    slotRaw: cleanText(item.slotRaw, 80) || null,
    itemLevelRaw: cleanText(item.itemLevelRaw, 80) || null,
    rarityRaw: cleanText(item.rarityRaw, 80) || null,
    qualityRaw: cleanText(item.qualityRaw, 80) || null,
    enhanceLevelRaw: cleanText(item.enhanceLevelRaw, 80) || null,
    affixCountRaw: cleanText(item.affixCountRaw, 40) || null,
    itemTypeRaw: cleanText(item.itemTypeRaw, 100) || null,
    sourceAction: cleanText(item.sourceAction, 80) || null,
    observedAt: Number.isFinite(Number(item.observedAt)) ? Number(item.observedAt) : null,
    confidence: cleanText(item.confidence, 80) || 'не указано',
    affixIds: [...new Set(normalizedAffixes.map((affix) => affix.id).filter(Boolean))],
    affixes: normalizedAffixes,
    values: deduped,
  };
}

function normalizeItems(input) {
  return (Array.isArray(input) ? input : [])
    .slice(0, MAX_ITEMS)
    .map(normalizeItem)
    .filter(Boolean);
}

function resourceIndexes(resourceIndex) {
  const itemRows = Array.isArray(resourceIndex?.itemDefinitions) ? resourceIndex.itemDefinitions : [];
  const affixRows = Array.isArray(resourceIndex?.affixDefinitions) ? resourceIndex.affixDefinitions : [];
  const localizationRows = Array.isArray(resourceIndex?.localizationEntries) ? resourceIndex.localizationEntries : [];
  const attributeRows = Array.isArray(resourceIndex?.attributeDefinitions) ? resourceIndex.attributeDefinitions : [];
  const makeEnumMap = (pattern) => {
    const map = new Map();
    for (const row of attributeRows) {
      const tableName = String(row.enumType || row.sourcePath || '');
      if (!pattern.test(tableName)) continue;
      for (const key of [row.enumId, row.valueRaw, row.id, row.rowName]) {
        if (key !== null && key !== undefined && String(key).trim()) map.set(String(key), row);
      }
    }
    return map;
  };
  const affixAttributeTypes = makeEnumMap(/affixattrtype/i);
  const characterAttributes = makeEnumMap(/gamecharattribute/i);
  const characterFields = makeEnumMap(/gamecharfield/i);
  const equipSlots = makeEnumMap(/gameequipslot|equipmentslot|equipslot/i);
  const rarities = makeEnumMap(/rarity|raretype/i);
  const qualities = makeEnumMap(/quality/i);
  return {
    imported: Boolean(resourceIndex && typeof resourceIndex === 'object'),
    items: new Map(itemRows.filter((row) => row?.id != null).map((row) => [String(row.id), row])),
    affixes: new Map(affixRows.filter((row) => row?.id != null).map((row) => [String(row.id), row])),
    localizations: new Map(localizationRows.filter((row) => row?.key != null).map((row) => [String(row.key), row])),
    affixAttributeTypes,
    characterAttributes,
    characterFields,
    equipSlots,
    rarities,
    qualities,
    itemDefinitionCount: itemRows.length,
    affixDefinitionCount: affixRows.length,
    localizationCount: localizationRows.length,
    attributeDefinitionCount: attributeRows.length,
  };
}

function localizedName(definition, indexes) {
  if (!definition) return null;
  const key = definition.nameKeyRaw || definition.textKeyRaw ||
    definition.descriptionKeyRaw || null;
  return key ? indexes.localizations.get(String(key))?.text || null : null;
}

function attachResourceKnowledge(item, indexes) {
  const itemDefinition = item.itemId ? indexes.items.get(String(item.itemId)) : null;
  const affixes = item.affixes.map((affix) => {
    const definition = affix.id ? indexes.affixes.get(String(affix.id)) : null;
    const attributeRaw = definition?.attributeRaw || affix.attributeRaw || null;
    const attributeDefinition = attributeRaw
      ? indexes.affixAttributeTypes.get(String(attributeRaw)) ||
        indexes.characterAttributes.get(String(attributeRaw)) ||
        indexes.characterFields.get(String(attributeRaw)) || null
      : null;
    const translatedName = localizedName(definition, indexes);
    const attributeName = attributeDefinition?.enumName ||
      attributeDefinition?.name ||
      localizedName(attributeDefinition, indexes) ||
      attributeDefinition?.rowName ||
      null;
    return {
      ...affix,
      catalogMatch: {
        matched: Boolean(definition),
        attributeMatched: Boolean(attributeDefinition),
        name: definition
          ? definition.name || translatedName || definition.rowName || null
          : null,
        nameSource: definition
          ? definition.name ? 'data-table' : translatedName ? 'localization-table' : 'row-key'
          : null,
        nameKeyRaw: definition?.nameKeyRaw || definition?.textKeyRaw || null,
        attributeRaw,
        attributeName,
        attributeSourcePath: attributeDefinition?.sourcePath || null,
        tierRaw: definition?.tierRaw || affix.tierRaw || null,
        minRaw: definition?.minRaw || null,
        maxRaw: definition?.maxRaw || null,
        sourcePath: definition?.sourcePath || null,
        rowPath: definition?.rowPath || null,
      },
    };
  });
  const translatedItemName = localizedName(itemDefinition, indexes);
  const slotDefinition = item.slotRaw ? indexes.equipSlots.get(String(item.slotRaw)) || null : null;
  const rarityDefinition = item.rarityRaw ? indexes.rarities.get(String(item.rarityRaw)) || null : null;
  const qualityDefinition = item.qualityRaw ? indexes.qualities.get(String(item.qualityRaw)) || null : null;
  return {
    ...item,
    slotName: slotDefinition?.enumName || slotDefinition?.name || localizedName(slotDefinition, indexes) || null,
    rarityName: rarityDefinition?.enumName || rarityDefinition?.name || localizedName(rarityDefinition, indexes) || null,
    qualityName: qualityDefinition?.enumName || qualityDefinition?.name || localizedName(qualityDefinition, indexes) || null,
    catalogItem: itemDefinition ? {
      matched: true,
      name: itemDefinition.name || translatedItemName || itemDefinition.rowName || null,
      nameSource: itemDefinition.name ? 'data-table' : translatedItemName ? 'localization-table' : 'row-key',
      nameKeyRaw: itemDefinition.nameKeyRaw || itemDefinition.textKeyRaw || null,
      slotRaw: itemDefinition.slotRaw || null,
      itemTypeRaw: itemDefinition.itemTypeRaw || null,
      sourcePath: itemDefinition.sourcePath || null,
      rowPath: itemDefinition.rowPath || null,
    } : { matched: false },
    affixes,
    catalogAffixMatches: affixes.filter((affix) => affix.catalogMatch.matched).length,
  };
}

function weightedCoverage(foundKeys, rules) {
  const totalWeight = rules.reduce((sum, rule) => sum + rule.weight, 0);
  const foundWeight = rules.reduce(
    (sum, rule) => sum + (foundKeys.has(rule.rawKey) ? rule.weight : 0),
    0,
  );

  return {
    totalWeight,
    foundWeight,
    percent: totalWeight ? Math.round((foundWeight / totalWeight) * 100) : null,
  };
}

/**
 * Analyse explicit affix fields only. Coverage is a match against user-owned
 * priorities, never an item power, build score, or DPS estimate.
 */
export function analyzeEquipment(itemsInput, prioritiesInput = [], resourceIndex = null) {
  const indexes = resourceIndexes(resourceIndex);
  const items = normalizeItems(itemsInput).map((item) => attachResourceKnowledge(item, indexes));
  const rules = normalizePriorityRules(prioritiesInput);
  const observed = new Map();

  for (const item of items) {
    for (const value of item.values) {
      const rows = observed.get(value.rawKey) || [];
      rows.push({
        ...value,
        itemId: item.itemId,
        itemName: item.name,
        slotRaw: item.slotRaw,
      });
      observed.set(value.rawKey, rows);
    }
  }

  const foundKeys = new Set(observed.keys());
  const total = weightedCoverage(foundKeys, rules);

  const ruleRows = rules.map((rule) => ({
    ...rule,
    status: foundKeys.has(rule.rawKey) ? 'observed' : 'not-observed',
    occurrences: (observed.get(rule.rawKey) || []).length,
    examples: (observed.get(rule.rawKey) || []).slice(0, 5).map((row) => ({
      itemId: row.itemId,
      itemName: row.itemName,
      slotRaw: row.slotRaw,
      value: row.value,
      affixId: row.affixId,
      attributeRaw: row.attributeRaw || null,
      catalogAffix: row.affixId ? indexes.affixes.get(String(row.affixId)) || null : null,
      catalogAttribute: row.attributeRaw ? indexes.attributes.get(String(row.attributeRaw)) || null : null,
    })),
  }));

  const itemRows = items.map((item) => {
    const itemKeys = new Set(item.values.map((row) => row.rawKey));
    const itemCoverage = weightedCoverage(itemKeys, rules);

    return {
      ...item,
      priorityCoveragePercent: itemCoverage.percent,
      matchedPriorities: rules.filter((rule) => itemKeys.has(rule.rawKey)).map((rule) => rule.rawKey),
      missingPriorities: rules.filter((rule) => !itemKeys.has(rule.rawKey)).map((rule) => rule.rawKey),
    };
  });

  return {
    available: items.length > 0,
    completeness: 'partial',
    currentFullGearConfirmed: false,
    source: 'CharacterIntel.explicitEquipment[].affixes[].values',
    resourceCatalog: {
      imported: indexes.imported,
      itemDefinitions: indexes.itemDefinitionCount,
      affixDefinitions: indexes.affixDefinitionCount,
      localizationEntries: indexes.localizationCount,
      attributeDefinitions: indexes.attributeDefinitionCount,
      matchedAttributes: items.reduce((sum, item) => sum + item.affixes.filter((affix) => affix.catalogMatch.attributeMatched).length, 0),
      matchedItems: items.filter((item) => item.catalogItem.matched).length,
      matchedAffixes: items.reduce((sum, item) => sum + item.catalogAffixMatches, 0),
    },
    itemCount: items.length,
    ruleCount: rules.length,
    priorityCoveragePercent: total.percent,
    foundWeight: total.foundWeight,
    totalWeight: total.totalWeight,
    rules: ruleRows,
    items: itemRows,
    weakSpots: ruleRows
      .filter((row) => row.status === 'not-observed')
      .map((row) => ({
        rawKey: row.rawKey,
        label: row.label,
        weight: row.weight,
        explanation: 'Поле не обнаружено среди доступных явных аффиксов. Это не доказывает, что характеристики нет на предмете.',
      })),
    recommendations: ruleRows
      .slice()
      .sort((a, b) => b.weight - a.weight)
      .map((row) => ({
        rawKey: row.rawKey,
        label: row.label,
        weight: row.weight,
        message: row.status === 'observed'
          ? 'Приоритет уже встречается в явных данных; сравни точные значения, если они однозначно доступны.'
          : 'При просмотре следующих предметов проверь наличие точного поля "' +
            row.rawKey + '"; Nexus пока его не наблюдал.',
      })),
    limitations: [
      'Анализируются только поля, явно сохранённые парсером в CharacterIntel.explicitEquipment.',
      'Набор явных объектов не подтверждён как полный или актуальный список всех надетых предметов.',
      'PageId/SlotId, снимки сумки и PutOn/PutOff не преобразуются в надетые слоты.',
      'Процент показывает совпадение с пользовательскими приоритетами, а не силу предмета, DPS или мета-рейтинг.',
      ...(rules.length ? [] : ['Задай собственные правила приоритета, чтобы получить процент совпадения.']),
      ...(items.length ? [] : ['В выбранном профиле пока нет явных объектов экипировки с ID и данными аффиксов.']),
    ],
  };
}

function parseNumericValue(value) {
  const match = String(value ?? '').trim().match(
    /^([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+))\s*(%|[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9/_-]*)?$/u,
  );
  if (!match) return null;

  const number = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(number)) return null;

  return { number, unit: (match[2] || '').toLocaleLowerCase('ru') };
}

function valuesForKey(item, rawKey) {
  return item.values
    .filter((row) => row.rawKey === rawKey)
    .map((row) => row.value);
}

/** Compare two items only where exact keys and compatible values exist. */
export function compareEquipment(leftInput, rightInput, prioritiesInput = [], resourceIndex = null) {
  const indexes = resourceIndexes(resourceIndex);
  const leftRaw = normalizeItem(leftInput, 0);
  const rightRaw = normalizeItem(rightInput, 1);
  const left = leftRaw ? attachResourceKnowledge(leftRaw, indexes) : null;
  const right = rightRaw ? attachResourceKnowledge(rightRaw, indexes) : null;
  const rules = normalizePriorityRules(prioritiesInput);

  if (!left || !right) {
    return {
      available: false,
      verdict: 'insufficient-data',
      message: 'Для сравнения нужны два корректных объекта предмета.',
      ruleResults: [],
      limitations: ['Данные двух предметов не переданы или имеют неверный формат.'],
    };
  }

  const ruleResults = rules.map((rule) => {
    const leftValues = valuesForKey(left, rule.rawKey);
    const rightValues = valuesForKey(right, rule.rawKey);
    const base = {
      ...rule,
      leftValue: leftValues.length === 1 ? leftValues[0] : null,
      rightValue: rightValues.length === 1 ? rightValues[0] : null,
      winner: null,
      delta: null,
      unit: null,
    };

    if (rule.direction === 'presence') {
      return {
        ...base,
        status: leftValues.length && rightValues.length
          ? 'both-observed'
          : leftValues.length
            ? 'left-only'
            : rightValues.length
              ? 'right-only'
              : 'neither-observed',
        explanation: 'Правило оценивает наличие поля; направление предпочтения не задано.',
      };
    }

    if (leftValues.length !== 1 || rightValues.length !== 1) {
      return {
        ...base,
        status: leftValues.length > 1 || rightValues.length > 1
          ? 'ambiguous'
          : leftValues.length || rightValues.length
            ? 'one-sided'
            : 'not-observed',
        explanation: 'Нет ровно одного значения этого поля на обоих предметах; сравнение по правилу невозможно.',
      };
    }

    const leftNumber = parseNumericValue(leftValues[0]);
    const rightNumber = parseNumericValue(rightValues[0]);
    if (!leftNumber || !rightNumber || leftNumber.unit !== rightNumber.unit) {
      return {
        ...base,
        status: 'not-comparable',
        explanation: 'Значения не являются совместимыми числами с одинаковыми единицами.',
      };
    }

    const delta = leftNumber.number - rightNumber.number;
    const preference = rule.direction === 'higher' ? Math.sign(delta) : -Math.sign(delta);

    return {
      ...base,
      status: delta === 0 ? 'equal' : 'compared',
      delta,
      unit: leftNumber.unit,
      winner: preference > 0 ? 'left' : preference < 0 ? 'right' : 'tie',
      explanation: delta === 0
        ? 'Значения равны.'
        : (rule.direction === 'higher' ? 'Большее' : 'Меньшее') +
          ' значение соответствует заданному тобой направлению.',
    };
  });

  let leftWeight = 0;
  let rightWeight = 0;
  let tieWeight = 0;
  let decidedWeight = 0;

  for (const row of ruleResults) {
    if (!['left', 'right', 'tie'].includes(row.winner)) continue;
    decidedWeight += row.weight;
    if (row.winner === 'left') leftWeight += row.weight;
    else if (row.winner === 'right') rightWeight += row.weight;
    else tieWeight += row.weight;
  }

  const totalWeight = rules.reduce((sum, rule) => sum + rule.weight, 0);
  const slotComparison = left.slotRaw && right.slotRaw
    ? {
        status: left.slotRaw === right.slotRaw ? 'same' : 'different',
        left: left.slotRaw,
        right: right.slotRaw,
      }
    : { status: 'unknown', left: left.slotRaw, right: right.slotRaw };

  const addedAffixIds = right.affixIds.filter((id) => !left.affixIds.includes(id));
  const removedAffixIds = left.affixIds.filter((id) => !right.affixIds.includes(id));

  let verdict = 'insufficient-data';
  if (decidedWeight && leftWeight > rightWeight) verdict = 'left';
  else if (decidedWeight && rightWeight > leftWeight) verdict = 'right';
  else if (decidedWeight && leftWeight === rightWeight) verdict = 'tie';

  return {
    available: true,
    left: {
      itemId: left.itemId,
      name: left.name,
      slotRaw: left.slotRaw,
      slotName: left.slotName || null,
      rarityName: left.rarityName || null,
      qualityName: left.qualityName || null,
      itemLevelRaw: left.itemLevelRaw,
      rarityRaw: left.rarityRaw,
      qualityRaw: left.qualityRaw,
      enhanceLevelRaw: left.enhanceLevelRaw,
      affixCountRaw: left.affixCountRaw,
      itemTypeRaw: left.itemTypeRaw,
      confidence: left.confidence,
      sourceAction: left.sourceAction,
      observedAt: left.observedAt,
    },
    right: {
      itemId: right.itemId,
      name: right.name,
      slotRaw: right.slotRaw,
      slotName: right.slotName || null,
      rarityName: right.rarityName || null,
      qualityName: right.qualityName || null,
      itemLevelRaw: right.itemLevelRaw,
      rarityRaw: right.rarityRaw,
      qualityRaw: right.qualityRaw,
      enhanceLevelRaw: right.enhanceLevelRaw,
      affixCountRaw: right.affixCountRaw,
      itemTypeRaw: right.itemTypeRaw,
      confidence: right.confidence,
      sourceAction: right.sourceAction,
      observedAt: right.observedAt,
    },
    resourceCatalog: {
      imported: indexes.imported,
      itemDefinitions: indexes.itemDefinitionCount,
      affixDefinitions: indexes.affixDefinitionCount,
      localizationEntries: indexes.localizationCount,
      attributeDefinitions: indexes.attributeDefinitionCount,
      leftItemMatched: left.catalogItem.matched,
      rightItemMatched: right.catalogItem.matched,
      leftAffixMatches: left.catalogAffixMatches,
      rightAffixMatches: right.catalogAffixMatches,
    },
    catalogAffixes: {
      left: left.affixes.map((affix) => ({ id: affix.id, ...affix.catalogMatch })),
      right: right.affixes.map((affix) => ({ id: affix.id, ...affix.catalogMatch })),
    },
    slotComparison,
    sharedAffixIds: left.affixIds.filter((id) => right.affixIds.includes(id)),
    addedAffixIds,
    removedAffixIds,
    ruleResults,
    score: {
      leftWeight,
      rightWeight,
      tieWeight,
      decidedWeight,
      totalWeight,
      coveragePercent: totalWeight
        ? Math.round((decidedWeight / totalWeight) * 100)
        : null,
    },
    verdict,
    explanation: verdict === 'left'
      ? 'Предмет A получил больший вес по сравнимым правилам, заданным тобой.'
      : verdict === 'right'
        ? 'Предмет B получил больший вес по сравнимым правилам, заданным тобой.'
        : verdict === 'tie'
          ? 'По сравнимым правилам результат равный.'
          : 'Недостаточно сопоставимых значений для вывода о преимуществе.',
    limitations: [
      'Сравниваются только точные совпадения ключей affix.values[].key.',
      'Оба предмета могут быть отдельными историческими наблюдениями; сравнение не подтверждает, что один из них сейчас надет.',
      'Несопоставимые, отсутствующие или повторяющиеся неоднозначные значения не получают победителя.',
      'Разница ID аффиксов показывается справочно и сама по себе не считается улучшением.',
      'Победитель определяется исключительно твоими правилами higher/lower и весами; универсальный рейтинг предмета не рассчитывается.',
    ],
  };
}
