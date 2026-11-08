import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTliBuilderRequest } from '../core/tliBuilderAdapter.js';

test('maps only explicit skill ids and numeric slots from character intel', () => {
  const { payload, coverage } = buildTliBuilderRequest({
    build: { level: 90, mainSkill: 'Main Slash' },
    intel: { skills: [
      { id: 'skill_main_01', name: 'Main Slash', slot: '1', level: 20, levelField: 'SkillLevel' },
      { id: 'skill_support_02', name: 'Support Skill', slot: '6', level: 15, levelField: 'SkillLevel' },
      { id: 'unknown_slot', name: 'Unknown', slot: 'passive', level: 10 },
    ], talents: [{ id: 'talent_1' }], stats: [] },
  });
  assert.deepEqual(payload.skills, [
    { slot: 1, skill_id: 'skill_main_01', level: 20, enabled: true },
    { slot: 6, skill_id: 'skill_support_02', level: 15, enabled: true },
  ]);
  assert.deepEqual(payload.main_skill, { skill_id: 'skill_main_01', level: 20 });
  assert.equal(payload.slots.length, 0);
  assert.equal(coverage.skills.mainSkillMapped, true);
  assert.equal(coverage.readyForDps, false);
  assert.ok(coverage.warnings.some((x) => x.includes('Деревья талантов не восстановлены')));
});

test('does not invent tree nodes or gear from plain text lists', () => {
  const { payload, coverage } = buildTliBuilderRequest({
    build: { level: 90, mainSkill: 'Fire Slash', gearSlots: ['Weapon: Legendary Sword'], talents: ['+10% damage'] },
    intel: { skills: [{ id: 'skill_1', name: 'Fire Slash', slot: '1', level: 20, levelField: 'SkillLevel' }],
      explicitEquipment: [{ itemId: 1001, slotRaw: null, affixes: [] }],
      talents: [{ id: 'talent_9' }] },
  });
  assert.deepEqual(payload.slots, []);
  assert.deepEqual(payload.gear, []);
  assert.equal(coverage.equipment.observedExplicitItems, 1);
  assert.equal(coverage.equipment.engineItems, 0);
  assert.equal(coverage.talents.observedIds, 1);
  assert.equal(coverage.talents.configuredNodes, 0);
});

test('accepts explicit engine config for talent tree, gear, conditions and supports', () => {
  const engineConfig = {
    slots: [{ treeName: 'combat_tree', nodeStates: { node_1: 1 } }],
    gear: [{ contributions: [{ stat: 'life_flat', display_value: 100, unit: '', condition: null }] }],
    main_skill: { skill_id: 'skill_1', level: 20 },
    skills: [{ slot: 1, skill_id: 'skill_1', level: 20 }],
    condition_state: { enemy_boss: true },
  };
  const { payload, coverage } = buildTliBuilderRequest({
    build: { level: 90, engineConfig },
    intel: { skills: [] },
  });
  assert.deepEqual(payload.slots[0].nodeStates, { node_1: 1 });
  assert.deepEqual(payload.gear, engineConfig.gear);
  assert.deepEqual(payload.condition_state, { enemy_boss: true });
  assert.equal(coverage.talents.configuredNodes, 1);
  assert.equal(coverage.readyForDps, true);
});

test('maps observed talent game IDs into the exact season tree', () => {
  const { payload, coverage } = buildTliBuilderRequest({
    build: { level: 90 },
    intel: {
      talents: [{ id: 'talent_game_55', idField: 'TalentNodeId', level: 2, levelField: 'NodeLevel' }],
      skills: [],
    },
    catalogs: {
      season: 'SS14 Tartarus',
      skills: [],
      trees: [{ name: 'Combat Tree', nodes: [
        { id: 'node_internal_55', game_id: 'talent_game_55' },
      ] }],
    },
  });
  assert.deepEqual(payload.slots, [
    { treeName: 'Combat Tree', nodeStates: { node_internal_55: 2 } },
  ]);
  assert.equal(coverage.talents.configuredNodes, 1);
  assert.equal(coverage.talents.configuredTrees, 1);
});

test('resolves an observed main skill name through the active catalog without inventing an equipped skill', () => {
  const { payload, coverage } = buildTliBuilderRequest({
    build: { mainSkill: 'Catalog Blade' },
    intel: { skills: [{ id: 'skill_catalog_1', slot: '1', level: 18, levelField: 'SkillLevel' }] },
    catalogs: { skills: [{ id: 'skill_catalog_1', name: 'Catalog Blade' }], trees: [] },
  });
  assert.deepEqual(payload.main_skill, { skill_id: 'skill_catalog_1', level: 18 });
  assert.equal(coverage.skills.mainSkillMapped, true);
});

test('does not treat generic Level as a confirmed talent point count', () => {
  const { payload, coverage } = buildTliBuilderRequest({
    intel: { talents: [{ id: 'game_node_1', level: 4, levelField: 'Level' }] },
    catalogs: { trees: [{ name: 'Tree A', nodes: [{ id: 'node_a', game_id: 'game_node_1' }] }] },
  });
  assert.deepEqual(payload.slots, [{ treeName: 'Tree A', nodeStates: { node_a: 1 } }]);
  assert.ok(coverage.warnings.some((warning) => warning.includes('TalentLevel/NodeLevel')));
});

test('passes authoritative observed equipment and raw modifier text to GearEngineItem', () => {
  const { payload, coverage } = buildTliBuilderRequest({
    build: { mainSkill: 'Slash' },
    intel: {
      skills: [{ id: 'skill_1', name: 'Slash', slot: '1', level: 20, levelField: 'SkillLevel' }],
      talents: [{ id: 'talent_game_1', level: 1, levelField: 'TalentLevel' }],
      explicitEquipment: [{
        itemId: 9001, name: 'Observed Helmet', slotRaw: 'Helmet',
        sourceAction: 'GetPlayerData', sourceKind: 'Recv', observedAt: 100,
        affixes: [{ values: [{ key: 'RawText', value: '+12% Max Life' }] }],
      }],
    },
    catalogs: {
      skills: [{ id: 'skill_1', name: 'Slash' }],
      trees: [{ name: 'Tree A', nodes: [{ id: 'node_1', game_id: 'talent_game_1' }] }],
    },
  });
  assert.equal(payload.gear.length, 1);
  assert.equal(payload.gear[0].item_name, 'Observed Helmet');
  assert.equal(payload.gear[0].slot, 'helmet');
  assert.deepEqual(payload.gear[0].unresolved_texts, ['+12% Max Life']);
  assert.equal(coverage.equipment.recognizedSlots, 1);
  assert.equal(coverage.equipment.effectiveEngineItems, 1);
  assert.equal(coverage.readyForDps, true);
  assert.ok(coverage.warnings.some((x) => x.includes('Поддержки активных навыков пока не восстановлены')));
});
