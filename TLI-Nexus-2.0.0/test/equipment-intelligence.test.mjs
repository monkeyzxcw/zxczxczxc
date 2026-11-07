import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePriorityRules,
  analyzeEquipment,
  compareEquipment,
} from '../core/equipmentIntelligence.js';

const item = (itemId, name, affixes, slotRaw = null) => ({
  itemId,
  name,
  slotRaw,
  confidence: 'explicit-equipment-id-and-slot',
  affixes,
});

const affix = (id, values) => ({
  id: String(id),
  values: Object.entries(values).map(([key, value]) => ({
    key,
    value: String(value),
  })),
});

test('priority rules require explicit user key, direction and bounded weight', () => {
  const rules = normalizePriorityRules([
    { rawKey: 'LifeFlat', label: 'Жизнь', weight: 8, direction: 'higher' },
    { rawKey: 'Bad', label: 'Неизвестно', weight: 2, direction: 'random' },
    { rawKey: 'LifeFlat', label: 'Жизнь для билда', weight: 3, direction: 'выше' },
  ]);

  assert.deepEqual(rules, [{
    rawKey: 'LifeFlat',
    label: 'Жизнь для билда',
    weight: 3,
    direction: 'higher',
  }]);
});

test('analysis reports user-priority coverage and does not invent absent stats', () => {
  const gear = [
    item(1001, 'Шлем A', [
      affix(77, { LifeFlat: 120, UnknownRawField: 4, AffixId: 77 }),
    ], 'Head'),
  ];
  const result = analyzeEquipment(
    gear,
    'LifeFlat | Жизнь | 5 | higher\nMoveSpeedRaw | Скорость | 2 | higher',
  );

  assert.equal(result.available, true);
  assert.equal(result.priorityCoveragePercent, 71);
  assert.equal(result.items[0].priorityCoveragePercent, 71);
  assert.equal(result.currentFullGearConfirmed, false);
  assert.equal(result.rules[0].status, 'observed');
  assert.equal(result.rules[0].examples[0].value, '120');
  assert.ok(!result.items[0].values.some((field) => field.rawKey === 'AffixId'));
  assert.equal(result.weakSpots[0].rawKey, 'MoveSpeedRaw');
  assert.match(result.weakSpots[0].explanation, /не доказывает/);
  assert.equal('dps' in result, false);
});

test('comparison follows only user-chosen higher/lower directions and exact keys', () => {
  const left = item(1, 'Предмет A', [
    affix(10, { LifeFlat: 140, FireResRaw: '12%' }),
  ], 'Head');
  const right = item(2, 'Предмет B', [
    affix(11, { LifeFlat: 110, FireResRaw: '18%' }),
  ], 'Head');

  const result = compareEquipment(
    left,
    right,
    'LifeFlat | Жизнь | 3 | higher\nFireResRaw | Огонь | 2 | lower',
  );

  assert.equal(result.verdict, 'left');
  assert.equal(result.ruleResults[0].winner, 'left');
  assert.equal(result.ruleResults[0].delta, 30);
  assert.equal(result.ruleResults[1].winner, 'left');
  assert.equal(result.ruleResults[1].delta, -6);
  assert.equal(result.slotComparison.status, 'same');
  assert.deepEqual(result.addedAffixIds, ['11']);
  assert.deepEqual(result.sharedAffixIds, []);
});

test('comparison refuses mixed units, missing values and ambiguous duplicates', () => {
  const left = item(1, 'A', [
    affix(1, { Roll: '10%', Ambiguous: 4 }),
    affix(2, { Ambiguous: 6 }),
  ]);
  const right = item(2, 'B', [
    affix(3, { Roll: '12', Ambiguous: 5 }),
  ]);

  const result = compareEquipment(
    left,
    right,
    'Roll | Ролл | 2 | higher\nAmbiguous | Дубль | 3 | higher\nMissing | Пропуск | 1 | higher',
  );

  assert.equal(result.ruleResults[0].status, 'not-comparable');
  assert.equal(result.ruleResults[1].status, 'ambiguous');
  assert.equal(result.ruleResults[2].status, 'not-observed');
  assert.equal(result.verdict, 'insufficient-data');
});

test('presence rules never imply a preferred item', () => {
  const left = item(1, 'A', [affix(1, { Desired: 1 })]);
  const right = item(2, 'B', []);
  const result = compareEquipment(
    left,
    right,
    'Desired | Желаемый эффект | 5 | presence',
  );

  assert.equal(result.ruleResults[0].status, 'left-only');
  assert.equal(result.ruleResults[0].winner, null);
  assert.equal(result.verdict, 'insufficient-data');
});

test('identical values duplicated across separate affixes remain ambiguous', () => {
  const left = item(1, 'A', [
    affix(1, { Roll: 10 }),
    affix(2, { Roll: 10 }),
  ]);
  const right = item(2, 'B', [affix(3, { Roll: 10 })]);
  const result = compareEquipment(
    left,
    right,
    'Roll | Ролл | 2 | higher',
  );

  assert.equal(result.ruleResults[0].status, 'ambiguous');
  assert.equal(result.ruleResults[0].winner, null);
  assert.equal(result.verdict, 'insufficient-data');
});

test('imported game DataTables resolve raw affix IDs to verified names and ranges', () => {
  const gear = item(41001, 'Шлем с явным аффиксом', [
    {
      id: '7001',
      name: null,
      tierRaw: null,
      attributeRaw: null,
      values: [{ key: 'LifeFlat', value: '135' }],
    },
  ], 'Head');
  const resourceIndex = {
    itemDefinitions: [{
      id: '41001',
      name: null,
      nameKeyRaw: 'Item.Helm.Name',
      slotRaw: 'Head',
      itemTypeRaw: 'Helmet',
      sourcePath: 'Content/Data/DT_EquipmentBase.json',
    }],
    localizationEntries: [
      { key: 'Item.Helm.Name', text: 'Шлем из таблицы' },
      { key: 'Affix.Life.Name', text: 'Дополнительное здоровье' },
    ],
    affixDefinitions: [{
      id: '7001',
      name: null,
      nameKeyRaw: 'Affix.Life.Name',
      attributeRaw: '12',
      tierRaw: '2',
      minRaw: '100',
      maxRaw: '150',
      sourcePath: 'Content/Data/DT_EquipmentAffix.json',
    }],
  };

  const analysis = analyzeEquipment([gear], 'LifeFlat | Жизнь | 5 | higher', resourceIndex);
  assert.equal(analysis.resourceCatalog.imported, true);
  assert.equal(analysis.resourceCatalog.affixDefinitions, 1);
  assert.equal(analysis.resourceCatalog.localizationEntries, 2);
  assert.equal(analysis.resourceCatalog.matchedAffixes, 1);
  assert.equal(analysis.items[0].catalogItem.name, 'Шлем из таблицы');
  assert.equal(analysis.items[0].catalogItem.nameSource, 'localization-table');
  assert.equal(analysis.items[0].affixes[0].catalogMatch.name, 'Дополнительное здоровье');
  assert.equal(analysis.items[0].affixes[0].catalogMatch.nameSource, 'localization-table');
  assert.equal(analysis.items[0].affixes[0].catalogMatch.minRaw, '100');
  assert.equal(analysis.items[0].affixes[0].catalogMatch.maxRaw, '150');

  const comparison = compareEquipment(
    gear,
    item(41002, 'Предмет B', [{ id: '9999', values: [{ key: 'LifeFlat', value: '120' }] }], 'Head'),
    'LifeFlat | Жизнь | 5 | higher',
    resourceIndex,
  );
  assert.equal(comparison.catalogAffixes.left[0].name, 'Дополнительное здоровье');
  assert.equal(comparison.catalogAffixes.right[0].matched, false);
});

test('empty evidence returns an unavailable analysis, not a fabricated rating', () => {
  const result = analyzeEquipment([], 'LifeFlat | Жизнь | 5 | higher');

  assert.equal(result.available, false);
  assert.equal(result.priorityCoveragePercent, 0);
  assert.ok(result.limitations.some((line) => line.includes('нет явных объектов')));
});
