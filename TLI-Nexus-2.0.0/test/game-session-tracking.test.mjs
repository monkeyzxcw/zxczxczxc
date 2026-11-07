import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GameLogParser } from '../core/gameLogEvents.js';
import { GameMapTracker } from '../core/gameMapTracker.js';
import { LiveService } from '../core/liveService.js';

const stamp = '2026.11.08-10.00.00:000';
const gameLine = (body, time = stamp) => `[${time}][1]TLNetGame: Display: [Game] ${body}`;

test('GameLogParser preserves map group, area asset and LevelMgr instance identifiers', () => {
  const parser = new GameLogParser();
  assert.equal(parser.parseLine(gameLine('LevelMgr@:LevelPath, Model = Content/Art/Maps/Atlas/FrozenSea_01/Map.umap')).type, 'levelPath');
  assert.equal(parser.parseLine(gameLine('LevelMgr@ LevelUid, LevelType, LevelId = 901 2 44')).levelUid, 901);
  const entered = parser.parseLine(gameLine('LevelMgr:_EnterLevelSuccess() 7001'));
  assert.equal(entered.type, 'areaEnter');
  assert.equal(entered.mapZone, 'Atlas');
  assert.equal(entered.asset, 'FrozenSea_01');
  assert.equal(entered.levelUid, 901);
  assert.equal(entered.levelType, 2);
  assert.equal(entered.levelId, 44);
  assert.equal(entered.areaId, 7001);
  const restored = new GameLogParser(parser.exportState()).snapshot().currentArea;
  assert.equal(restored.mapZone, 'Atlas');
  assert.equal(restored.levelUid, 901);
  assert.equal(restored.enteredAt, Date.UTC(2026, 10, 8, 10, 0, 0));
});

test('LiveService keeps the current game session when the UE log is attached again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-map-session-'));
  const file = path.join(dir, 'UE_game.log');
  fs.writeFileSync(file, [
    gameLine('LevelMgr@:LevelPath, Model = Content/Art/Maps/Atlas/FrozenSea_01/Map.umap'),
    gameLine('LevelMgr@ LevelUid, LevelType, LevelId = 901 2 44'),
    gameLine('LevelMgr:_EnterLevelSuccess() 7001'),
  ].join('\n') + '\n', 'utf8');

  const service = new LiveService();
  try {
    service.startedAt = 1000;
    service.totalDrops = 12;
    service.pickupEvents = 5;
    service.feGained = 7;
    service.lootTotals.set(100300, 7);
    await service.attach(file, 'manual');

    const state = service.snapshot();
    assert.equal(state.startedAt, 1000, 'log attach must not start a new game session');
    assert.equal(state.drops, 12, 'previously collected items must remain in this game run');
    assert.equal(state.pickupEvents, 5);
    assert.equal(state.feGained, 7);
    assert.equal(state.currentMap.name, 'FrozenSea');
    assert.equal(state.currentMap.drops, 0, 'map-level counters start at the recovered map boundary');

    service.handleGameLogEvent({
      type: 'bagDelta',
      delta: { kind: 'loot', configBaseId: 5028, qty: 3, proto: 'PickItem', pageId: 1, slotId: 1 },
      time: stamp,
      raw: 'test',
    });
    assert.equal(service.snapshot().drops, 15);
    assert.equal(service.snapshot().currentMap.drops, 3);

    // Reattaching the same log must reseed inventory state without discarding
    // the accumulated loot for this run or the active map.
    await service.attach(file, 'manual');
    assert.equal(service.snapshot().drops, 15);
    assert.equal(service.snapshot().currentMap.drops, 3);
    assert.equal(service.snapshot().currentMap.name, 'FrozenSea');
  } finally {
    service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LiveService keeps map and game totals when only the log parser context resets', () => {
  const service = new LiveService();
  service.startedAt = 1000;
  service.totalDrops = 20;
  service.lootTotals.set(5028, 20);
  service.gameMapTracker.enterArea({ area: 'Map A', asset: 'Map_A', mapZone: 'Atlas', areaId: 1, levelUid: 1 }, 1000);
  service.gameMapTracker.addLoot({ kind: 'loot', configBaseId: 5028, qty: 5 });

  service.resetLogContext();

  const state = service.snapshot();
  assert.equal(state.startedAt, 1000);
  assert.equal(state.drops, 20);
  assert.equal(state.currentMap.drops, 5);
  assert.equal(state.currentMap.name, 'Map A');
  service.stop();
});

test('Atlas map loot is kept as the last run after entering a city without resetting launch totals', () => {
  const tracker = new GameMapTracker();
  tracker.enterArea({ area: 'Map A', asset: 'Map_A', mapZone: 'Atlas', areaId: 1, levelUid: 1 }, 1000);
  tracker.addLoot({ kind: 'loot', configBaseId: 100300, qty: 12 });
  tracker.addLoot({ kind: 'loot', configBaseId: 5028, qty: 2 });
  tracker.enterArea({ area: 'Stronghold', asset: 'Stronghold', mapZone: 'Town', areaId: 2, levelUid: 2 }, 61000);

  const state = tracker.snapshot();
  assert.equal(state.current, null);
  assert.equal(state.last.name, 'Map A');
  assert.equal(state.last.feGained, 12);
  assert.equal(state.last.drops, 14);
  assert.equal(state.completedCount, 1);
});
