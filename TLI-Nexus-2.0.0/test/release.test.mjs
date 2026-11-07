import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeBuild, compareBuilds, encodeBuild, decodeBuild } from '../core/buildAnalysis.js';
import { mergeAppData, mergeRendererUpdate } from '../core/persistence.js';
import { getItemCatalogSize, getItemInfo, getItemName, getItemImageUrl, searchItems } from '../core/itemCatalog.js';
import { LiveService } from '../core/liveService.js';
import { findCharacterProfile, updateProfileFromLive, buildProfileEquipmentSnapshot } from '../core/characterProfiles.js';
import { EquipmentTracker } from '../core/equipmentTracker.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('build analysis reports user-defined target gaps without inventing DPS', () => {
  const report = analyzeBuild({
    name: 'Fire test', hero: 'Rose', mainSkill: 'Double Thrusts', damageType: 'Fire',
    expectsFullConversion: true,
    stats: { life: 8000, conversionPercent: 80 }, targets: { life: 10000 },
    gearSlots: ['Weapon', 'Helmet'],
  });
  assert.ok(report.findings.some((x) => x.code === 'conversion-incomplete'));
  assert.ok(report.findings.some((x) => x.code === 'below-target-life'));
  assert.match(report.disclaimer, /не является игровым DPS-симулятором/i);
  assert.ok(report.completeness >= 0 && report.completeness <= 100);
});

test('NEXUS1 build code round-trips and rejects malformed codes', () => {
  const source = { name: 'Test build', hero: 'Rose', level: 95, mainSkill: 'Double Thrusts',
    stats: { life: 12345, conversionPercent: 100 }, gearSlots: ['Sword'], skills: ['Skill A'], talents: ['Node B'] };
  const code = encodeBuild(source);
  assert.match(code, /^NEXUS1\./);
  const decoded = decodeBuild(code);
  assert.equal(decoded.name, source.name);
  assert.equal(decoded.stats.life, 12345);
  assert.deepEqual(decoded.gearSlots, ['Sword']);
  assert.throws(() => decodeBuild('not-a-build'), /Неверный код/);
});

test('build comparison returns signed differences only for supplied values', () => {
  const rows = compareBuilds({ stats: { life: 1000, mana: 100 } }, { stats: { life: 1250 } });
  assert.equal(rows.find((x) => x.key === 'life').delta, 250);
  assert.equal(rows.find((x) => x.key === 'mana').delta, null);
});

test('renderer data save cannot roll back a newer automatically tracked farm session', () => {
  const current = mergeAppData({ farmingSessions: [{ id: 'session-1', sessionKey: 'session-1', source: 'live',
    startedAt: 100, durationSec: 120, lootValueFe: 55, feGained: 10, itemCount: 9, pickupEvents: 5,
    costsFe: 0, strategy: 'Автоматическая сессия', updatedAt: 200 }] });
  const staleRenderer = mergeAppData({ tactics: [{ id: 'note-1', title: 'test' }], farmingSessions: [
    { id: 'session-1', sessionKey: 'session-1', source: 'live', startedAt: 100, durationSec: 30,
      lootValueFe: 5, feGained: 1, itemCount: 1, pickupEvents: 1, costsFe: 12, strategy: 'Мой фарм' },
  ] });
  const saved = mergeRendererUpdate(current, staleRenderer);
  const session = saved.farmingSessions.find((x) => x.sessionKey === 'session-1');
  assert.equal(session.lootValueFe, 55);
  assert.equal(session.feGained, 10);
  assert.equal(session.durationSec, 120);
  assert.equal(session.costsFe, 12);
  assert.equal(session.strategy, 'Мой фарм');
  assert.equal(saved.tactics.length, 1);
});

test('item catalogue lookup exposes Russian names and image references', () => {
  assert.ok(getItemCatalogSize() >= 1900);
  assert.equal(getItemName(100300), 'Элементиевое пламя (FE)');
  assert.ok(getItemInfo(100300));
  assert.match(getItemImageUrl(100300) || '', /^https:\/\//);
  const matches = searchItems('Элементиевое пламя');
  assert.ok(matches.some((x) => x.id === 100300));
  assert.equal(new Set(matches.map((x) => x.id)).size, matches.length, 'catalogue search must not return duplicate IDs');
});

test('valuable pickup produces one threshold notification based on known FE price', () => {
  const service = new LiveService();
  service.setNotificationPreferences({ enabled: true, soundEnabled: true, thresholdFe: 20 });
  service.priceBook.setOwn({ configBaseId: 5080, fe: 6, observedAt: Date.now(), seasonId: null });
  service.handleGameLogEvent({ type: 'bagDelta', time: 'test', raw: 'test', delta: {
    kind: 'loot', qty: 4, configBaseId: 5080, proto: 'PickItems', pageId: 1, slotId: 2,
  } });
  const snapshot = service.snapshot();
  assert.equal(snapshot.lastNotification.quantity, 4);
  assert.equal(snapshot.lastNotification.valueFe, 24);
  assert.equal(snapshot.lastNotification.name, getItemName(5080));
  service.stop();
});


test('desktop release uses local Electron files, sandboxed renderers and no localhost server', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const main = fs.readFileSync(path.join(root, 'electron-main.mjs'), 'utf8');
  const overlay = fs.readFileSync(path.join(root, 'overlay.html'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  assert.match(main, /\.loadFile\(/);
  assert.doesNotMatch(main, /\.loadURL\(/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.doesNotMatch(`${overlay}\n${dashboard}`, /http:\/\/localhost/i);
  assert.doesNotMatch(`${overlay}\n${dashboard}`, /connect-src[^>]+https?:/i);
  assert.equal(fs.existsSync(path.join(root, 'index.html')), false, 'old browser-only prototype must not ship');
});

test('manual build editor generates persistent IDs and tactic editing preserves the existing record', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ui = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  assert.match(ui, /id:existing\?\.id\|\|makeUid\('build'\)/);
  assert.match(ui, /selectedTacticId\|\|makeUid\('tactic'\)/);
  assert.match(ui, /const index=data\.tactics\.findIndex\(x=>x\.id===row\.id\);if\(index>=0\)data\.tactics\[index\]=row;/);
  assert.match(html, /id="tactic-cancel-edit"/);
});

test('Electron runtime is declared in devDependencies as required by electron-builder', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies.electron, '45.2.3');
  assert.equal(pkg.dependencies?.electron, undefined);
  assert.ok(pkg.devDependencies['electron-builder']);
});

test('release packaging targets Windows x64 NSIS and portable EXE with a Windows icon', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.build.win.icon, 'assets/nexus-icon.ico');
  assert.ok(pkg.build.win.target.includes('nsis'));
  assert.ok(pkg.build.win.target.includes('portable'));
  assert.ok(pkg.build.win.target.every((x) => typeof x === 'string'), 'electron-builder 26 Windows target schema requires target names as strings');
  assert.equal(pkg.build.nsis.artifactName, 'TLI-Nexus-${version}-Setup-${arch}.${ext}');
  assert.equal(pkg.build.portable.artifactName, 'TLI-Nexus-${version}-Portable-${arch}.${ext}');
  assert.notEqual(pkg.build.nsis.artifactName, pkg.build.portable.artifactName, 'installer and portable files must have distinct names');
  const ico = fs.readFileSync(path.join(root, 'assets/nexus-icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field must be zero');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO type must be 1');
  const count = ico.readUInt16LE(4);
  const has256 = Array.from({ length: count }, (_, i) => {
    const width = ico[6 + i * 16];
    const height = ico[7 + i * 16];
    return (width === 0 || width >= 256) && (height === 0 || height >= 256);
  }).some(Boolean);
  assert.ok(has256, 'ICO must contain a native 256x256 entry');
  assert.ok(fs.existsSync(path.join(root, 'assets/nexus-icon.svg')));
  assert.ok(fs.existsSync(path.join(root, 'build-installer.bat')));
});


test('HUD has a dedicated accessible pin toggle separate from click-through', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(root, 'overlay.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'overlay.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron-preload.cjs'), 'utf8');
  assert.match(html, /id="pin"[^>]+aria-pressed="true"/);
  assert.match(ui, /\$\('pin'\)\.onclick=async/);
  assert.match(ui, /settings\.alwaysOnTop!==false/);
  assert.match(preload, /togglePin: \(enabled\) => ipcRenderer\.invoke\('app:set-always-on-top', enabled\)/);
  assert.match(html, /id="clickthrough"/);
});

test('native topmost state is explicitly cleared when HUD is unpinned', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const main = fs.readFileSync(path.join(root, 'electron-main.mjs'), 'utf8');
  const hotkeys = fs.readFileSync(path.join(root, 'core/hotkeys.js'), 'utf8');
  assert.match(main, /if \(settings\.alwaysOnTop === false\) overlay\.setAlwaysOnTop\(false\)/);
  assert.match(main, /ipcMain\.handle\('app:set-always-on-top'/);
  assert.match(main, /overlay\.isAlwaysOnTop\(\) === appData\.settings\.alwaysOnTop/);
  assert.match(hotkeys, /CommandOrControl\+Shift\+P/);
  assert.match(main, /function refreshTrayMenu\(\)/);
  assert.doesNotMatch(main, /overlay:toggle-pin/);
});

test('package version is 2.3.0 automatic TLIDB and map tracking release', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '2.3.0');
  assert.ok(pkg.build.files.includes('docs/RELEASE_NOTES_1.1.0.md'));
  assert.ok(pkg.build.files.includes('docs/RELEASE_NOTES_1.1.1.md'));
  assert.ok(pkg.build.files.includes('docs/RELEASE_NOTES_1.2.0.md'));
  assert.ok(pkg.build.files.includes('docs/RELEASE_NOTES_1.2.1.md'));
  assert.ok(pkg.build.files.includes('docs/RELEASE_NOTES_1.3.0.md'));
  assert.ok(pkg.build.files.includes('docs/RELEASE_NOTES_1.4.0.md'));
  const overlay = fs.readFileSync(path.join(root, 'overlay.html'), 'utf8');
  const dashboard = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  assert.match(overlay, /GAME COMPANION · 2.3.0/);
  assert.match(dashboard, /TLI Nexus 2.3.0/);
  assert.ok(pkg.scripts.check.includes('core/hotkeys.js'));
  assert.ok(pkg.scripts.check.includes('core/equipmentTracker.js'));
  assert.ok(pkg.scripts.check.includes('core/equipmentIntelligence.js'));
  assert.ok(pkg.scripts.check.includes('core/itemObservation.js'));
  assert.ok(pkg.scripts.check.includes('core/gameResourceCatalog.js'));
  assert.ok(pkg.build.files.includes('docs/RELEASE_NOTES_2.2.0.md'));
  assert.ok(pkg.build.files.includes('docs/GAME_RESOURCE_EXTRACTION.md'));
  assert.ok(pkg.build.files.includes('docs/RELEASE_NOTES_2.3.0.md'));
  assert.ok(pkg.scripts.check.includes('core/gameMapTracker.js'));
  assert.match(overlay, /last-map-value/);
  assert.match(overlay, /map-items/);
  assert.equal(pkg.scripts.check.includes('core/farmAnalytics.js'), true);
  const bat = fs.readFileSync(path.join(root, 'start-desktop.bat'), 'utf8');
  assert.match(bat, /npm install --include=dev/);
  assert.doesNotMatch(bat, /npm install --omit=dev/);
});

test('game resource importer is connected end-to-end and stays local-only', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const main = fs.readFileSync(path.join(root, 'electron-main.mjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron-preload.cjs'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  assert.match(main, /scanGameResourceFolder\(result\.filePaths\[0\]\)/);
  assert.match(main, /game-resource-index\.json/);
  assert.match(main, /Buffer\.byteLength\(serialized, 'utf8'\) > 45 \* 1024 \* 1024/);
  assert.match(preload, /importGameResources: \(\) => ipcRenderer\.invoke\('game-resources:import'\)/);
  assert.match(preload, /getGameResourceStatus: \(\) => ipcRenderer\.invoke\('game-resources:status'\)/);
  assert.match(html, /id="game-resource-import"/);
  assert.match(ui, /refreshGameResourceStatus\(\)/);
  assert.match(ui, /window\.nexus\.importGameResources\(\)/);
});

test('Character Intelligence dashboard exposes rescan, provenance, missing fields and build import', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron-preload.cjs'), 'utf8');
  assert.match(html, /id="rescan-character-log"/);
  assert.match(html, /id="character-intel-inventory"/);
  assert.match(html, /id="build-import-character-intel"/);
  assert.match(ui, /window\.nexus\.refreshCharacterIntel\(\)/);
  assert.match(ui, /x\.path\|\|''/);
  assert.match(ui, /x\.confidence\|\|''/);
  assert.match(ui, /inventorySnapshots/);
  assert.match(preload, /refreshCharacterIntel: \(\) => ipcRenderer\.invoke\('live:refresh-character'\)/);
  assert.match(html, /снимки сумки не выдаются за экипировку/);
});

import { analyzeFarmingSessions, median as farmMedian, sessionRate } from '../core/farmAnalytics.js';
import { PriceHistoryStore } from '../core/priceHistory.js';

test('farm analytics uses median, quartiles and requires three runs before ranking', () => {
  const sessions = [100, 110, 120, 130, 1000].map((rate, i) => ({
    strategy: 'Tartarus A', durationSec: 3600, lootValueFe: rate, costsFe: 0, startedAt: i + 1,
  }));
  sessions.push({ strategy: 'Tartarus B', durationSec: 3600, lootValueFe: 700, costsFe: 0, startedAt: 10 });
  const report = analyzeFarmingSessions(sessions);
  assert.equal(report.sessionCount, 6);
  assert.equal(report.overall.medianFePerHour, 125);
  assert.equal(report.strategies.find((x) => x.name === 'Tartarus B').variability, 'Мало данных');
  assert.equal(report.topStrategy.name, 'Tartarus A');
  assert.equal(report.topStrategy.sessions, 5);
  assert.equal(farmMedian([1, 2, 100]), 2);
  assert.equal(sessionRate({ durationSec: 0, lootValueFe: 100 }), null);
});

test('farm analytics groups by strategy and handles losses without dropping negative rates', () => {
  const report = analyzeFarmingSessions([
    { strategy: 'Loss', durationSec: 1800, lootValueFe: 10, costsFe: 30 },
    { strategy: 'Loss', durationSec: 1800, lootValueFe: 5, costsFe: 25 },
    { strategy: 'Loss', durationSec: 1800, lootValueFe: 0, costsFe: 20 },
  ]);
  assert.equal(report.strategies[0].medianFePerHour, -40);
  assert.equal(report.topStrategy.name, 'Loss');
});

test('price history records meaningful changes, caps frequency and restores from local cache', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const temp = path.join(root, `.tmp-price-history-${Date.now()}.json`);
  try {
    const history = new PriceHistoryStore({ filePath: temp });
    const at = Date.now();
    assert.equal(history.record({ configBaseId: 5028, fe: 10, source: 'community', submissions: 20 }, { seasonId: 14, at }), true);
    assert.equal(history.record({ configBaseId: 5028, fe: 10.1, source: 'community' }, { seasonId: 14, at: at + 1000 }), false, 'small change inside the same day is ignored');
    assert.equal(history.record({ configBaseId: 5028, fe: 12, source: 'exchange' }, { seasonId: 14, at: at + 2000 }), true, 'change above 2% is recorded');
    const restored = new PriceHistoryStore({ filePath: temp });
    const series = restored.get(5028, 30, at + 5000);
    assert.equal(series.points.length, 2);
    assert.equal(series.latest, 12);
    assert.equal(series.minimum, 10);
    assert.equal(series.maximum, 12);
    assert.equal(restored.snapshot().items, 1);
  } finally { fs.rmSync(temp, { force: true }); }
});

test('LiveService emits a price-target notification once and rearms after price rises', () => {
  const service = new LiveService();
  service.priceBook.setSeason(14);
  service.priceBook.setCommunity([{ configBaseId: 5028, fe: 2.4, updatedAt: '2026-11-07T00:00:00Z' }], 14);
  service.setPriceWatch([{ itemId: 5028, name: 'Резонанс Преисподней', targetFe: 2.5 }]);
  assert.equal(service.snapshot().lastNotification.type, 'price-target');
  assert.equal(service.snapshot().lastNotification.targetFe, 2.5);
  const firstId = service.snapshot().lastNotification.id;
  service.checkPriceWatch();
  assert.equal(service.snapshot().lastNotification.id, firstId, 'do not repeat while still below target');
  service.priceBook.setCommunity([{ configBaseId: 5028, fe: 3.1, updatedAt: '2026-11-07T00:10:00Z' }], 14);
  service.checkPriceWatch();
  service.priceBook.setCommunity([{ configBaseId: 5028, fe: 2.2, updatedAt: '2026-11-07T00:20:00Z' }], 14);
  service.checkPriceWatch();
  assert.ok(service.snapshot().lastNotification.id > firstId, 'send a new alert after target is crossed again');
  service.stop();
});

test('build comparison includes gear slots, skill/talent composition and invested FE', () => {
  const rows = compareBuilds(
    { name: 'A', investmentFe: 100, gearSlots: ['Weapon A', 'Helmet A'], skills: ['Skill 1'], talents: ['Talent A'] },
    { name: 'B', investmentFe: 250, gearSlots: ['Weapon B', 'Helmet A'], skills: ['Skill 1', 'Support 2'], talents: ['Talent B'] },
  );
  assert.equal(rows.find((x) => x.key === 'gear-0').left, 'Weapon A');
  assert.equal(rows.find((x) => x.key === 'gear-0').right, 'Weapon B');
  assert.equal(rows.find((x) => x.key === 'skills').changed, true);
  assert.equal(rows.find((x) => x.key === 'talents').changed, true);
  assert.equal(rows.find((x) => x.key === 'investmentFe').delta, 150);
});

test('character profile and v1.1 data survive schema migration from older backups', () => {
  const migrated = mergeAppData({ schemaVersion: 1, builds: [{ id: 'b1', name: 'Old build' }], priceWatch: [] });
  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(migrated.characterProfiles, []);
  const withProfile = mergeAppData({ characterProfiles: [{ id: 'c1', name: 'Rose' }], builds: [{ id: 'b2', profileId: 'c1' }] });
  assert.equal(withProfile.characterProfiles[0].name, 'Rose');
  assert.equal(withProfile.builds[0].profileId, 'c1');
  assert.deepEqual(withProfile.priceHistory, []);
});

test('v1.1 dashboard exposes character roster, price history and stable farming analytics', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'electron-main.mjs'), 'utf8');
  assert.match(html, /data-page="characters"/);
  assert.match(html, /id="profile-form"/);
  assert.match(html, /id="farm-strategy-table"/);
  assert.match(html, /id="build-profile"/);
  assert.match(ui, /showPriceHistory/);
  assert.match(ui, /analyzeFarming/);
  assert.match(main, /prices:history/);
  assert.match(main, /farm:analyze/);
});


test('price history can be merged from an exported backup without duplicating points', async () => {
  const { PriceHistoryStore } = await import('../core/priceHistory.js');
  const first = new PriceHistoryStore();
  first.record({ configBaseId: 5028, fe: 3, source: 'community' }, { seasonId: 14, at: 1_800_000_000_000 });
  first.record({ configBaseId: 5028, fe: 2.8, source: 'exchange' }, { seasonId: 14, at: 1_800_000_100_000 });
  const backup = first.exportSnapshot();
  const restored = new PriceHistoryStore();
  assert.equal(restored.importSnapshot(backup), 2);
  assert.equal(restored.importSnapshot(backup), 0, 'reimporting the same backup must not duplicate points');
  assert.equal(restored.get(5028, 365).points.length, 2);
  assert.equal(restored.get(5028, 365).latest, 2.8);
  assert.throws(() => restored.importSnapshot({ items: [] }), /Некорректный снимок/);
});

test('dashboard uses a fallback ID generator when crypto.randomUUID is unavailable', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ui = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  assert.match(ui, /const makeUid=\(prefix\)=>.*globalThis\.crypto\?\.randomUUID\?\./);
  assert.match(ui, /makeUid\('char'\)/);
  assert.match(ui, /makeUid\('build'\)/);
  assert.match(ui, /makeUid\('tactic'\)/);
});

test('character profile can be prefilled from the detected live game player', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  assert.match(html, /id="profile-from-game"/);
  assert.match(ui, /\$\('profile-from-game'\)\.onclick=.*live\.player/);
});

test('backup IPC includes and restores price history alongside user data', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const main = fs.readFileSync(path.join(root, 'electron-main.mjs'), 'utf8');
  assert.match(main, /_priceHistorySnapshot: live\?\.exportPriceHistory/);
  assert.match(main, /live\?\.importPriceHistory\?\./);
  assert.match(main, /50 \* 1024 \* 1024/);
});


test('dashboard formats encoded SeasonId 1401 as SS14 rather than SS01', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ui = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  assert.match(ui, /const seasonLabel=\(value\)=>.*raw\.slice\(0,2\)/);
  assert.match(ui, /seasonLabel\(live\.seasonId\)/);
});


test('click-through can be exited from tray and via emergency hotkeys regardless of hotkey preference', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const main = fs.readFileSync(path.join(root, 'electron-main.mjs'), 'utf8');
  const hotkeys = fs.readFileSync(path.join(root, 'core/hotkeys.js'), 'utf8');
  const overlay = fs.readFileSync(path.join(root, 'overlay.js'), 'utf8');
  assert.match(main, /Сквозной клик \(HUD не принимает мышь\)/);
  assert.match(main, /setClickThrough\(item\.checked\)/);
  assert.match(main, /getGlobalHotkeyDefinitions\(appData\?\.settings\?\.hotkeysEnabled !== false\)/);
  assert.match(hotkeys, /CommandOrControl\+Shift\+M/);
  assert.match(hotkeys, /CommandOrControl\+Alt\+M/);
  assert.match(hotkeys, /action: 'disable-clickthrough'/);
  assert.match(main, /'disable-clickthrough': \(\) => setClickThrough\(false\)/);
  assert.match(overlay, /Ctrl\+Shift\+M переключает режим; Ctrl\+Alt\+M аварийно выключает/);
});

test('equipment observer is exposed in the character page with explicit partial-data limitations', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'electron-main.mjs'), 'utf8');
  const live = fs.readFileSync(path.join(root, 'core/liveService.js'), 'utf8');
  const parser = fs.readFileSync(path.join(root, 'core/gameLogEvents.js'), 'utf8');
  assert.match(html, /id="live-equipment-list"/);
  assert.match(html, /id="save-equipment-snapshot"/);
  assert.match(ui, /renderEquipmentObserver\(active\)/);
  assert.match(ui, /profile\.equipmentSnapshot=/);
  assert.match(live, /equipment: gameLog\.equipment/);
  assert.match(parser, /new EquipmentTracker\(seed\?\.equipment/);
  assert.match(parser, /this\.equipmentTracker\.applyInventoryDelta/);
  assert.match(parser, /equipment: this\.equipmentTracker\.snapshot\(\)/);
  assert.match(html, /аффиксы и значения характеристик/);
});


test('click-through recovery is available from Dashboard even when HUD ignores mouse input', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'dashboard.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'electron-main.mjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron-preload.cjs'), 'utf8');
  assert.match(html, /id="emergency-clickthrough-off"/);
  assert.match(ui, /window\.nexus\.setClickThrough\(false\)/);
  assert.match(ui, /data\.settings\?\.clickThrough!==true/);
  assert.match(main, /ipcMain\.handle\('app:set-clickthrough'/);
  assert.match(main, /dashboard\.webContents\.send\('app:settings', settings\)/);
  assert.match(preload, /setClickThrough: \(value\) => ipcRenderer\.invoke\('app:set-clickthrough', value\)/);
});

test('HUD toggle uses IPC request response rather than fire-and-forget click-through message', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const main = fs.readFileSync(path.join(root, 'electron-main.mjs'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron-preload.cjs'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'overlay.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('app:toggle-clickthrough'/);
  assert.match(preload, /toggleClickThrough: \(\) => ipcRenderer\.invoke\('app:toggle-clickthrough'\)/);
  assert.match(ui, /const updated=await window\.nexus\.toggleClickThrough\(\);applySettings\(updated\)/);
  assert.doesNotMatch(main, /ipcMain\.on\('overlay:toggle-clickthrough'/);
});

test('Ctrl+Alt+M forces click-through off instead of toggling it back on', async () => {
  const { getGlobalHotkeyDefinitions } = await import('../core/hotkeys.js');
  const definitions = getGlobalHotkeyDefinitions(false);
  const emergencyOff = definitions.find((x) => x.accelerator === 'CommandOrControl+Alt+M');
  assert.equal(emergencyOff.action, 'disable-clickthrough');
  assert.equal(emergencyOff.recovery, true);
});


test('character profiles select the matching player and prefer the same season', () => {
  const profiles = [
    { id: 'old', name: 'MonkeyZXC#3199', lastSeasonId: 1301, lastSeenAt: 500 },
    { id: 'current', name: 'monkeyzxc#3199', lastSeasonId: 1401, lastSeenAt: 400 },
    { id: 'other', name: 'AnotherHero', lastSeasonId: 1401, lastSeenAt: 900 },
  ];
  assert.equal(findCharacterProfile(profiles, '  monkeyzxc#3199 ', 1401).id, 'current');
  assert.equal(findCharacterProfile(profiles, 'MONKEYZXC#3199', 1501).id, 'old');
  assert.equal(findCharacterProfile(profiles, 'missing', 1401), null);
});

test('profile live metadata updates only on context change or one-minute heartbeat', () => {
  const profile = { id: 'c1', name: 'Hero', lastArea: 'City', lastSeasonId: 1401, lastSeenAt: 1_000 };
  assert.equal(updateProfileFromLive(profile, { player: 'Hero', area: 'City', seasonId: 1401 }, 30_000), null);
  const moved = updateProfileFromLive(profile, { player: 'Hero', area: 'Tartarus', seasonId: 1401 }, 31_000);
  assert.equal(moved.lastArea, 'Tartarus');
  const heartbeat = updateProfileFromLive(profile, { player: 'Hero', area: 'City', seasonId: 1401 }, 61_001);
  assert.equal(heartbeat.lastSeenAt, 61_001);
  assert.equal(updateProfileFromLive(profile, { player: 'Other', area: 'City' }, 80_000), null);
});

test('equipment profile snapshot remains explicitly partial and never invents gear slots or affixes', () => {
  const snapshot = buildProfileEquipmentSnapshot({ items: [
    { itemId: 5080, name: 'Test item', itemType: 'Weapon', count: 1 },
  ], source: 'BagMgr · PutOn / PutOff', lastTransition: { action: 'put-on', itemId: 5080, at: 500 } }, 1401, 1000);
  assert.equal(snapshot.completeness, 'partial');
  assert.equal(snapshot.slotMapping, 'not-available');
  assert.equal(snapshot.seasonId, 1401);
  assert.equal(snapshot.items[0].itemId, 5080);
  assert.ok(snapshot.limitations.some((x) => /аффиксы/i.test(x)));
});

test('equipment observer restores state across log parser rebuild and only counts confirmed PutOn / PutOff deltas', () => {
  const tracker = new EquipmentTracker();
  tracker.applyInventoryDelta({ configBaseId: 5080, qty: -1, proto: 'PutOn', pageId: 100, slotId: 3 }, { ts: 100, raw: 'PutOn BagMgr' });
  const restored = new EquipmentTracker(tracker.exportState());
  assert.equal(restored.snapshot().items.length, 1);
  assert.equal(restored.snapshot().items[0].itemId, 5080);
  assert.equal(restored.applyInventoryDelta({ configBaseId: 5080, qty: 1, proto: 'PutOff', pageId: 100, slotId: 3 }, { ts: 200 }).action, 'put-off');
  assert.equal(restored.snapshot().items.length, 0);
  assert.equal(restored.snapshot().stats.putOnTransactions, 1);
  assert.equal(restored.snapshot().stats.putOffTransactions, 1);
  assert.equal(restored.snapshot().slotMapping, 'not-available');
});

test('stale renderer writes preserve main-process profile equipment and automatic farm profile binding', () => {
  const current = mergeAppData({ characterProfiles: [{ id: 'c1', name: 'Hero', lastSeenAt: 500,
    lastArea: 'Tartarus', lastSeasonId: 1401, equipmentSnapshot: { capturedAt: 500, items: [{ itemId: 5080 }] },
    equipmentHistory: [{ capturedAt: 100 }] }], farmingSessions: [{ id: 's1', sessionKey: 's1', source: 'live',
    profileId: 'c1', startedAt: 100, durationSec: 300, lootValueFe: 30, costsFe: 0 }] });
  const stale = mergeAppData({ characterProfiles: [{ id: 'c1', name: 'Hero', lastSeenAt: 100,
    equipmentSnapshot: { capturedAt: 100, items: [] } }], farmingSessions: [{ id: 's1', sessionKey: 's1', source: 'live',
    startedAt: 100, durationSec: 10, lootValueFe: 1, costsFe: 10 }] });
  const merged = mergeRendererUpdate(current, stale);
  assert.equal(merged.characterProfiles[0].lastArea, 'Tartarus');
  assert.equal(merged.characterProfiles[0].equipmentSnapshot.items[0].itemId, 5080);
  assert.equal(merged.farmingSessions[0].profileId, 'c1');
  assert.equal(merged.farmingSessions[0].lootValueFe, 30);
});

test('farm analytics can isolate one character and does not rank incomplete strategy samples', () => {
  const rows = [
    { profileId: 'c1', strategy: 'A', durationSec: 3600, lootValueFe: 100, costsFe: 20, endedAt: 1 },
    { profileId: 'c1', strategy: 'A', durationSec: 3600, lootValueFe: 110, costsFe: 20, endedAt: 2 },
    { profileId: 'c1', strategy: 'A', durationSec: 3600, lootValueFe: 120, costsFe: 20, endedAt: 3 },
    { profileId: 'c2', strategy: 'B', durationSec: 3600, lootValueFe: 900, costsFe: 0, endedAt: 4 },
  ];
  const report = analyzeFarmingSessions(rows, { profileId: 'c1' });
  assert.equal(report.sessionCount, 3);
  assert.equal(report.topStrategy.name, 'A');
  assert.equal(report.topStrategy.medianFePerHour, 90);
  assert.equal(report.topStrategy.profitablePercent, 100);
});

test('price history graph can filter one season while retaining the all-season view', () => {
  const history = new PriceHistoryStore();
  const now = Date.now();
  history.record({ configBaseId: 5080, fe: 10, source: 'community' }, { seasonId: 1301, at: now - 1000, force: true });
  history.record({ configBaseId: 5080, fe: 8, source: 'community' }, { seasonId: 1401, at: now, force: true });
  const current = history.get(5080, 30, now, { seasonId: 1401 });
  const all = history.get(5080, 30, now);
  assert.equal(current.points.length, 1);
  assert.equal(current.latest, 8);
  assert.deepEqual(all.seasons.sort(), [1301, 1401]);
  assert.equal(all.points.length, 2);
});

test('build comparison matches named equipment slots even when entry order changes', () => {
  const rows = compareBuilds(
    { gearSlots: ['Оружие: Клинок A', 'Шлем: Шлем X'] },
    { gearSlots: ['Шлем: Шлем X', 'Оружие: Клинок B'] },
  );
  const gearChanges = rows.filter((row) => row.kind === 'gear');
  assert.equal(gearChanges.length, 1);
  assert.equal(gearChanges[0].key, 'gear:Оружие');
  assert.equal(gearChanges[0].left, 'Клинок A');
  assert.equal(gearChanges[0].right, 'Клинок B');
});

test('enabling market notifications immediately evaluates an already-known below-target price', () => {
  const service = new LiveService();
  service.setNotificationPreferences({ enabled: false, soundEnabled: true, thresholdFe: 20 });
  service.setPriceWatch([{ itemId: 5028, name: 'Резонанс Преисподней', targetFe: 10 }]);
  service.priceBook.setOwn({ configBaseId: 5028, fe: 8, observedAt: Date.now(), seasonId: null });
  assert.equal(service.snapshot().lastNotification, null);
  const result = service.setNotificationPreferences({ enabled: true, soundEnabled: true, thresholdFe: 20 });
  assert.equal(result.alertCreated, true);
  assert.equal(service.snapshot().lastNotification.type, 'price-target');
  assert.equal(service.snapshot().lastNotification.valueFe, 8);
  service.stop();
});

test('stale renderer cannot discard newer equipment snapshot history', () => {
  const current = mergeAppData({ characterProfiles: [{ id: 'profile-a', name: 'Hero',
    equipmentSnapshot: { capturedAt: 300, items: [{ itemId: 3 }] },
    equipmentHistory: [{ capturedAt: 100 }, { capturedAt: 200 }] }] });
  const stale = mergeAppData({ characterProfiles: [{ id: 'profile-a', name: 'Hero',
    equipmentSnapshot: { capturedAt: 300, items: [{ itemId: 3 }] },
    equipmentHistory: [{ capturedAt: 100 }] }] });
  const saved = mergeRendererUpdate(current, stale);
  assert.deepEqual(saved.characterProfiles[0].equipmentHistory.map((x) => x.capturedAt), [100, 200]);
});
