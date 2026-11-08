import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTliBuilderRequest } from '../core/tliBuilderAdapter.js';

test('maps only explicit skill ids and numeric slots from character intel', () => {
  const { payload, coverage } = buildTliBuilderRequest({
    build: { level: 90, mainSkill: 'Main Slash' },
    intel: { skills: [
      { id: 'skill_main_01', name: 'Main Slash', slot: '1', level: 20 },
      { id: 'skill_support_02', name: 'Support Skill', slot: '6', level: 15 },
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
  assert.ok(coverage.warnings.some((x) => x.includes('Деревья талантов не переданы')));
});

test('does not invent tree nodes or gear from plain text lists', () => {
  const { payload, coverage } = buildTliBuilderRequest({
    build: { level: 90, mainSkill: 'Fire Slash', gearSlots: ['Weapon: Legendary Sword'], talents: ['+10% damage'] },
    intel: { skills: [{ id: 'skill_1', name: 'Fire Slash', slot: '1', level: 20 }],
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
      talents: [{ id: 'talent_game_55', idField: 'TalentNodeId', level: 2 }],
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
