import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGameArea, GameMapTracker } from '../core/gameMapTracker.js';

test('map tracking starts only after a known Maps path and ignores path-less areas', () => {
  const tracker = new GameMapTracker();
  assert.equal(classifyGameArea({ areaId: 1 }), 'unknown');
  assert.deepEqual(tracker.enterArea({ areaId: 1 }, 1000), {
    kind: 'unknown', started: false, completed: null,
  });
  assert.equal(tracker.snapshot().current, null);
});

test('entering town completes a map but never wipes current game-wide tracking', () => {
  const tracker = new GameMapTracker();
  const started = tracker.enterArea({
    area: 'Tartarus 01', asset: 'Tartarus_01', mapZone: 'Atlas', areaId: 10, levelUid: 100,
  }, 1000);
  assert.equal(started.started, true);
  tracker.addLoot({ kind: 'loot', configBaseId: 100300, qty: 3 });
  tracker.addLoot({ kind: 'loot', configBaseId: 5028, qty: 2 });
  tracker.addLoot({ kind: 'trade', configBaseId: 5028, qty: 100 });

  const town = tracker.enterArea({ area: 'Stronghold', asset: 'Stronghold', mapZone: 'Town', areaId: 1 }, 61000);
  assert.equal(town.kind, 'hub');
  assert.equal(town.completed.drops, 5);
  assert.equal(town.completed.feGained, 3);
  assert.equal(town.completed.durationSec, 60);
  assert.equal(tracker.snapshot().current, null);
  assert.equal(tracker.snapshot().last.loot.find((row) => row.itemId === 5028).count, 2);
});

test('next map finalizes the previous run and resets only per-map counters', () => {
  const tracker = new GameMapTracker();
  tracker.enterArea({ area: 'Map A', asset: 'Map_A', mapZone: 'Atlas', areaId: 10, levelUid: 100 }, 1000);
  tracker.addLoot({ kind: 'loot', configBaseId: 5028, qty: 4 });
  const next = tracker.enterArea({ area: 'Map B', asset: 'Map_B', mapZone: 'Atlas', areaId: 11, levelUid: 101 }, 61000);
  assert.equal(next.completed.drops, 4);
  assert.equal(tracker.snapshot().current.name, 'Map B');
  assert.equal(tracker.snapshot().current.drops, 0);
  assert.equal(tracker.snapshot().completedCount, 1);
});

test('duplicate LevelMgr success for the same map does not reset accumulated loot', () => {
  const tracker = new GameMapTracker();
  const event = { area: 'Map A', asset: 'Map_A', mapZone: 'Atlas', areaId: 10, levelUid: 100 };
  tracker.enterArea(event, 1000);
  tracker.addLoot({ kind: 'loot', configBaseId: 5028, qty: 2 });
  const duplicate = tracker.enterArea(event, 2000);
  assert.equal(duplicate.duplicate, true);
  assert.equal(tracker.snapshot().current.drops, 2);
  assert.equal(tracker.snapshot().completedCount, 0);
});

test('known hub names are excluded while Atlas and non-hub instanced areas are tracked', () => {
  for (const event of [
    { mapZone: 'Town', asset: 'MainCity' },
    { mapZone: 'Hideout', asset: 'Base01' },
    { mapZone: 'SafeZone', asset: 'Central' },
  ]) assert.equal(classifyGameArea(event), 'hub');

  assert.equal(classifyGameArea({ mapZone: 'Atlas', asset: 'FrozenSea_01' }), 'map');
  assert.equal(classifyGameArea({ mapZone: 'Tartarus', asset: 'Abyss_01' }), 'map');
});

test('map history is bounded to the configured number of recent runs', () => {
  const tracker = new GameMapTracker({ maxHistory: 2 });
  for (let i = 0; i < 3; i += 1) {
    tracker.enterArea({ area: `Map ${i}`, asset: `Map_${i}`, mapZone: 'Atlas', areaId: i, levelUid: i }, i * 1000 + 1);
    tracker.enterArea({ area: 'Stronghold', asset: 'Stronghold', mapZone: 'Town' }, i * 1000 + 500);
  }
  assert.equal(tracker.snapshot().completedCount, 2);
  assert.deepEqual(tracker.snapshot().history.map((row) => row.name), ['Map 1', 'Map 2']);
});
