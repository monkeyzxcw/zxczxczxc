import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EtorLogTailer } from './etorLogTailer.js';
import { Ingestor } from './ingest.js';
import { extractEvents } from './lootEvents.js';
import { MessageAssembler } from './ueLog.js';
import { findLogCandidates } from './logLocator.js';
import { GameLogParser, FE_ID } from './gameLogEvents.js';
import { CharacterIntel } from './characterIntel.js';
import { getItemName, getItemInfo, getItemCatalogSize } from './itemCatalog.js';
import { CommunityPriceFeed, ExchangePriceTracker, PriceBook, summarizeLoot } from './priceBook.js';
import { PriceHistoryStore } from './priceHistory.js';
import { createInterface } from 'node:readline';

const execFileAsync = promisify(execFile);
export const GAME_NAMES = ['torchlight_infinite.exe', 'UE_game-Win64-Shipping.exe', 'UE_game.exe', 'TorchlightInfinite.exe'];
const MAX_CONTEXT_BYTES = 32 * 1024 * 1024;
const LOG_SETUP_GRACE_MS = 15_000;

export function deriveLogReadiness({ connected, startedAt, liveMessages = 0, socketStarts = 0, liveGameEvents = 0, now = Date.now() } = {}) {
  if (!connected) return { code: 'no-log', label: 'LOG OFFLINE', hint: '' };
  if (liveMessages > 0 || liveGameEvents > 0) return { code: 'live', label: liveGameEvents > 0 ? 'LIVE GAME LOG' : 'LIVE PROTOCOL', hint: '' };
  if (socketStarts > 0) return { code: 'protocol-incomplete', label: 'SOCKET INCOMPLETE', hint: 'Socket-маркеры появились, но полного сообщения пока нет. Открой диагностику и проверь последние строки.' };
  const age = startedAt ? Math.max(0, now - startedAt) : 0;
  if (age >= LOG_SETUP_GRACE_MS) return {
    code: 'enable-logging', label: 'GAME LOGGING NOT DETECTED',
    hint: 'В игре нажми ESC → Другое → Enable Log (Включить логирование). Затем вернись на экран выбора персонажа и зайди снова. Для проверки отсортируй непустую вкладку инвентаря.'
  };
  return { code: 'waiting', label: 'WAITING FOR GAME LOG', hint: 'Ожидаю игровые события UE: ItemChange, BagMgr или LevelMgr.' };
}

export function isGameProcessName(value) {
  const normalized = String(value || '').trim().replace(/\\/g, '/');
  const name = path.posix.basename(normalized).toLowerCase();
  return GAME_NAMES.some((candidate) => candidate.toLowerCase() === name);
}

async function findGameProcess() {
  if (process.platform === 'win32') {
    try {
      const names = GAME_NAMES.map((name) => `'${name}'`).join(',');
      const script = `$names=@(${names}); $p=Get-CimInstance Win32_Process | Where-Object { $names -icontains $_.Name }; $p | Select-Object -First 1 -ExpandProperty ExecutablePath`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], { windowsHide: true, timeout: 3500 });
      const exe = stdout.trim().split(/\r?\n/).filter(Boolean)[0];
      if (exe) return { running: true, exe };
    } catch {}
    try {
      const { stdout } = await execFileAsync('tasklist.exe', ['/FO','CSV','/NH'], { windowsHide: true, timeout: 2500 });
      const line = stdout.split(/\r?\n/).find((s) => GAME_NAMES.some((n) => s.toLowerCase().includes(n.toLowerCase())));
      if (line) return { running: true, exe: null };
    } catch {}
    return { running: false, exe: null };
  }
  try {
    const { stdout } = await execFileAsync('pgrep', ['-af', 'torchlight_infinite|UE_game|TorchlightInfinite'], { timeout: 1500 });
    return { running: !!stdout.trim(), exe: null };
  } catch { return { running: false, exe: null }; }
}

function logDirsFromExe(exe) {
  if (!exe) return [];
  const dir = path.dirname(exe);
  return [path.resolve(dir, '..', '..', 'TorchLight', 'Saved', 'Logs')];
}

function displayArea(info) {
  if (!info) return null;
  const id = info.mapId || info.areaId || info.levelId || info.areaInstance;
  if (!id) return null;
  return `${id}${info.checkType ? ` · ${info.checkType}` : ''}`;
}

/**
 * ETor's player scanner walks backwards through at most 32 MiB to recover the
 * latest GetPlayerData even though the live tail starts at EOF. Nexus also uses
 * this bounded history pass to restore the most recent area transition, without
 * counting historical loot as loot collected in the new live session.
 */
function scanRecentContext(file, maxBytes = MAX_CONTEXT_BYTES, snapshotSize = null) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stats = fs.fstatSync(fd);
    const size = snapshotSize === null ? stats.size : Math.min(stats.size, snapshotSize);
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = length ? fs.readSync(fd, buffer, 0, length, start) : 0;
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    const events = [];
    const characterIntel = new CharacterIntel();
    let lastMessage = null;
    const ingestor = new Ingestor(null, {
      onEvent: (event) => { events.push(event); },
      onMessage: (message) => { characterIntel.ingestMessage(message); lastMessage = { action: message.action, kind: message.kind, time: message.time,
        bodyLines: message.body.length, truncated: message.truncated === true,
        preview: message.body.slice(0, 20).join('\n').slice(0, 1800) }; },
    });
    ingestor.feed(text);
    ingestor.finish();
    const rawLines = text.split(/\r?\n/).filter(Boolean).slice(-16).map((line) => line.slice(0, 700));
    const categoryCounts = {};
    for (const line of text.split(/\r?\n/)) {
      const m = /^\[[^\]]+\]\[[^\]]+\]([^:]+):/.exec(line);
      if (m) categoryCounts[m[1].trim()] = (categoryCounts[m[1].trim()] || 0) + 1;
    }
    return { size, events, messages: ingestor.counters.messages, byAction: ingestor.counters.byAction,
      lastMessage, rawLines, categoryCounts, bytesScanned: bytesRead, characterIntel: characterIntel.exportState() };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}


/**
 * Gorn reconstructs the current inventory by replaying ordinary [Game] log
 * lines before starting its live tail. We do the same: scan a fixed file-size
 * snapshot, keep only slot state + latest LevelMgr context, then tail from that
 * exact byte offset. Historical pickups are never added to the live counter.
 */
function listGameLogFiles(activeFile) {
  const dir = path.dirname(activeFile);
  const active = path.resolve(activeFile);
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => /^UE_game.*\.log$/i.test(name)); }
  catch { names = []; }
  const files = [];
  for (const name of names) {
    const file = path.resolve(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size > 0) files.push({ file, size: st.size, mtimeMs: st.mtimeMs, active: file === active });
    } catch {}
  }
  if (!files.some((x) => x.active)) {
    try { const st = fs.statSync(active); if (st.isFile() && st.size > 0) files.push({ file: active, size: st.size, mtimeMs: st.mtimeMs, active: true }); } catch {}
  }
  // Same order as Gorn: historical UE_game*.log files by mtime, active log last.
  files.sort((a, b) => Number(a.active) - Number(b.active) || a.mtimeMs - b.mtimeMs);
  return files;
}

async function scanGameLogState(file) {
  const files = listGameLogFiles(file);
  let activeSize = fs.statSync(file).size;
  let activeState = null;
  let activeSlots = 0;
  const totals = { gameLines: 0, recognized: 0, itemChanges: 0, bagInit: 0, bagAdd: 0,
    bagModify: 0, bagRemove: 0, positiveDeltas: 0, lootDeltas: 0, slotRebases: 0,
    unseededModifies: 0, areaEvents: 0, filesScanned: 0 };
  for (const entry of files) {
    const parser = new GameLogParser();
    try {
      if (entry.size > 0) {
        const input = fs.createReadStream(entry.file, { encoding: 'utf8', start: 0, end: entry.size - 1 });
        const lines = createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) parser.parseLine(line);
      }
    } catch (error) {
      if (entry.active) throw error;
      continue; // Gorn retro-scan skips unreadable historical logs and keeps going.
    }
    const snapshot = parser.snapshot();
    for (const key of Object.keys(totals)) if (key !== 'filesScanned') totals[key] += Number(snapshot[key] || 0);
    totals.filesScanned++;
    if (entry.active) {
      activeSize = entry.size;
      activeState = parser.exportState();
      activeSlots = snapshot.slots;
    }
  }
  // If the selected log isn't named UE_game*.log it is still included as active.
  return { size: activeSize, state: activeState || new GameLogParser().exportState(), stats: { ...totals, slots: activeSlots },
    files: files.map((x) => ({ file: x.file, size: x.size, active: x.active })) };
}

function countCategory(line) {
  const m = /^\[[^\]]+\]\[[^\]]+\]([^:]+):/.exec(line);
  return m ? m[1].trim() : '(без категории)';
}

export class LiveService {
  constructor({ onUpdate = () => {}, pollMs = 2000, manualLogFile = null, userDataDir = null } = {}) {
    this.onUpdate = onUpdate; this.pollMs = pollMs; this.timer = null; this.tailer = null; this.ingestor = null;
    this.game = false; this.gameExe = null; this.logFile = null; this.logSource = 'auto'; this.manualLogFile = manualLogFile;
    this.items = []; this.totalDrops = 0; this.pickupEvents = 0; this.unrecognized = 0;
    this.startedAt = null; this.lastEventAt = null; this.player = null; this.playerSource = null; this.area = null; this.areaInfo = null;
    this.areaPhase = null; this.areaSignal = null; this.pendingArea = null;
    this.messageCount = 0; this.byAction = {}; this.lastMessage = null; this.lastError = null; this.busy = false;
    this.candidates = []; this.tailerState = null; this.rawLines = []; this.categoryCounts = {};
    this.socketStartLines = 0; this.socketEndLines = 0; this.historyMessages = 0; this.historyBytes = 0;
    this.historyByAction = {}; this.lastHistoryMessage = null;
    this.gameLogParser = new GameLogParser(); this.characterIntel = new CharacterIntel(); this.gameLogHistory = null; this.gameLogLiveEvents = 0; this.feGained = 0; this.indexing = false; this.socketPickMessages = 0; this.lastSocketPick = null;
    this.seasonId = null; this.lootTotals = new Map(); this.lastCharacterScan = null;
    this.priceBook = new PriceBook({ ownCachePath: userDataDir ? path.join(userDataDir, 'exchange-prices.json') : null });
    this.priceHistory = new PriceHistoryStore({ filePath: userDataDir ? path.join(userDataDir, 'price-history.json') : null });
    this.priceWatchRules = []; this.priceAlertState = new Map(); this.priceAlertLastAt = new Map();
    this.exchangePriceTracker = new ExchangePriceTracker();
    this.notificationPreferences = { enabled: true, soundEnabled: true, thresholdFe: 20 };
    this.notificationSeq = 0; this.lastNotification = null;
    this.communityPriceFeed = new CommunityPriceFeed({ cachePath: userDataDir ? path.join(userDataDir, 'community-prices.json') : null, onUpdate: (status) => {
      this.priceBook.setCommunity(this.communityPriceFeed.all(), status.seasonId);
      this.priceHistory.recordMany(this.priceBook.all(), { seasonId: status.seasonId });
      this.checkPriceWatch();
      this.emit();
    } });
  }

  snapshot() {
    const tailer = this.tailer?.snapshot() || this.tailerState;
    const loot = summarizeLoot(this.lootTotals, this.priceBook, getItemName);
    const communityPricing = this.communityPriceFeed.snapshot();
    const gameLog = this.gameLogParser.snapshot();
    const priceStatus = { ...communityPricing, ...this.priceBook.status(), ownObservations: this.exchangePriceTracker.observations,
      unmatchedExchangeResponses: this.exchangePriceTracker.unmatched, lastExchangePrice: this.exchangePriceTracker.lastObservation };
    return {
      gameRunning: this.game, gameExe: this.gameExe, connected: !!this.tailer, logFile: this.logFile,
      logReadiness: deriveLogReadiness({ connected: !!this.tailer, startedAt: this.startedAt, liveMessages: this.messageCount, socketStarts: this.socketStartLines, liveGameEvents: this.gameLogLiveEvents }),
      logSource: this.logSource, manualLogFile: this.manualLogFile, player: this.player, playerSource: this.playerSource, area: this.area,
      areaInfo: this.areaInfo, areaPhase: this.areaPhase, areaSignal: this.areaSignal, pendingArea: this.pendingArea,
      drops: this.totalDrops, pickupEvents: this.pickupEvents, feGained: this.feGained, unrecognized: this.unrecognized,
      lootSummary: loot.rows, sessionValueFe: loot.totalValueFe, pricedTypes: loot.pricedTypes, unpricedTypes: loot.unpricedTypes,
      prices: this.priceBook.all().slice(0, 3000), priceHistory: this.priceHistory.snapshot(),
      pricedQuantity: loot.pricedQuantity, totalLootQuantity: loot.totalQuantity, pricing: priceStatus, seasonId: this.seasonId,
      gameLog, equipment: gameLog.equipment, characterIntel: this.characterIntel.snapshot(), characterScan: this.lastCharacterScan, gameLogHistory: this.gameLogHistory, itemCatalogSize: getItemCatalogSize(), indexing: this.indexing, socketPickMessages: this.socketPickMessages, lastSocketPick: this.lastSocketPick,
      lastNotification: this.lastNotification, notificationPreferences: { ...this.notificationPreferences },
      priceWatchStatus: this.getPriceWatchStatus(),
      messageCount: this.messageCount, byAction: this.byAction, lastMessage: this.lastMessage,
      startedAt: this.startedAt, lastEventAt: this.lastEventAt, recent: this.items.slice(0, 12), error: this.lastError,
      candidates: this.candidates.slice(0, 12), tailer, rawLines: this.rawLines.slice(0, 10),
      categoryCounts: this.categoryCounts, socketStartLines: this.socketStartLines,
      socketEndLines: this.socketEndLines, historyMessages: this.historyMessages, historyBytes: this.historyBytes,
      historyByAction: this.historyByAction, lastHistoryMessage: this.lastHistoryMessage,
    };
  }
  emit() { this.onUpdate(this.snapshot()); }
  getPriceHistory(itemId, days = 30, seasonId = undefined) { return this.priceHistory.get(itemId, days, Date.now(), { seasonId }); }
  exportPriceHistory() { return this.priceHistory.exportSnapshot(); }
  importPriceHistory(snapshot, options = {}) { return this.priceHistory.importSnapshot(snapshot, options); }
  setPriceWatch(rows = []) {
    const previousRules = new Map(this.priceWatchRules.map((rule) => [rule.itemId, rule]));
    this.priceWatchRules = (Array.isArray(rows) ? rows : []).filter((row) => Number.isSafeInteger(Number(row.itemId)) && Number(row.itemId) > 0)
      .map((row) => {
        const itemId = Number(row.itemId), previousRule = previousRules.get(itemId);
        const targetFe = Math.max(0, Number(row.targetFe) || 0);
        const targetChanged = previousRule && Number(previousRule.targetFe) !== targetFe;
        return { itemId, name: String(row.name || getItemName(row.itemId)), targetFe, targetChanged,
          wasBelowTarget: targetChanged ? undefined : (typeof row.wasBelowTarget === 'boolean' ? row.wasBelowTarget : undefined),
          lastAlertAt: targetChanged ? null : (Number(row.lastAlertAt) || null) };
      });
    for (const rule of this.priceWatchRules) {
      if (rule.targetChanged || !(rule.targetFe > 0)) {
        this.priceAlertState.delete(rule.itemId);
        this.priceAlertLastAt.delete(rule.itemId);
      }
      delete rule.targetChanged;
    }
    const ids = new Set(this.priceWatchRules.map((row) => row.itemId));
    for (const id of this.priceAlertState.keys()) if (!ids.has(id)) this.priceAlertState.delete(id);
    for (const rule of this.priceWatchRules) {
      if (!this.priceAlertState.has(rule.itemId) && typeof rule.wasBelowTarget === 'boolean') this.priceAlertState.set(rule.itemId, rule.wasBelowTarget);
      if (rule.lastAlertAt) this.priceAlertLastAt.set(rule.itemId, rule.lastAlertAt);
    }
    const before = this.lastNotification?.id || 0;
    this.checkPriceWatch();
    if ((this.lastNotification?.id || 0) !== before) this.emit();
  }
  checkPriceWatch() {
    if (!this.notificationPreferences.enabled) return;
    for (const rule of this.priceWatchRules) {
      if (!(rule.targetFe > 0)) continue;
      const price = this.priceBook.get(rule.itemId);
      if (!price || !Number.isFinite(price.fe)) continue;
      const reached = price.fe <= rule.targetFe;
      const previous = this.priceAlertState.get(rule.itemId);
      this.priceAlertState.set(rule.itemId, reached);
      if (reached && previous !== true) {
        const at = Date.now();
        this.priceAlertLastAt.set(rule.itemId, at);
        this.lastNotification = { id: ++this.notificationSeq, type: 'price-target', at, itemId: rule.itemId,
          name: rule.name, quantity: 1, valueFe: price.fe, targetFe: rule.targetFe, unitPrice: price.fe,
          priceSource: price.source, iconUrl: getItemInfo(rule.itemId)?.iconUrl ?? null };
      }
    }
  }

  getPriceWatchStatus() {
    return this.priceWatchRules.map((rule) => {
      const price = this.priceBook.get(rule.itemId);
      return { itemId: rule.itemId, targetFe: rule.targetFe, currentPriceFe: price?.fe ?? null,
        priceSource: price?.source ?? null, belowTarget: this.priceAlertState.get(rule.itemId) === true,
        lastAlertAt: this.priceAlertLastAt.get(rule.itemId) || null };
    });
  }
  setNotificationPreferences(prefs = {}) {
    this.notificationPreferences = {
      enabled: prefs.enabled !== false, soundEnabled: prefs.soundEnabled !== false,
      thresholdFe: Math.max(0, Math.min(1000000, Number(prefs.thresholdFe ?? this.notificationPreferences.thresholdFe) || 0)),
    };
    // Re-evaluate existing market prices when notifications are enabled or the
    // target threshold changes; otherwise a price already below target could
    // remain silent until the next market refresh.
    const previousNotificationId = this.lastNotification?.id || 0;
    this.checkPriceWatch();
    this.emit();
    return { ...this.notificationPreferences, alertCreated: (this.lastNotification?.id || 0) > previousNotificationId };
  }
  start() { if (this.timer) return; this.scan(); this.timer = setInterval(() => this.scan(), this.pollMs); }

  async setManualLog(file) {
    const value = file ? path.resolve(String(file)) : null;
    if (value && !fs.existsSync(value)) throw new Error('Выбранный файл не найден');
    this.manualLogFile = value;
    if (value) {
      this.logSource = 'manual';
      if (value !== this.logFile) await this.attach(value, 'manual');
    } else {
      this.logSource = 'auto';
      this.logFile = null;
      this.detach();
      await this.scan();
    }
    this.emit();
    return this.snapshot();
  }

  async scan() {
    if (this.busy) return; this.busy = true;
    try {
      const proc = await findGameProcess();
      this.gameExe = proc.exe || this.gameExe;
      if (proc.running !== this.game) {
        this.game = proc.running;
        if (this.game) this.resetSession();
        else if (!this.manualLogFile) { this.detach(); this.lastError = null; this.emit(); return; }
      }
      if (this.manualLogFile) {
        if (!fs.existsSync(this.manualLogFile)) {
          this.lastError = 'Выбранный лог больше не существует';
          this.detach(); this.logFile = this.manualLogFile; this.logSource = 'manual';
        } else if (this.manualLogFile !== this.logFile) await this.attach(this.manualLogFile, 'manual');
        this.emit(); return;
      }
      if (!proc.running) return;
      const candidates = findLogCandidates({ extraDirs: logDirsFromExe(proc.exe) });
      this.candidates = candidates.map((c) => ({ file: c.file, ok: c.ok, hasProtocolMessages: c.hasProtocolMessages,
        size: c.size, mtimeMs: c.mtimeMs, reason: c.reason }));
      // Prefer the active canonical UE_game.log, then the newest viable protocol log.
      const chosen = candidates.find((c) => c.ok && path.basename(c.file).toLowerCase() === 'ue_game.log') || candidates.find((c) => c.ok && c.hasProtocolMessages) || candidates.find((c) => c.ok);
      if (chosen && chosen.file !== this.logFile) await this.attach(chosen.file, 'auto');
      else if (this.logFile && !fs.existsSync(this.logFile)) this.detach();
      if (!chosen && !this.logFile) this.lastError = candidates.length ? 'Найдены логи, но ни один не прошёл проверку UE' : 'Лог UE_game.log не найден. Можно выбрать его вручную.';
      this.emit();
    } catch (error) { this.lastError = String(error.message || error); this.emit(); }
    finally { this.busy = false; }
  }

  resetSession() {
    this.startedAt = Date.now(); this.totalDrops = 0; this.pickupEvents = 0; this.unrecognized = 0; this.items = []; this.lootTotals = new Map();
    this.player = null; this.playerSource = null; this.area = null; this.areaInfo = null; this.areaPhase = null; this.areaSignal = null; this.pendingArea = null;
    this.messageCount = 0; this.byAction = {}; this.lastMessage = null; this.lastEventAt = null;
    this.rawLines = []; this.categoryCounts = {}; this.socketStartLines = 0; this.socketEndLines = 0;
    this.gameLogParser = new GameLogParser(); this.characterIntel = new CharacterIntel(); this.lastCharacterScan = null; this.gameLogLiveEvents = 0; this.feGained = 0; this.socketPickMessages = 0; this.lastSocketPick = null;
    this.exchangePriceTracker.resetPending();
  }

  restoreContext(events) {
    for (const event of events) {
      if (event.type === 'player' && event.playerName) { this.player = event.playerName; this.playerSource = 'history'; if (event.extra?.seasonId) this.setSeason(event.extra.seasonId); }
      if (event.type === 'area') {
        const label = displayArea(event) || event.area || null;
        if (label) this.area = label;
        this.areaInfo = { mapId: event.mapId, areaId: event.areaId, levelId: event.levelId,
          checkType: event.checkType, areaInstance: event.areaInstance, source: event.action };
        this.areaPhase = 'entered'; this.pendingArea = null;
      }
      if (event.type === 'areaRequest' || event.type === 'areaTransition') {
        const label = displayArea(event) || event.area || null;
        if (label) { this.pendingArea = label; this.area = `${label} · переход`; }
        this.areaPhase = event.phase;
        this.areaInfo = { mapId: event.mapId, areaId: event.areaId, levelId: event.levelId,
          checkType: event.checkType, areaInstance: event.areaInstance, source: event.action };
      }
      if (event.type === 'areaSignal') {
        this.areaSignal = { frameId: event.frameId, commands: event.commands || [], time: event.time };
      }
    }
  }

  async attach(file, source = 'auto') {
    this.detach();
    this.resetSession();
    this.tailerState = null; this.historyMessages = 0; this.historyBytes = 0;
    this.historyByAction = {}; this.lastHistoryMessage = null;
    this.logFile = file; this.logSource = source; this.lastError = null; this.indexing = true;
    this.startedAt = Date.now();
    this.emit();

    let seed, gameSeed;
    try {
      // Snapshot full current file first. The subsequent live tail starts at
      // exactly gameSeed.size, so nothing is double-counted or lost in between.
      gameSeed = await scanGameLogState(file);
      seed = scanRecentContext(file, MAX_CONTEXT_BYTES, gameSeed.size);
      this.historyMessages = seed.messages;
      this.historyBytes = seed.bytesScanned;
      this.historyByAction = seed.byAction || {};
      this.lastHistoryMessage = seed.lastMessage || null;
      this.lastCharacterScan = { at: Date.now(), bytesScanned: seed.bytesScanned, messages: seed.messages, actions: seed.byAction || {}, fileSize: gameSeed.size, windowBytes: MAX_CONTEXT_BYTES };
      this.rawLines = seed.rawLines || [];
      this.categoryCounts = seed.categoryCounts || {};
      this.restoreContext(seed.events);
      this.characterIntel = new CharacterIntel(seed.characterIntel || null);
      this.gameLogParser = new GameLogParser(gameSeed.state);
      if (gameSeed.state.seasonId) this.setSeason(gameSeed.state.seasonId);
      this.gameLogHistory = {
        lines: gameSeed.stats.gameLines,
        bagInit: gameSeed.stats.bagInit,
        bagAdd: gameSeed.stats.bagAdd,
        bagModify: gameSeed.stats.bagModify,
        areaEvents: gameSeed.stats.areaEvents,
        inventorySlots: gameSeed.stats.slots, filesScanned: gameSeed.stats.filesScanned, files: gameSeed.files,
      };
      if (gameSeed.state.currentArea?.name) {
        this.area = gameSeed.state.currentArea.name;
        this.areaInfo = { areaId: gameSeed.state.currentArea.areaId, asset: gameSeed.state.currentArea.asset,
          levelType: gameSeed.state.currentArea.levelType, source: 'LevelMgr' };
        this.areaPhase = 'entered'; this.pendingArea = null;
      }
    } catch (error) {
      this.lastError = `Не удалось восстановить состояние UE GameLog: ${error.message || error}`;
      try { seed = { size: fs.statSync(file).size, events: [], messages: 0, bytesScanned: 0 }; }
      catch { seed = { size: 0, events: [], messages: 0, bytesScanned: 0 }; }
      this.gameLogParser = new GameLogParser();
    }

    const callbacks = { source: 'live', onEvent: (event) => this.handleEvent(event), onMessage: (message) => this.handleMessage(message) };
    this.ingestor = new Ingestor(null, callbacks);
    this.tailer = new EtorLogTailer(file, {
      startPosition: gameSeed?.size ?? seed.size,
      pollIntervalMs: 500,
      maxReadSize: 512 * 1024,
      // Gorn's parser scans every UE line; event-specific regexes decide what matters.
      // Do not apply ETor's UI-oriented noisy-line filter to this game telemetry stream.
      shouldExcludeLine: () => false,
      onLine: (line) => {
        this.recordRawLine(line);
        const gameEvent = this.gameLogParser?.parseLine(line);
        if (gameEvent) this.handleGameLogEvent(gameEvent);
        this.ingestor?.feed(`${line}\n`);
      },
      onReset: () => {
        this.ingestor?.finish();
        this.resetSession();
        this.ingestor = new Ingestor(null, callbacks);
        this.emit();
      },
      onError: (error) => { this.lastError = String(error.message || error); this.emit(); },
      onStatus: (status) => { this.tailerState = status; },
    });
    this.tailer.start();
    this.indexing = false;
    this.startedAt = Date.now();
    this.emit();
  }

  async refreshCharacterIntel() {
    if (!this.logFile) throw new Error('Сначала подключи UE_game.log');
    const stat = fs.statSync(this.logFile);
    const scan = scanRecentContext(this.logFile, MAX_CONTEXT_BYTES, stat.size);
    const incoming = new CharacterIntel(scan.characterIntel || null);
    this.characterIntel.merge(incoming);
    const identity = this.characterIntel.snapshot().identity;
    if (identity?.name) {
      this.player = identity.name; this.playerSource = 'history';
      if (identity.seasonId) this.setSeason(identity.seasonId);
    }
    this.lastCharacterScan = { at: Date.now(), bytesScanned: scan.bytesScanned, messages: scan.messages,
      actions: scan.byAction || {}, fileSize: stat.size, windowBytes: MAX_CONTEXT_BYTES };
    this.emit();
    return { scan: this.lastCharacterScan, characterIntel: this.characterIntel.snapshot() };
  }

  recordRawLine(line) {
    this.rawLines.unshift(line.slice(0, 700));
    this.rawLines = this.rawLines.slice(0, 16);
    const category = countCategory(line);
    this.categoryCounts[category] = (this.categoryCounts[category] || 0) + 1;
    if (/----Socket\s+(?:SendMessage|PushMessage|RecvMessage|RecvPushMsg)\s+STT/i.test(line)) this.socketStartLines++;
    if (/----Socket\s+(?:SendMessage|PushMessage|RecvMessage|RecvPushMsg)\s+End/i.test(line)) this.socketEndLines++;
  }

  setSeason(value) {
    const season = Number(value);
    if (!Number.isSafeInteger(season) || season <= 0 || season === this.seasonId) return;
    this.seasonId = season;
    this.priceBook.setSeason(season);
    this.communityPriceFeed.start(season);
  }

  handleGameLogEvent(event) {
    this.gameLogLiveEvents++;
    this.lastEventAt = Date.now();

    if (event.type === 'season') this.setSeason(event.seasonId);

    if (event.type === 'areaEnter') {
      this.area = event.area || (event.areaId ? `Зона ${event.areaId}` : null);
      this.areaInfo = { areaId: event.areaId, asset: event.asset, levelType: event.levelType, source: 'LevelMgr' };
      this.areaPhase = 'entered'; this.pendingArea = null;
    }

    if (event.type === 'bagDelta' && event.delta) {
      const delta = event.delta;
      // Gorn's key rule: positive slot changes inside PickItem/PickItems are
      // the authoritative loot source. Bag snapshots and trades are not loot.
      if (delta.kind === 'loot' && delta.qty > 0) {
        this.totalDrops += delta.qty;
        this.pickupEvents++;
        this.lootTotals.set(delta.configBaseId, (this.lootTotals.get(delta.configBaseId) || 0) + delta.qty);
        if (delta.configBaseId === FE_ID) this.feGained += delta.qty;
        this.items.unshift({
          id: delta.configBaseId,
          name: getItemName(delta.configBaseId),
          count: delta.qty,
          time: event.time,
          area: this.area,
          status: 'ok',
          action: delta.proto,
          path: `PageId ${delta.pageId} · SlotId ${delta.slotId}`,
          raw: event.raw,
          source: 'BagMgr inventory delta',
        });
        this.items = this.items.slice(0, 40);
        const info = getItemInfo(delta.configBaseId);
        const price = this.priceBook.get(delta.configBaseId);
        const estimatedValue = price?.fe == null ? null : price.fe * delta.qty;
        if (this.notificationPreferences.enabled && estimatedValue !== null && estimatedValue >= this.notificationPreferences.thresholdFe && price?.source !== 'bound') {
          this.lastNotification = { id: ++this.notificationSeq, type: 'valuable-drop', at: Date.now(), itemId: delta.configBaseId,
            name: getItemName(delta.configBaseId), quantity: delta.qty, valueFe: estimatedValue,
            unitPrice: price.fe, priceSource: price.source, iconUrl: info?.iconUrl ?? null };
        }
      }
    }

    this.emit();
  }

  handleMessage(message) {
    const priceObservation = this.exchangePriceTracker.handle(message);
    if (priceObservation) {
      this.priceBook.setOwn({ ...priceObservation, seasonId: this.seasonId });
      const price = this.priceBook.get(priceObservation.configBaseId);
      if (price) this.priceHistory.record(price, { seasonId: this.seasonId });
      this.checkPriceWatch();
    }
    const intelResult = this.characterIntel.ingestMessage(message);
    if (intelResult.identity?.name) {
      this.player = intelResult.identity.name; this.playerSource = 'live';
      if (intelResult.identity.seasonId) this.setSeason(intelResult.identity.seasonId);
    }
    this.messageCount++;
    this.byAction[message.action] = (this.byAction[message.action] || 0) + 1;
    this.lastMessage = {
      action: message.action, kind: message.kind, time: message.time,
      bodyLines: message.body.length, truncated: message.truncated === true,
      preview: message.body.slice(0, 20).join('\n').slice(0, 1800),
    };
    this.lastEventAt = Date.now();
    this.emit();
  }

  handleEvent(event) {
    this.lastEventAt = Date.now();
    if (event.type === 'player' && event.playerName) { this.player = event.playerName; this.playerSource = 'live'; if (event.extra?.seasonId) this.setSeason(event.extra.seasonId); }

    if (event.type === 'area') {
      const label = displayArea(event) || event.area || null;
      if (label) this.area = label;
      this.areaInfo = { mapId: event.mapId, areaId: event.areaId, levelId: event.levelId,
        checkType: event.checkType, areaInstance: event.areaInstance, source: event.action };
      this.areaPhase = event.phase || 'entered';
      if (label) this.pendingArea = null;
    }
    if (event.type === 'areaRequest' || event.type === 'areaTransition') {
      const label = displayArea(event) || event.area || null;
      if (label) {
        this.pendingArea = label;
        this.area = `${label} · ${event.phase === 'open-request' ? 'загрузка' : 'переход'}`;
      }
      this.areaPhase = event.phase;
      this.areaInfo = { mapId: event.mapId, areaId: event.areaId, levelId: event.levelId,
        checkType: event.checkType, areaInstance: event.areaInstance, source: event.action };
    }
    if (event.type === 'areaSignal') {
      this.areaSignal = { frameId: event.frameId, commands: event.commands || [], time: event.time };
      if (!this.area && this.pendingArea) this.area = `${this.pendingArea} · переход`;
      else if (!this.area) this.area = `Активная область · frameId ${event.frameId}`;
    }

    if (event.type === 'pick') {
      // Match Gorn's accounting source exactly: Socket PickItem payloads are
      // diagnostics only. Loot totals come from positive BagMgr inventory
      // deltas scoped by ItemChange@ ProtoName=PickItem/PickItems.
      this.socketPickMessages++;
      this.lastSocketPick = { action: event.action, itemId: event.itemId, count: event.count,
        parseStatus: event.parseStatus, raw: event.raw };
    }
    this.emit();
  }

  detach() {
    this.tailer?.stop(); this.tailerState = this.tailer?.snapshot() || this.tailerState;
    this.tailer = null; this.ingestor?.finish(); this.ingestor = null;
    if (!this.manualLogFile) this.logFile = null;
  }
  stop() { clearInterval(this.timer); this.timer = null; this.detach(); this.communityPriceFeed.stop(); }
}
