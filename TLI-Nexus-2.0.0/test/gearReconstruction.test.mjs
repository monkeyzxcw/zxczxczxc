import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstructObservedGear } from '../core/gearReconstruction.js';

test('reconstructs only explicit equipped items with recognized textual slots', () => {
  const result = reconstructObservedGear({ explicitEquipment: [
    { itemId: 101, name: 'Helmet A', slotRaw: 'Helmet', observedAt: 10, affixes: [] },
    { itemId: 102, name: 'Ring A', slotRaw: 'Ring1', observedAt: 11, affixes: [] },
    { itemId: 103, name: 'Unknown slot', slotRaw: '7', observedAt: 12, affixes: [] },
  ] });
  assert.equal(result.gear.length, 2);
  assert.deepEqual(result.gear.map((x) => x.slot).sort(), ['helmet', 'ring1']);
  assert.equal(result.coverage.unresolvedSlots, 1);
  assert.equal(result.coverage.effectiveEngineItems, 0);
  assert.ok(result.warnings.some((x) => x.includes('слот не удалось подтвердить')));
});

test('uses latest observed item per slot and forwards only explicit complete modifier lines', () => {
  const result = reconstructObservedGear({ explicitEquipment: [
    { itemId: 101, name: 'Old Helmet', slotRaw: 'Helmet', observedAt: 10, affixes: [] },
    { itemId: 102, name: 'New Helmet', slotRaw: 'Helmet', observedAt: 20, affixes: [
      { id: 'affix-1', values: [{ key: 'ModifierText', value: '+12% Max Life' }] },
    ] },
  ] });
  assert.equal(result.gear.length, 1);
  assert.equal(result.gear[0].item_name, 'New Helmet');
  assert.deepEqual(result.gear[0].unresolved_texts, ['+12% Max Life']);
  assert.equal(result.coverage.itemsWithRawAffixLines, 1);
  assert.equal(result.coverage.effectiveEngineItems, 1);
});

test('does not turn scalar affix values or unknown IDs into fake engine stats', () => {
  const result = reconstructObservedGear({ explicitEquipment: [
    { itemId: 101, name: 'Chest', slotRaw: 'Chest', observedAt: 10, affixes: [
      { id: 'unknown-affix-id', values: [{ key: 'Value', value: '123' }, { key: 'Tier', value: '2' }] },
    ] },
  ] });
  assert.deepEqual(result.gear[0].contributions, []);
  assert.equal(result.gear[0].unresolved_texts, undefined);
  assert.ok(result.warnings.some((x) => x.includes('ID аффиксов')));
  assert.equal(result.coverage.effectiveEngineItems, 0);
});

test('manual GearEngineItem config overrides auto observations to avoid duplicate items', () => {
  const manual = [{ contributions: [{ stat: 'max_life', display_value: 100, unit: '', item_name: 'Manual', slot: 'helmet' }] }];
  const result = reconstructObservedGear({ explicitEquipment: [
    { itemId: 101, name: 'Observed', slotRaw: 'Helmet', observedAt: 10, affixes: [] },
  ] }, manual);
  assert.equal(result.gear, manual);
  assert.equal(result.coverage.source, 'manual-engine-config');
  assert.ok(result.warnings.some((x) => x.includes('ручной engineConfig.gear')));
  assert.equal(result.coverage.effectiveEngineItems, 1);
});

test('keeps explicit legendary grants and belt blend without inventing either', () => {
  const result = reconstructObservedGear({ explicitEquipment: [
    { itemId: 101, name: 'Belt', slotRaw: 'Belt', observedAt: 10, affixes: [],
      grantedTalents: ['[Test Talent]'], beltBlend: 'blend-id' },
  ] });
  assert.deepEqual(result.gear[0].granted_talents, ['[Test Talent]']);
  assert.equal(result.gear[0].belt_blend, 'blend-id');
  assert.equal(result.coverage.effectiveEngineItems, 1);
});
