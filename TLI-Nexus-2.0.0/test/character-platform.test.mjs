import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CharacterIntel } from '../core/characterIntel.js';
import { createCharacterProfileFromIdentity, findCharacterProfile, captureProfileCharacterSnapshot } from '../core/characterProfiles.js';
import { appendCharacterSnapshot, compareCharacterSnapshots, createCharacterSnapshot } from '../core/snapshotHistory.js';
import { buildAnonymizedDiagnostic, buildCharacterReport } from '../core/characterReport.js';
import { mergeAppData, mergeRendererUpdate } from '../core/persistence.js';

const stamp = '2026.11.07-12.00.00:000';
const msg = (action, body, time = stamp) => ({ action, kind: 'RecvMessage', time, synId: '2', body, truncated: false });
const player = [
  '+player+PlayerId [998877]', '+player+SeasonId [1401]', '+player+Name [NexusRosa]',
  '+player+HeroId [1300]', '+player+HeroName [LightbringerRose]', '+player+Level [96]',
  '+player+SpecializationId [77]', '+player+SpecializationName [UnsulliedBlade]',
  '+player+MaxLife [14500]', '+player+MaxMana [800]', '+player+FireResistance [75]',
  '+player+skills+1+SkillId [501]', '+player+talents+1+TalentNodeId [201]',
];

function intelWithPlayer() {
  const intel = new CharacterIntel();
  intel.ingestMessage(msg('GetPlayerData', player));
  return intel;
}

test('CharacterIntel extracts only explicit equipped item objects and preserves raw slot plus affix IDs', () => {
  const intel = intelWithPlayer();
  intel.ingestMessage(msg('GetPlayerData', [
    '+player+equipment+1+ItemBaseId [5028]',
    '+player+equipment+1+EquipmentSlot [MainHand]',
    '+player+equipment+1+Affixes+1+BaseAffixId [9001]',
    '+player+equipment+1+Affixes+1+AffixValue [42]',
  ], '2026.11.07-12.00.05:000'));
  const snapshot = intel.snapshot();
  assert.equal(snapshot.explicitEquipment.length, 1);
  const item = snapshot.explicitEquipment[0];
  assert.equal(item.itemId, 5028);
  assert.equal(item.slotRaw, 'MainHand');
  assert.equal(item.confidence, 'explicit-equipment-id-and-slot');
  assert.equal(item.affixes[0].id, '9001');
  assert.ok(item.affixes[0].values.some((x) => x.key === 'AffixValue' && x.value === '42'));
  assert.equal(snapshot.sections.equipment.status, 'observed');
  assert.equal(snapshot.totalSections, 6);
});

test('inventory snapshot is never misclassified as explicit equipped gear', () => {
  const intel = new CharacterIntel();
  intel.ingestMessage(msg('ResetItemsLayout', ['+items+1+Item+BaseId [5028]', '+items+1+Item+Num [1]']));
  const snapshot = intel.snapshot();
  assert.equal(snapshot.explicitEquipment.length, 0);
  assert.equal(snapshot.latestInventory.items[0].itemId, 5028);
  assert.equal(snapshot.sections.inventory.status, 'observed');
  assert.equal(snapshot.sections.equipment.status, 'missing');
});

test('explicit equipment parser does not extract IDs from non-equipment branches', () => {
  const intel = new CharacterIntel();
  intel.ingestMessage(msg('GetPlayerData', [
    '+player+inventory+1+ItemBaseId [5028]',
    '+player+skills+1+SkillId [501]',
    '+player+equipment+1+ItemBaseId [7777]',
  ]));
  assert.deepEqual(intel.snapshot().explicitEquipment.map((x) => x.itemId), [7777]);
});

test('player profile auto-creation is keyed by PlayerId and season, not display name alone', () => {
  const identity = { playerId: '998877', name: 'NexusRosa', seasonId: 1401, heroId: '1300', heroName: 'Rose', level: 96 };
  const profile = createCharacterProfileFromIdentity(identity, 12345);
  assert.equal(profile.id, 'char_998877_ss1401');
  assert.equal(profile.playerId, '998877');
  assert.equal(profile.season, 'SS14');
  assert.equal(profile.level, 96);
  assert.equal(findCharacterProfile([profile], 'NexusRosa', 1401, '998877').id, profile.id);
  assert.equal(findCharacterProfile([profile], 'NexusRosa', 1501, '998877'), null, 'new season must not silently reuse old season profile');
});

test('character snapshots deduplicate identical states and store only material changes', () => {
  const intel = intelWithPlayer();
  const one = createCharacterSnapshot(intel.snapshot(), null, 1000);
  const history1 = appendCharacterSnapshot([], one);
  const same = createCharacterSnapshot(intel.snapshot(), null, 2000);
  const history2 = appendCharacterSnapshot(history1, same);
  assert.equal(history2.length, 1);
  intel.ingestMessage(msg('GetPlayerData', [...player, '+player+MaxLife [15000]'], '2026.11.07-12.00.10:000'));
  const changed = createCharacterSnapshot(intel.snapshot(), null, 3000);
  const history3 = appendCharacterSnapshot(history2, changed);
  assert.equal(history3.length, 2);
  assert.notEqual(history3[0].fingerprint, history3[1].fingerprint);
});

test('snapshot comparison reports stat deltas and changed skill/talent IDs', () => {
  const before = { capturedAt: 1000, stats: [{ key: 'life', value: 1000 }], skills: [{ id: '501' }], talents: [{ id: '201' }], explicitEquipment: [], partialEquipment: [] };
  const after = { capturedAt: 2000, stats: [{ key: 'life', value: 1250 }], skills: [{ id: '502' }], talents: [{ id: '201' }, { id: '202' }], explicitEquipment: [], partialEquipment: [] };
  const diff = compareCharacterSnapshots(before, after);
  assert.equal(diff.statChanges, 1);
  assert.equal(diff.rows.find((x) => x.kind === 'stat').delta, 250);
  assert.ok(diff.rows.some((x) => x.kind === 'skills' && x.change === 'added' && x.value.includes('502')));
  assert.ok(diff.rows.some((x) => x.kind === 'skills' && x.change === 'removed' && x.value.includes('501')));
  assert.ok(diff.rows.some((x) => x.kind === 'talents' && x.change === 'added' && x.value.includes('202')));
});

test('profile snapshot capture stores history only when evidence changes', () => {
  const intel = intelWithPlayer().snapshot();
  const profile = createCharacterProfileFromIdentity(intel.identity, 1000);
  const first = captureProfileCharacterSnapshot(profile, intel, null, 2000);
  assert.equal(first.added, true);
  const second = captureProfileCharacterSnapshot(first.profile, intel, null, 3000);
  assert.equal(second.added, false);
  assert.equal(second.profile.characterHistory.length, 1);
});

test('Character report separates coverage from character strength and detects profile identity mismatch', () => {
  const intel = intelWithPlayer().snapshot();
  const profile = { id: 'profile-x', name: 'AnotherCharacter', playerId: '111', lastSeasonId: 1401 };
  const report = buildCharacterReport({ profile, intel, builds: [], now: Date.now() });
  assert.ok(report.completeness > 0);
  assert.match(report.label, /данных|покрытие|восстановлен/i);
  assert.ok(report.findings.some((x) => x.code === 'profile-id-mismatch'));
  assert.ok(report.findings.some((x) => x.code === 'equipment-missing'));
  assert.match(report.disclaimer, /не силу персонажа/);
});

test('anonymized diagnostic excludes player name, PlayerId, raw log lines and filesystem paths', () => {
  const report = buildAnonymizedDiagnostic({
    intel: { identity: { name: 'PrivateName', playerId: '991188', seasonId: 1401 }, stats: [{ key: 'life', value: 123, rawKey: 'MaxLife', path: 'player.MaxLife' }],
      fieldSchema: [{ path: 'player.MaxLife', key: 'MaxLife', sampleValueType: 'number-like' }], actions: { GetPlayerData: 2 }, messagesAnalyzed: 2 },
    gameLog: { gameLines: 50, recognized: 20, categoryCounts: { TLNetGame: 50 } },
  });
  const json = JSON.stringify(report);
  assert.equal(report.identity.playerPresent, true);
  assert.equal(report.identity.playerIdPresent, true);
  assert.doesNotMatch(json, /PrivateName|991188|C:\\\\|UE_game\.log contents/i);
  assert.match(report.privacy, /Не содержит имя персонажа/);
});

test('schema v3 migrates v1/v2 data and merges character snapshot history against stale renderer saves', () => {
  const migrated = mergeAppData({ schemaVersion: 2, characterProfiles: [{ id: 'c1', name: 'Rose', equipmentHistory: [{ capturedAt: 1 }] }] });
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.characterProfiles[0].characterHistory.length, 0);
  const current = mergeAppData({ characterProfiles: [{ id: 'c1', name: 'Rose', playerId: '1', characterHistory: [
    { id: 's1', fingerprint: 'a', capturedAt: 100 }, { id: 's2', fingerprint: 'b', capturedAt: 200 },
  ], lastCharacterSnapshotAt: 200 }] });
  const stale = mergeAppData({ characterProfiles: [{ id: 'c1', name: 'Rose', playerId: '1', characterHistory: [{ id: 's1', fingerprint: 'a', capturedAt: 100 }] }] });
  const merged = mergeRendererUpdate(current, stale);
  assert.equal(merged.characterProfiles[0].characterHistory.length, 2);
  assert.equal(merged.characterProfiles[0].lastCharacterSnapshotAt, 200);
});

test('new character intelligence controls and reports are exposed in the desktop UI', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'electron-main.mjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron-preload.cjs'), 'utf8');
  assert.match(html, /id="character-report-sections"/);
  assert.match(html, /id="character-history-list"/);
  assert.match(html, /id="intel-explicit-equipment"/);
  assert.match(html, /id="export-character-diagnostics"/);
  assert.match(ui, /autoCreateDetectedProfiles!==false/);
  assert.match(ui, /data-snapshot-compare/);
  assert.match(preload, /getCharacterReport:/);
  assert.match(preload, /exportCharacterDiagnostics:/);
  assert.match(main, /character:export-diagnostics/);
  assert.match(main, /createCharacterProfileFromIdentity/);
});


test('snapshot fingerprint ignores observation timestamps when all observed values are unchanged', () => {
  const a = { identity: { playerId: '1', name: 'Rose', seasonId: 1401 }, stats: [{ key: 'life', value: 5000, observedAt: 1000 }], skills: [], talents: [] };
  const b = { ...a, stats: [{ key: 'life', value: 5000, observedAt: 9000 }] };
  assert.equal(createCharacterSnapshot(a).fingerprint, createCharacterSnapshot(b).fingerprint);
});

test('snapshot comparison reports equipped stack quantity and explicit affix ID changes', () => {
  const before = { capturedAt: 1, stats: [], skills: [], talents: [], explicitEquipment: [{ itemId: 5028, slotRaw: 'MainHand', count: 1, affixes: [{ id: '9001' }] }], partialEquipment: [] };
  const after = { capturedAt: 2, stats: [], skills: [], talents: [], explicitEquipment: [{ itemId: 5028, slotRaw: 'MainHand', count: 2, affixes: [{ id: '9002' }] }], partialEquipment: [] };
  const diff = compareCharacterSnapshots(before, after);
  assert.ok(diff.rows.some((row) => row.change === 'quantity-changed' && row.before === 1 && row.after === 2));
  assert.ok(diff.rows.some((row) => row.change === 'affixes-changed' && row.before.includes('9001') && row.after.includes('9002')));
});
