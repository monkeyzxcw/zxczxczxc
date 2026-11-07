import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CharacterIntel } from '../core/characterIntel.js';
import { LiveService } from '../core/liveService.js';
import { normalizeBuild, compareBuilds, encodeBuild, decodeBuild } from '../core/buildAnalysis.js';

const stamp = '2026.11.07-10.00.00:000';
function msg(action, body, time = stamp, kind = 'RecvMessage') {
  return { action, kind, time, synId: '7', body, truncated: false };
}
function playerBody(overrides = []) {
  return [
    '+player+PlayerId [123456789]',
    '+player+SeasonId [1401]',
    '+player+Name [NexusTest]',
    '+player+HeroId [1300]',
    '+player+HeroName [Test Hero]',
    '+player+Level [94]',
    '+player+SpecializationId [77]',
    '+player+SpecializationName [Test Spec]',
    '+player+MaxLife [12345]',
    '+player+MaxMana [709]',
    '+player+FireResistance [75]',
    '+player+skills+1+SkillId [501]',
    '+player+skills+1+SkillLevel [20]',
    '+player+talents+1+TalentNodeId [201]',
    '+player+talents+1+TalentLevel [3]',
    ...overrides,
  ];
}

test('CharacterIntel restores player identity from explicit GetPlayerData fields', () => {
  const intel = new CharacterIntel();
  const result = intel.ingestMessage(msg('GetPlayerData', playerBody()));
  const snapshot = intel.snapshot();
  assert.equal(result.changed, true);
  assert.equal(snapshot.identity.name, 'NexusTest');
  assert.equal(snapshot.identity.playerId, '123456789');
  assert.equal(snapshot.identity.seasonId, 1401);
  assert.equal(snapshot.identity.heroId, '1300');
  assert.equal(snapshot.identity.heroName, 'Test Hero');
  assert.equal(snapshot.identity.level, 94);
  assert.equal(snapshot.identity.specializationId, '77');
  assert.equal(snapshot.identity.specializationName, 'Test Spec');
  assert.equal(snapshot.identity.sourceAction, 'GetPlayerData');
});

test('CharacterIntel maps only explicit numeric stat names and preserves provenance', () => {
  const intel = new CharacterIntel();
  intel.ingestMessage(msg('GetPlayerData', playerBody(['+player+SomeUnknownValue [777]'])));
  const snapshot = intel.snapshot();
  assert.equal(snapshot.stats.find((x) => x.key === 'life').value, 12345);
  assert.equal(snapshot.stats.find((x) => x.key === 'mana').value, 709);
  assert.equal(snapshot.stats.find((x) => x.key === 'fireRes').value, 75);
  assert.equal(snapshot.stats.find((x) => x.key === 'life').path, 'player.MaxLife');
  assert.equal(snapshot.stats.find((x) => x.key === 'life').sourceAction, 'GetPlayerData');
  assert.equal(snapshot.stats.some((x) => x.key === 'someUnknownValue'), false);
  assert.ok(snapshot.fieldSchema.some((x) => x.path === 'player.SomeUnknownValue'));
});

test('CharacterIntel extracts explicit skill and talent IDs without mistaking hero traits for talent nodes', () => {
  const intel = new CharacterIntel();
  intel.ingestMessage(msg('GetPlayerData', playerBody(['+player+HeroTraitId [9999]'])));
  const snapshot = intel.snapshot();
  assert.deepEqual(snapshot.skills.map((x) => x.id), ['501']);
  assert.equal(snapshot.skills[0].level, 20);
  assert.deepEqual(snapshot.talents.map((x) => x.id), ['201']);
  assert.equal(snapshot.talents[0].level, 3);
  assert.equal(snapshot.talents.some((x) => x.id === '9999'), false);
});

test('CharacterIntel stores inventory snapshots separately from equipped items and keeps item details', () => {
  const intel = new CharacterIntel();
  intel.ingestMessage(msg('ResetItemsLayout', [
    '+items+1+Item+BaseId [5028]',
    '+items+1+Item+Num [2]',
    '+items+1+Item+AffixNum [3]',
    '+items+1+Item+ItemLevel [86]',
    '+items+1+Item+RareValue [3]',
    '+items+1+Item+Quality [12]',
    '+items+1+Item+EnhanceLevel [4]',
    '+items+1+Item+BaseAffix+1+Id [900]',
    '+items+1+Item+BaseAffix+1+AttrType [12]',
    '+items+1+Item+BaseAffix+1+Value [135]',
    '+items+1+Item+BaseAffix+1+Tier [2]',
  ], '2026.11.07-10.00.05:000'));
  const snapshot = intel.snapshot();
  assert.equal(snapshot.latestInventory.action, 'ResetItemsLayout');
  assert.equal(snapshot.latestInventory.items.length, 1);
  assert.equal(snapshot.latestInventory.items[0].itemId, 5028);
  assert.equal(snapshot.latestInventory.items[0].count, 2);
  assert.ok(snapshot.latestInventory.items[0].details.some((x) => x.key === 'AffixNum'));
  assert.equal(snapshot.latestInventory.items[0].itemLevelRaw, '86');
  assert.equal(snapshot.latestInventory.items[0].rarityRaw, '3');
  assert.equal(snapshot.latestInventory.items[0].qualityRaw, '12');
  assert.equal(snapshot.latestInventory.items[0].enhanceLevelRaw, '4');
  assert.equal(snapshot.latestInventory.items[0].affixes[0].id, '900');
  assert.ok(snapshot.latestInventory.items[0].affixes[0].values.some((x) => x.key === 'Value' && x.value === '135'));
  assert.equal(Object.hasOwn(snapshot.latestInventory.items[0], 'slot'), false);
  assert.equal(snapshot.sections.inventory.status, 'observed');
  assert.match(snapshot.limitations.join(' '), /не доказательство надетых слотов/);
});

test('CharacterIntel ignores client SendMessage as an authoritative player snapshot', () => {
  const intel = new CharacterIntel();
  const result = intel.ingestMessage(msg('GetPlayerData', playerBody(), stamp, 'SendMessage'));
  assert.equal(result.identity, null);
  assert.equal(intel.snapshot().identity, null);
});

test('CharacterIntel merge keeps newer observations and de-duplicates same timestamp snapshots', () => {
  const oldIntel = new CharacterIntel();
  oldIntel.ingestMessage(msg('GetPlayerData', playerBody(), '2026.11.07-10.00.00:000'));
  oldIntel.ingestMessage(msg('ResetItemsLayout', ['+items+1+Item+BaseId [5028]', '+items+1+Item+Num [1]'], '2026.11.07-10.00.02:000'));
  const newIntel = new CharacterIntel();
  newIntel.ingestMessage(msg('GetPlayerData', playerBody(['+player+MaxLife [15000]']), '2026.11.07-10.00.03:000'));
  oldIntel.merge(newIntel);
  const snapshot = oldIntel.snapshot();
  assert.equal(snapshot.stats.find((x) => x.key === 'life').value, 15000);
  assert.equal(snapshot.inventorySnapshots.length, 1);
  assert.equal(snapshot.messagesAnalyzed, 2);
});

test('LiveService historical scan restores CharacterIntel from a synthetic UE_game.log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-character-intel-'));
  const file = path.join(dir, 'UE_game.log');
  const lines = [];
  const writeMessage = (action, synId, body, time) => {
    lines.push(`[${time}][1]TLNetGame: Display: [Game] ----Socket RecvMessage STT----${action}----SynId = ${synId}`);
    lines.push(`[${time}][1]TLNetGame: Display: [Game] `);
    lines.push(...body);
    lines.push(`[${time}][1]TLNetGame: Display: [Game] ----Socket RecvMessage End----`);
  };
  writeMessage('GetPlayerData', '1', playerBody(), '2026.11.07-10.00.00:000');
  writeMessage('ResetItemsLayout', '2', ['+items+1+Item+BaseId [5028]', '+items+1+Item+Num [2]'], '2026.11.07-10.00.05:000');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  const service = new LiveService();
  try {
    await service.attach(file, 'manual');
    const state = service.snapshot();
    assert.equal(state.player, 'NexusTest');
    assert.equal(state.characterIntel.identity.level, 94);
    assert.equal(state.characterIntel.stats.find((x) => x.key === 'life').value, 12345);
    assert.equal(state.characterIntel.skills[0].id, '501');
    assert.equal(state.characterIntel.talents[0].id, '201');
    assert.equal(state.characterIntel.latestInventory.items[0].itemId, 5028);
    assert.ok(state.characterScan.messages >= 2);
  } finally {
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('observed CharacterIntel stat provenance survives build normalize and NEXUS1 import/export', () => {
  const observedStats = [{ key: 'life', value: 12345, rawKey: 'MaxLife', path: 'player.MaxLife',
    sourceAction: 'GetPlayerData', sourceKind: 'RecvMessage', observedAt: Date.now(), confidence: 'explicit-field' }];
  const build = normalizeBuild({ name: 'Nexus restore', stats: { life: 12345 }, observedStats });
  assert.equal(build.observedStats[0].path, 'player.MaxLife');
  assert.equal(build.observedStats[0].sourceAction, 'GetPlayerData');
  const roundTrip = decodeBuild(encodeBuild(build));
  assert.equal(roundTrip.observedStats[0].confidence, 'explicit-field');
  const changed = compareBuilds(build, { ...build, observedStats: [{ ...observedStats[0], value: 14000 }] });
  assert.ok(changed.some((x) => x.key === 'observedStats'));
});


test('CharacterIntel does not mistake item affixes for the character stat sheet', () => {
  const intel = new CharacterIntel();
  intel.ingestMessage(msg('ResetItemsLayout', [
    '+items+1+Item+BaseId [5028]',
    '+items+1+Item+MaxLife [9999]',
    '+items+1+Item+Num [1]',
  ]));
  assert.equal(intel.snapshot().stats.length, 0);
});
