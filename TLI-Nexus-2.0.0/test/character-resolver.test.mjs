import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCharacterIntelNames } from '../core/characterResolver.js';

test('resolves talent, item, slot and affix labels only by exact imported game IDs', () => {
  const intel = {
    talents: [{ id: '1001', name: null, nameKey: 'Talent.Power.Name', level: 1 }],
    explicitEquipment: [{
      itemId: 41001, name: 'Предмет #41001', slotRaw: '5',
      affixes: [{ id: '7001', values: [{ key: 'Value', value: '125' }] }],
    }],
  };
  const resources = {
    talentDefinitions: [{ id: '1001', nameKeyRaw: 'Talent.Power.Name', descriptionKeyRaw: 'Talent.Power.Desc' }],
    itemDefinitions: [{ id: '41001', name: 'Шлем испытаний', slotRaw: '5' }],
    affixDefinitions: [{ id: '7001', name: 'Максимальное здоровье', attributeRaw: '12', tierRaw: 'T2' }],
    attributeDefinitions: [
      { enumId: '5', enumType: 'GameEquipSlot', enumName: 'Шлем' },
      { enumId: '12', enumType: 'AffixAttrType', enumName: 'Здоровье' },
    ],
    localizationEntries: [
      { key: 'Talent.Power.Name', text: 'Сила атаки' },
      { key: 'Talent.Power.Desc', text: 'Увеличивает урон атаки' },
    ],
  };
  const result = resolveCharacterIntelNames(intel, resources);
  assert.equal(result.talents[0].name, 'Сила атаки');
  assert.equal(result.talents[0].description, 'Увеличивает урон атаки');
  assert.equal(result.explicitEquipment[0].name, 'Шлем испытаний');
  assert.equal(result.explicitEquipment[0].slotName, 'Шлем');
  assert.equal(result.explicitEquipment[0].affixes[0].name, 'Максимальное здоровье');
  assert.equal(result.explicitEquipment[0].affixes[0].attributeName, 'Здоровье');
  assert.equal(result.catalogResolution.resolvedTalents, 1);
  assert.equal(result.catalogResolution.resolvedItems, 1);
  assert.equal(result.catalogResolution.resolvedAffixes, 1);
});

test('does not fabricate labels for unknown IDs', () => {
  const result = resolveCharacterIntelNames({
    talents: [{ id: '9999', name: null }],
    explicitEquipment: [{ itemId: 9999, name: 'Предмет #9999', affixes: [{ id: '8888' }] }],
  }, { talentDefinitions: [], itemDefinitions: [], affixDefinitions: [], attributeDefinitions: [], localizationEntries: [] });
  assert.equal(result.talents[0].name, null);
  assert.equal(result.explicitEquipment[0].name, 'Предмет #9999');
  assert.equal(result.explicitEquipment[0].affixes[0].name, null);
  assert.equal(result.catalogResolution.resolvedTalents, 0);
});
