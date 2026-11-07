import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageAssembler, parseTree, parseUeTimestamp } from '../core/ueLog.js';
import { extractEvents, collectItems } from '../core/lootEvents.js';
import { Store, parseItemMap } from '../core/store.js';
import { Ingestor } from '../core/ingest.js';
import { LogTailer } from '../core/logTailer.js';
import { EtorLogTailer, shouldExcludeEtorLine } from '../core/etorLogTailer.js';
import { validateLog } from '../core/logLocator.js';
import { sessionStats, median, exportEventsCsv } from '../core/stats.js';
import { isGameProcessName, LiveService, deriveLogReadiness } from '../core/liveService.js';
import { GameLogParser, FE_ID, gameMapName } from '../core/gameLogEvents.js';
import { getItemName } from '../core/itemCatalog.js';
import { CommunityPriceFeed, ExchangePriceTracker, PriceBook, summarizeLoot } from '../core/priceBook.js';
import { getGlobalHotkeyDefinitions, CLICKTHROUGH_RECOVERY_SHORTCUTS } from '../core/hotkeys.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'SYNTHETIC_NOT_REAL.log');
const text = fs.readFileSync(FIX, 'utf8');
const collect = (t, chunk = 1e9) => { const out = []; const a = new MessageAssembler((m) => out.push(m)); for (let i = 0; i < t.length; i += chunk) a.feed(t.slice(i, i + chunk)); a.flush(); return out; };

test('assembler: real envelope (TLNetGame category, empty ts line before body, CRLF), interleaved lines ignored', () => {
  const m = collect(text);
  assert.deepEqual(m.map((x) => `${x.kind}/${x.action}`), ['SendMessage/EnterArea', 'RecvMessage/EnterArea', 'RecvPushMsg/PickItems', 'RecvPushMsg/PickItem', 'SendMessage/PickItem', 'RecvPushMsg/PickItem', 'RecvMessage/GetPlayerData']);
  assert.ok(m.every((x) => !x.truncated));
  assert.equal(m[3].body.length, 3);
});
test('assembler: result independent of chunk boundaries (1-char chunks)', () => assert.deepEqual(collect(text, 1), collect(text)));
test('assembler: lost End closes message as truncated', () => {
  const h = (n, s) => `[2026.11.06-10.00.0${n}:000][1]TLNetGame: Display: [Game] ----Socket RecvPushMsg STT----PickItem----SynId = ${s}\n+A [${s}]\n`;
  const m = collect(h(0, 1) + h(1, 2) + '[2026.11.06-10.00.02:000][1]TLNetGame: Display: [Game] ----Socket RecvPushMsg End----\n');
  assert.equal(m.length, 2); assert.equal(m[0].truncated, true); assert.equal(m[1].truncated, false);
});
test('tree: pipes follow previous non-leaf keys (ETor sample), values with + and empty values', () => {
  const t = parseTree(['+worldInitArgs+ownerPlayerId [8]', '|             +seed [15]', '|             +replaceAffixClass+1 []', '|             +extraArgs+1+KeyType [A]', '|             |         | +value [1]', '|             |         +2+KeyType [B]', '|             |         | +value [2]', '+Bonus [+5%]']);
  assert.equal(t.worldInitArgs.seed, '15'); assert.equal(t.worldInitArgs.replaceAffixClass['1'], '');
  assert.deepEqual(t.worldInitArgs.extraArgs, { 1: { KeyType: 'A', value: '1' }, 2: { KeyType: 'B', value: '2' } });
  assert.equal(t.Bonus, '+5%');
});
test('timestamp parse', () => assert.equal(parseUeTimestamp('2026.11.06-10.00.00:100'), Date.UTC(2026, 10, 6, 10, 0, 0, 100)));
test('events: one per item object, instance id -> base id fallback, Send* picks ignored, unrecognised kept', () => {
  const m = collect(text);
  const p = extractEvents(m[2]);
  assert.deepEqual(p.map((e) => [e.itemId, e.count, e.itemInstance?.slice(0, 4)]), [[5080, 3, '5080'], [4643, 1, '4643']]);
  assert.equal(p[1].extra.affixNum, '6');
  assert.equal(extractEvents(m[3])[0].itemId, 5300);
  assert.deepEqual(extractEvents(m[4]), [], 'client request is not a pickup');
  assert.equal(extractEvents(m[5])[0].parseStatus, 'unrecognized');
  assert.deepEqual(extractEvents(m[0]), [], 'EnterArea(Send) carries no map');
  const a = extractEvents(m[1])[0]; assert.deepEqual([a.area, a.areaKind], ['111000', 'MainCity']); assert.equal(a.extra.areaInstance, '3314649325744692261');
  const pl = extractEvents(m[6])[0]; assert.equal(pl.playerName, 'TestHero'); assert.equal(pl.extra.seasonId, '1601');
});
test('ingest: sessions by idle gap, dedup on re-import, stats honest about missing prices', () => {
  const s = new Store(); const ing = new Ingestor(s); ing.feed(text); ing.finish();
  assert.equal(s.get("SELECT COUNT(*) c FROM events WHERE type='pick'").c, 4); // 2 + 1 + 1 unrecognized
  assert.equal(s.get('SELECT COUNT(*) c FROM sessions').c, 2); // 30-min gap => second session
  assert.equal(s.get('SELECT player FROM sessions WHERE id=1').player, null);
  const before = s.get('SELECT COUNT(*) c FROM events').c;
  const again = new Ingestor(s); again.feed(text); again.finish();
  assert.equal(s.get('SELECT COUNT(*) c FROM events').c, before, 're-import must not duplicate');
  const st = sessionStats(s, 1);
  assert.equal(st.observed.totalItems, 14); assert.equal(st.estimate.revenue, null); assert.equal(st.estimate.net, null);
  s.upsertItems({ 5080: 'Test Item A' }); s.addPrice(5080, 10, 'Flame'); s.addPrice(5080, 30, 'Flame'); s.addPrice(5080, 20, 'Flame');
  const st2 = sessionStats(s, 1);
  assert.equal(st2.estimate.revenue, 3 * 20); assert.equal(st2.estimate.priceCoverage, 3 / 14);
  assert.match(exportEventsCsv(s), /Test Item A/);
});
test('median', () => { assert.equal(median([1, 100, 3]), 3); assert.equal(median([]), null); assert.equal(median([1, 3]), 2); });
test('item map parser counts skipped lines instead of guessing', () => {
  const r = parseItemMap('100200\tSword\n100300 Bow of Test\ngarbage\n'); assert.equal(r.map[100200], 'Sword'); assert.equal(r.map[100300], 'Bow of Test'); assert.equal(r.skipped, 1);
});
test('locator: validates by content', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-')); const f = path.join(d, 'a.log');
  fs.writeFileSync(f, 'nothing here'); assert.equal(validateLog(f).ok, false);
  fs.copyFileSync(FIX, f); const v = validateLog(f); assert.equal(v.ok, true); assert.equal(v.hasProtocolMessages, true);
});
test('tailer: live append, partial lines, multibyte split, truncation/rotation', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-')); const f = path.join(d, 'live.log');
  const filler = 'x'.repeat(300) + '\n'; fs.writeFileSync(f, filler);
  let got = ''; const t = new LogTailer(f, { onChunk: (s) => (got += s), start: 'end' }); t.poll();
  const buf = Buffer.from('привет\n'); fs.appendFileSync(f, buf.subarray(0, 3)); t.poll(); fs.appendFileSync(f, buf.subarray(3)); t.poll();
  assert.equal(got, 'привет\n');
  fs.writeFileSync(f, 'y'.repeat(300) + '\nnew\n'); got = ''; t.poll(); // replaced file
  assert.ok(got.includes('new'));
  const cp = t.checkpoint(); const t2 = new LogTailer(f, { onChunk: (s) => (got += s), start: cp }); got = ''; t2.poll(); assert.equal(got, '', 'resume must not re-read');
});

test('REAL LOG (set TLI_REAL_LOG=<path>): envelope + player identity parse', { skip: !process.env.TLI_REAL_LOG }, () => {
  const t = fs.readFileSync(process.env.TLI_REAL_LOG, 'utf8');
  const m = collect(t); assert.ok(m.length > 0); assert.ok(m.every((x) => !x.truncated));
  const pl = m.filter((x) => x.action === 'GetPlayerData' && x.kind === 'RecvMessage').map((x) => extractEvents(x)[0]);
  assert.ok(pl.length && pl[0].parseStatus === 'ok', 'player identity must be found');
  assert.equal(validateLog(process.env.TLI_REAL_LOG).hasProtocolMessages, true);
});

test('live ingest: emits parsed events without requiring SQLite persistence', () => {
  const seen = [];
  const ing = new Ingestor(null, { onEvent: (e) => seen.push(e) });
  ing.feed(text); ing.finish();
  assert.ok(seen.some((e) => e.type === 'player'));
  assert.ok(seen.some((e) => e.type === 'area'));
  assert.equal(seen.filter((e) => e.type === 'pick').length, 4);
});


test('ETor parser parity: nested item array and area tree preserve the same fields', () => {
  const area = parseTree([
    '+AreaUniqueId [3314649325744692261]',
    '+worldInitArgs+ownerPlayerId [814971382814871552]',
    '|             +seed [1532413606]',
    '|             +battleTag [62]',
    '|             +levelId [110]',
    '|             +replaceAffixClass+1 []',
    '|             +extraArgs+1+KeyType [CheckRepeatInput]',
    '|             |         | +value [1]',
    '|             |         +2+KeyType [CheckGamePlayUnitState]',
    '|             |         | +value [1]',
    '+areaId [110_df24d82e-ae4f-11f0-b2ba-00000000005c]',
    '+mapId [111000]',
    '+checkType [MainCity]',
  ]);
  assert.equal(area.mapId, '111000');
  assert.equal(area.worldInitArgs.extraArgs['2'].value, '1');
  const items = parseTree([
    '+Items+1+Item+BaseId [5080]',
    '|     | |    +Id [5080_4b772cf0-cd82-11f1-b1ec-00000000001f]',
    '|     | |    +Num [3]',
    '|     +2+Item+Id [4643_621a9be6-d832-11f1-9a30-000000000430]',
    '|     | |    +Num [1]',
    '|     | |    +AffixNum [6]',
    '|     | |    +BaseAffix+1+Id [900]',
  ]);
  const found = collectItems(items);
  assert.deepEqual(found.map((x) => [x.itemId, x.count]), [[5080, 3], [4643, 1]]);
});

test('ETor action coverage: Spv3Open map request, InputArea signal, EnterArea server response', () => {
  const ev = (action, kind, body) => extractEvents({ time: '2026.11.07-01.00.00:000', action, kind, synId: '1', body, truncated: false });
  const request = ev('Spv3Open', 'SendMessage', ['+MapID [1001002]', '+levelId [0]', '+areaId [1000]', '+MultiArea [false]'])[0];
  assert.equal(request.type, 'areaRequest');
  assert.equal(request.mapId, '1001002');
  assert.equal(request.phase, 'open-request');
  const input = ev('InputArea', 'SendMessage', ['+frameId [2]', '+cmds+1+type [ECmd_CreateRole]'])[0];
  assert.equal(input.type, 'areaSignal');
  assert.equal(input.frameId, 2);
  assert.deepEqual(input.commands, ['ECmd_CreateRole']);
  const entered = ev('EnterArea', 'RecvMessage', ['+AreaUniqueId [998877]', '+areaId [2000]', '+mapId [1001002]', '+checkType [Map]'])[0];
  assert.equal(entered.type, 'area');
  assert.equal(entered.area, '1001002');
  assert.equal(entered.checkType, 'Map');
});

test('pickup stays visible when current build changes the item payload schema', () => {
  const message = { time: '2026.11.07-01.00.00:000', action: 'PickItems', kind: 'RecvPushMsg', synId: '42',
    truncated: false, body: ['+LootResult+resultCode [0]', '+LootResult+unknownPayload [abc]'] };
  const [event] = extractEvents(message);
  assert.equal(event.type, 'pick');
  assert.equal(event.parseStatus, 'unrecognized');
  assert.equal(event.itemId, null);
  assert.match(event.raw, /unknownPayload/);
  const compact = extractEvents({ ...message, action: 'PickItem', body: ['+itemBaseId [7777]', '+Num [4]'] })[0];
  assert.equal(compact.itemId, 7777);
  assert.equal(compact.count, 4);
  assert.equal(compact.parseStatus, 'ok');
  const duplicate = extractEvents({ ...message, action: 'PickItem', body: ['+Item+BaseId [7001]', '+Item+BaseId [7002]'] })[0];
  assert.equal(duplicate.itemId, 7002, 'ETor overwrites duplicate leaf keys; Nexus should use the effective last value');
});

test('ingestor reports every complete message to the live diagnostics callback', () => {
  const seen = [];
  const ing = new Ingestor(null, { onMessage: (m) => seen.push(`${m.kind}/${m.action}`) });
  ing.feed(text); ing.finish();
  assert.ok(seen.includes('RecvPushMsg/PickItems'));
  assert.ok(seen.includes('RecvMessage/GetPlayerData'));
  assert.equal(seen.length, 7);
});

test('live overlay state: map transitions render; Socket pickups are diagnostic only', () => {
  const service = new LiveService();
  service.handleMessage({ action: 'Spv3Open', kind: 'SendMessage', time: 't', body: [], truncated: false });
  service.handleEvent({ type: 'areaRequest', action: 'Spv3Open', phase: 'open-request', mapId: '1001002', areaId: '1000', levelId: '0' });
  assert.match(service.snapshot().area, /1001002.*загрузка/);
  service.handleEvent({ type: 'area', action: 'EnterArea', phase: 'entered', mapId: '1001002', areaId: '1000', checkType: 'Map', area: '1001002' });
  assert.equal(service.snapshot().area, '1001002 · Map');
  service.handleEvent({ type: 'pick', action: 'PickItems', itemId: 5080, count: 3, parseStatus: 'ok', time: 't', raw: '+Item+BaseId [5080]' });
  service.handleEvent({ type: 'pick', action: 'PickItem', itemId: null, count: null, parseStatus: 'unrecognized', time: 't', raw: '+unknown [x]' });
  const state = service.snapshot();
  assert.equal(state.drops, 0);
  assert.equal(state.pickupEvents, 0);
  assert.equal(state.unrecognized, 0);
  assert.equal(state.socketPickMessages, 2);
  assert.equal(state.recent.length, 0);
});


test('ETor boundary parity: End without UE timestamp still closes a message', () => {
  const raw = '[2026.11.07-01.00.00:000][1]TLNetGame: Display: [Game] ----Socket RecvPushMsg STT----PickItem----SynId = 42\n' +
    '+Item+BaseId [9012]\n' +
    '----Socket RecvPushMsg End----\n';
  const messages = collect(raw);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].truncated, false);
  assert.equal(extractEvents(messages[0])[0].itemId, 9012);
});

test('ETor boundary parity: timestamped non-GameLog payload rows survive; unrelated timestamped log rows do not', () => {
  const raw = '[2026.11.07-01.00.00:000][1]TLNetGame: Display: [Game] ----Socket RecvMessage STT----EnterArea----SynId = 42\n' +
    '[2026.11.07-01.00.00:001][1]TLNetGame: Display: [Game] +mapId [987654]\n' +
    '[2026.11.07-01.00.00:002][1]LogTemp: Display: unrelated diagnostic\n' +
    '----Socket RecvMessage End----\n';
  const [message] = collect(raw);
  assert.equal(message.body.length, 1);
  assert.equal(extractEvents(message)[0].mapId, '987654');
});

test('ETor InputArea condition includes frameId zero', () => {
  const [event] = extractEvents({ time: '2026.11.07-01.00.00:000', action: 'InputArea', kind: 'PushMessage', synId: '1', body: ['+frameId [0]'], truncated: false });
  assert.equal(event.type, 'areaSignal');
  assert.equal(event.frameId, 0);
});

test('process detection: recognizes the actual Torchlight process name (case-insensitive)', () => {
  assert.equal(isGameProcessName('torchlight_infinite.exe'), true);
  assert.equal(isGameProcessName('TORCHLIGHT_INFINITE.EXE'), true);
  assert.equal(isGameProcessName('C:\\Games\\torchlight_infinite.exe'), true);
  assert.equal(isGameProcessName('not_torchlight.exe'), false);
});


test('ETor live tailer: starts at EOF, emits complete lines only, applies ETor line filters', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-etor-')); const f = path.join(d, 'UE_game.log');
  fs.writeFileSync(f, 'old history\n');
  const lines = []; const t = new EtorLogTailer(f, { onLine: (line) => lines.push(line), startPosition: 'end' });
  t.start();
  fs.appendFileSync(f, 'new live line\nWarning: filtered line\npartial');
  t.poll();
  assert.deepEqual(lines, ['new live line']);
  assert.equal(t.snapshot().pendingBytes, Buffer.byteLength('partial'));
  fs.appendFileSync(f, ' complete\n'); t.poll();
  assert.deepEqual(lines, ['new live line', 'partial complete']);
  assert.equal(t.snapshot().filteredLines, 1);
  assert.equal(t.snapshot().linesRead, 3);
  t.stop();
});

test('ETor live tailer: starts at requested offset and notices truncation', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-etor-')); const f = path.join(d, 'UE_game.log');
  fs.writeFileSync(f, 'history\n');
  const lines = []; let resets = 0;
  const t = new EtorLogTailer(f, { onLine: (line) => lines.push(line), onReset: () => resets++, startPosition: 0 });
  t.start(); t.poll(); assert.deepEqual(lines, ['history']);
  fs.writeFileSync(f, 'fresh\n'); t.poll();
  assert.equal(resets, 1); assert.deepEqual(lines, ['history', 'fresh']);
  t.stop();
});


test('Gorn inventory parser: FE drop is calculated from BagMgr slot delta inside PickItem transaction', () => {
  const parser = new GameLogParser();
  const line = (body, ms = '000') => `[2026.11.07-01.02.00:${ms}][1]TLLua: Display: [Game] ${body}`;
  parser.parseLine(line('BagMgr@:InitBagData PageId = 100 SlotId = 7 ConfigBaseId = 100300 Num = 10'));
  parser.parseLine(line('ItemChange@ ProtoName=PickItem start', '100'));
  const event = parser.parseLine(line('BagMgr@:Modfy BagItem PageId = 100 SlotId = 7 ConfigBaseId = 100300 Num = 13', '120'));
  parser.parseLine(line('ItemChange@ ProtoName=PickItem end', '130'));
  assert.equal(FE_ID, 100300);
  assert.equal(event.type, 'bagDelta');
  assert.deepEqual([event.delta.configBaseId, event.delta.qty, event.delta.kind], [100300, 3, 'loot']);
  assert.equal(getItemName(100300), 'Элементиевое пламя (FE)');
  assert.equal(parser.snapshot().lootDeltas, 1);
});

test('Gorn inventory parser: Add seeds a previously empty slot before first Modify', () => {
  const parser = new GameLogParser();
  const line = (body) => `[2026.11.07-01.02.00:000][1]TLGame: Display: [Game] ${body}`;
  parser.parseLine(line('ItemChange@ ProtoName=PickItems start'));
  parser.parseLine(line('ItemChange@ Add Id=100300_abcdef12-1234-1234-1234-123456789012 BagNum=1 in PageId=103 SlotId=53'));
  const event = parser.parseLine(line('BagMgr@:Modfy BagItem PageId = 103 SlotId = 53 ConfigBaseId = 100300 Num = 1'));
  assert.equal(event.delta.qty, 1);
  assert.equal(event.delta.kind, 'loot');
});

test('Gorn area parser: LevelPath and EnterLevel restore friendly map name', () => {
  const parser = new GameLogParser();
  parser.parseLine('[2026.11.07-01.02.00:000][1]TLGame: Display: [Game] LevelMgr@:LevelPath, Model = Content/Art/Maps/Normal/TL_Tartarus01/Level');
  parser.parseLine('[2026.11.07-01.02.00:001][1]TLGame: Display: [Game] LevelMgr@ LevelUid, LevelType, LevelId = 88 3 9001');
  const event = parser.parseLine('[2026.11.07-01.02.00:002][1]TLGame: Display: [Game] LevelMgr:_EnterLevelSuccess() 9001');
  assert.equal(event.area, 'Tartarus');
  assert.equal(gameMapName('TL_Tartarus01', 9001), 'Tartarus');
  assert.equal(parser.snapshot().areaEvents, 3);
});

test('live service: historical player and area restore; Socket pickup remains diagnostic, not loot accounting', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-live-')); const f = path.join(d, 'UE_game.log');
  fs.writeFileSync(f, text, 'utf8');
  const svc = new LiveService();
  await svc.attach(f, 'manual');
  assert.ok(svc.snapshot().player, 'latest historical player identity should be restored');
  assert.equal(svc.snapshot().playerSource, 'history', 'historical identity must not be presented as a live handshake');
  assert.ok(svc.snapshot().area, 'latest historical area should be restored');
  assert.equal(svc.snapshot().pickupEvents, 0, 'historical pickups must not be counted in a new live session');
  const packet = '[2026.11.07-01.01.00:000][1]TLNetGame: Display: [Game] ----Socket RecvPushMsg STT----PickItem----SynId = 88\n' +
    '+Item+BaseId [99123]\n+Item+Id [99123_a1b2c3d4-e5f6-a7b8-c9d0-123456789012]\n+Item+Num [2]\n' +
    '----Socket RecvPushMsg End----\n';
  fs.appendFileSync(f, packet, 'utf8');
  svc.tailer.poll();
  assert.equal(svc.snapshot().pickupEvents, 0);
  assert.equal(svc.snapshot().drops, 0);
  assert.equal(svc.snapshot().socketPickMessages, 1);
  assert.equal(svc.snapshot().recent.length, 0);
  assert.equal(svc.snapshot().logReadiness.code, 'live');
  svc.stop();
});


test('live service: Gorn BagMgr pipeline counts FE from live inventory delta and restores map', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-gorn-'));
  const f = path.join(d, 'UE_game.log');
  const line = (body, ms = '000') => `[2026.11.07-01.02.00:${ms}][1]TLLua: Display: [Game] ${body}\n`;
  fs.writeFileSync(f,
    line('BagMgr@:InitBagData PageId = 100 SlotId = 7 ConfigBaseId = 100300 Num = 10') +
    line('LevelMgr@:LevelPath, Model = Content/Art/Maps/Normal/TL_Tartarus01/Level', '010') +
    line('LevelMgr:_EnterLevelSuccess() 9001', '020'));
  const svc = new LiveService();
  await svc.attach(f, 'manual');
  assert.equal(svc.snapshot().area, 'Tartarus');
  assert.equal(svc.snapshot().gameLogHistory.inventorySlots, 1);
  const transaction = line('ItemChange@ ProtoName=PickItem start', '100') +
    line('BagMgr@:Modfy BagItem PageId = 100 SlotId = 7 ConfigBaseId = 100300 Num = 12', '110') +
    line('ItemChange@ ProtoName=PickItem end', '120');
  fs.appendFileSync(f, transaction, 'utf8');
  svc.tailer.poll();
  const state = svc.snapshot();
  assert.equal(state.feGained, 2);
  assert.equal(state.drops, 2);
  assert.equal(state.pickupEvents, 1);
  assert.equal(state.recent[0].id, 100300);
  assert.equal(state.recent[0].count, 2);
  assert.match(state.recent[0].name, /FE/);
  assert.equal(state.gameLog.lootDeltas, 1);
  svc.stop();
});

test('Gorn retro-scan: scans sibling UE_game logs and seeds from the active UE_game.log', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-gorn-multilog-'));
  const old = path.join(d, 'UE_game-backup.log');
  const active = path.join(d, 'UE_game.log');
  const line = (body, ms = '000') => `[2026.11.07-01.03.00:${ms}][1]TLLua: Display: [Game] ${body}\n`;
  fs.writeFileSync(old, line('BagMgr@:InitBagData PageId = 100 SlotId = 7 ConfigBaseId = 100300 Num = 5'));
  fs.writeFileSync(active, line('BagMgr@:InitBagData PageId = 100 SlotId = 7 ConfigBaseId = 100300 Num = 20'));
  const svc = new LiveService();
  await svc.attach(active, 'manual');
  assert.equal(svc.snapshot().gameLogHistory.filesScanned, 2);
  assert.equal(svc.snapshot().gameLogHistory.inventorySlots, 1);
  assert.equal(svc.snapshot().feGained, 0, 'historical inventory baseline is not loot');
  fs.appendFileSync(active, line('ItemChange@ ProtoName=PickItem start', '100') +
    line('BagMgr@:Modfy BagItem PageId = 100 SlotId = 7 ConfigBaseId = 100300 Num = 21', '110') +
    line('ItemChange@ ProtoName=PickItem end', '120'));
  svc.tailer.poll();
  assert.equal(svc.snapshot().feGained, 1);
  svc.stop();
});

test('ETor default log filter: allowlisted GameplayLog route data passes, noisy GameplayLog is filtered', () => {
  assert.equal(shouldExcludeEtorLine('[Game] GameplayLog [ArrayLength] Name:服务器数据_玩法格子索引'), false);
  assert.equal(shouldExcludeEtorLine('[Game] GameplayLog unrelated event'), true);
  assert.equal(shouldExcludeEtorLine('Warning: sample'), true);
  assert.equal(shouldExcludeEtorLine('----Socket RecvPushMsg STT----PickItem----SynId = 9'), false);
});

test('live status distinguishes attached file from an actual live game protocol', () => {
  assert.equal(deriveLogReadiness({ connected: false }).code, 'no-log');
  assert.equal(deriveLogReadiness({ connected: true, startedAt: 1000, now: 2000 }).code, 'waiting');
  assert.equal(deriveLogReadiness({ connected: true, startedAt: 1000, now: 17000 }).code, 'enable-logging');
  assert.equal(deriveLogReadiness({ connected: true, startedAt: 1000, liveMessages: 1, now: 17000 }).code, 'live');
  assert.equal(deriveLogReadiness({ connected: true, startedAt: 1000, socketStarts: 1, now: 17000 }).code, 'protocol-incomplete');
});


test('loot summary merges duplicate ConfigBaseId rows and computes combined value in FE', () => {
  const book = new PriceBook();
  book.setSeason(14);
  book.setCommunity([{ configBaseId: 5028, fe: 2.5, updatedAt: '2026-11-07T00:00:00Z', submissions: 12 }], 14);
  const summary = summarizeLoot(new Map([[5028, 4], [100300, 3], [999999, 2]]), book, getItemName);
  const resonance = summary.rows.find((row) => row.id === 5028);
  assert.equal(resonance.count, 4, 'all resonance stacks must be merged by ConfigBaseId');
  assert.equal(resonance.unitPrice, 2.5);
  assert.equal(resonance.valueFe, 10);
  assert.equal(resonance.priceSource, 'community');
  assert.equal(summary.totalValueFe, 13, '4 resonances at 2.5 FE plus 3 FE currency');
  assert.equal(summary.pricedTypes, 2);
  assert.equal(summary.unpricedTypes, 1);
  assert.equal(summary.totalQuantity, 9);
});

test('Exchange price learning: SendMessage refer is paired with FE unitPrices response', () => {
  const tracker = new ExchangePriceTracker();
  const request = { action: 'XchgSearchPrice', kind: 'SendMessage', synId: '812', time: '2026.11.07-01.00.00:000', body: ['+refer [5028]'] };
  assert.equal(tracker.handle(request), null);
  const response = { action: 'XchgSearchPrice', kind: 'RecvMessage', synId: '812', time: '2026.11.07-01.00.01:000', body: [
    '+prices+1+currency [100300]',
    '|       | +unitPrices+1 [4]',
    '|       | |            +2 [5]',
    '|       | |            +3 [6]',
    '|       | |            +4 [100]',
  ] };
  const price = tracker.handle(response);
  assert.equal(price.configBaseId, 5028);
  assert.equal(price.source, 'exchange');
  assert.equal(price.min, 4);
  assert.ok(price.fe > 4 && price.fe < 5, '10th percentile excludes the extreme listing');
  assert.equal(price.sampleSize, 4);
  assert.equal(tracker.pending.size, 0);
});

test('price book prefers recent personal Exchange price and falls back to community', () => {
  const book = new PriceBook();
  book.setSeason(14);
  book.setCommunity([{ configBaseId: 5028, fe: 3, updatedAt: '2026-11-07T00:00:00Z' }], 14);
  book.setOwn({ configBaseId: 5028, fe: 2.2, observedAt: Date.now(), seasonId: 14 });
  assert.equal(book.get(5028).fe, 2.2);
  assert.equal(book.get(5028).source, 'exchange');
  assert.equal(book.get(100300).fe, 1);
  book.setSeason(15);
  assert.equal(book.get(5028), null, 'prices from another season must not leak');
});

test('community price feed downloads season prices, refreshes status and stores only local cache', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-price-feed-'));
  const cache = path.join(d, 'community-prices.json');
  let calls = 0;
  const feed = new CommunityPriceFeed({ cachePath: cache, fetchImpl: async (url, opts) => {
    calls++;
    assert.match(String(url), /season_id=eq\.14/);
    assert.ok(opts.headers.apikey);
    return { ok: true, status: 200, json: async () => [{ config_base_id: 5028, price_fe_median: 2.75, price_fe_p10: 2.1,
      submission_count: 9, unique_devices: 5, updated_at: '2026-11-07T01:00:00Z' }] };
  } });
  feed.start(14);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  assert.equal(feed.snapshot().count, 1);
  assert.equal(feed.all()[0].fe, 2.75);
  assert.ok(fs.existsSync(cache));
  feed.stop();
  const cached = new CommunityPriceFeed({ cachePath: cache, fetchImpl: async () => { throw new Error('offline'); } });
  cached.start(14);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cached.snapshot().count, 1, 'cached price survives offline startup');
  assert.equal(cached.snapshot().stale, true);
  cached.stop();
});

test('GameLog parser reads SeasonId to scope market prices', () => {
  const parser = new GameLogParser();
  parser.parseLine('[2026.11.07-01.02.00:000][1]TLLua: Display: [Game] +player+SeasonId [1401]');
  assert.equal(parser.snapshot().seasonId, 1401);
  assert.equal(parser.exportState().seasonId, 1401);
});

test('loot summary excludes bound items from sale value but keeps their quantity visible', () => {
  const book = new PriceBook();
  book.setSeason(1401);
  book.setCommunity([{ configBaseId: 6028, fe: 8.5, updatedAt: '2026-11-07T01:00:00Z' }], 1401);
  const summary = summarizeLoot(new Map([[6028, 3], [5028, 2]]), book, getItemName);
  const bound = summary.rows.find((row) => row.id === 6028);
  assert.equal(bound.name, 'Связанный: Резонанс Преисподней');
  assert.equal(bound.count, 3);
  assert.equal(bound.unitPrice, 0);
  assert.equal(bound.valueFe, 0);
  assert.equal(bound.priceSource, 'bound');
  assert.equal(summary.totalValueFe, 0, 'unpriced normal resonance is excluded; bound item is explicitly unsellable');
  assert.equal(summary.unpricedTypes, 1);
});

test('LiveService combines repeated pickups and computes one session value in FE', () => {
  const service = new LiveService();
  service.priceBook.setSeason(1401);
  service.priceBook.setCommunity([
    { configBaseId: 5028, fe: 2.5, updatedAt: '2026-11-07T01:00:00Z' },
  ], 1401);
  const add = (configBaseId, qty) => service.handleGameLogEvent({
    type: 'bagDelta', time: '2026.11.07-01.00.00:000', raw: '',
    delta: { kind: 'loot', proto: 'PickItem', configBaseId, qty, pageId: 1, slotId: 3 },
  });
  add(5028, 1);
  add(5028, 2);
  add(100300, 3);
  const state = service.snapshot();
  const resonanceRows = state.lootSummary.filter((row) => row.id === 5028);
  assert.equal(resonanceRows.length, 1);
  assert.equal(resonanceRows[0].count, 3);
  assert.equal(resonanceRows[0].valueFe, 7.5);
  assert.equal(state.feGained, 3);
  assert.equal(state.sessionValueFe, 10.5);
  assert.equal(state.pricedTypes, 2);
  service.stop();
});


test('click-through recovery shortcuts stay enabled even when regular hotkeys are disabled', () => {
  const disabled = getGlobalHotkeyDefinitions(false);
  assert.deepEqual(disabled.map((x) => x.accelerator), [...CLICKTHROUGH_RECOVERY_SHORTCUTS]);
  assert.equal(disabled.find((x) => x.accelerator === 'CommandOrControl+Shift+M')?.action, 'toggle-clickthrough');
  assert.equal(disabled.find((x) => x.accelerator === 'CommandOrControl+Alt+M')?.action, 'disable-clickthrough');
  assert.ok(disabled.every((x) => x.recovery === true));
  const enabled = getGlobalHotkeyDefinitions(true);
  assert.ok(enabled.some((x) => x.accelerator === 'CommandOrControl+Shift+O'));
  assert.ok(enabled.some((x) => x.accelerator === 'CommandOrControl+Shift+P'));
  assert.ok(enabled.some((x) => x.accelerator === 'CommandOrControl+Shift+M'));
});

test('equipment observer tracks confirmed PutOn / PutOff BagMgr deltas without guessing slots', () => {
  const parser = new GameLogParser();
  const line = (body, ms = '000') => `[2026.11.07-03.12.00:${ms}][1]TLLua: Display: [Game] ${body}`;
  parser.parseLine(line('BagMgr@:InitBagData PageId = 100 SlotId = 7 ConfigBaseId = 112162 Num = 1'));
  parser.parseLine(line('ItemChange@ ProtoName=PutOn start', '010'));
  const putOn = parser.parseLine(line('BagMgr@:RemoveBagItem PageId = 100 SlotId = 7', '020'));
  parser.parseLine(line('ItemChange@ ProtoName=PutOn end', '030'));
  assert.equal(putOn.delta.kind, 'equipmentOn');
  assert.equal(putOn.equipmentTransition.action, 'put-on');
  let equipment = parser.snapshot().equipment;
  assert.equal(equipment.itemTypes, 1);
  assert.equal(equipment.items[0].itemId, 112162);
  assert.equal(equipment.items[0].count, 1);
  assert.equal(equipment.slotMapping, 'not-available');
  assert.equal(equipment.completeness, 'partial');

  parser.parseLine(line('ItemChange@ ProtoName=PutOff start', '040'));
  parser.parseLine(line('ItemChange@ Add Id=112162_abcdef12-1234-1234-1234-123456789012 BagNum=1 in PageId=100 SlotId=8', '050'));
  const putOff = parser.parseLine(line('BagMgr@:Modfy BagItem PageId = 100 SlotId = 8 ConfigBaseId = 112162 Num = 1', '060'));
  parser.parseLine(line('ItemChange@ ProtoName=PutOff end', '070'));
  assert.equal(putOff.delta.kind, 'equipmentOff');
  assert.equal(putOff.equipmentTransition.action, 'put-off');
  equipment = parser.snapshot().equipment;
  assert.equal(equipment.itemTypes, 0);
  assert.equal(equipment.stats.putOnTransactions, 1);
  assert.equal(equipment.stats.putOffTransactions, 1);
  assert.equal(equipment.lastTransition.action, 'put-off');
});

test('equipment parser ignores generic bag moves and does not call them equipped items', () => {
  const parser = new GameLogParser();
  const line = (body) => `[2026.11.07-03.12.00:000][1]TLLua: Display: [Game] ${body}`;
  parser.parseLine(line('BagMgr@:InitBagData PageId = 100 SlotId = 7 ConfigBaseId = 112162 Num = 1'));
  parser.parseLine(line('ItemChange@ ProtoName=MoveWareHouseItems start'));
  const delta = parser.parseLine(line('BagMgr@:RemoveBagItem PageId = 100 SlotId = 7'));
  assert.equal(delta.delta.kind, 'neutral');
  assert.equal(parser.snapshot().equipment.totalItems, 0);
});
