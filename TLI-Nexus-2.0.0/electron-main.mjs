import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, dialog, globalShortcut, shell, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveService } from './core/liveService.js';
import { getItemImageUrl, searchItems } from './core/itemCatalog.js';
import { analyzeBuild, compareBuilds, encodeBuild, decodeBuild, BUILD_STAT_FIELDS } from './core/buildAnalysis.js';
import { diagnoseBuild } from './core/buildAdvisor.js';
import { DEFAULT_APP_DATA, mergeAppData, mergeRendererUpdate } from './core/persistence.js';
import { analyzeFarmingSessions } from './core/farmAnalytics.js';
import { getGlobalHotkeyDefinitions } from './core/hotkeys.js';
import { buildProfileEquipmentSnapshot, captureProfileCharacterSnapshot, createCharacterProfileFromIdentity, findCharacterProfile, updateProfileFromLive } from './core/characterProfiles.js';
import { buildAnonymizedDiagnostic, buildCharacterReport } from './core/characterReport.js';
import { compareCharacterSnapshots } from './core/snapshotHistory.js';
import { analyzeEquipment, compareEquipment } from './core/equipmentIntelligence.js';
import { scanGameResourceFolder, resourceCatalogStatus } from './core/gameResourceCatalog.js';
import { fetchTlidbCatalog, mergeTlidbCatalog, searchTlidbAffixes, tlidbCatalogStatus } from './core/tlidbCatalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = DEFAULT_APP_DATA;
let overlay = null, dashboard = null, tray = null, live = null, appData = null;
let previousSessionKey = null, lastSessionPersistAt = 0, lastMetadataPersistAt = 0;
const iconMemory = new Map();
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
else app.on('second-instance', () => { if (dashboard && !dashboard.isDestroyed()) { dashboard.show(); dashboard.focus(); } else openDashboard(); overlay?.show(); });
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const userFile = (name) => path.join(app.getPath('userData'), name);
const dataFile = () => userFile('nexus-data.json');
const gameResourceIndexFile = () => userFile('game-resource-index.json');
let gameResourceIndexCache = null;
let gameResourceIndexMtime = 0;
function readGameResourceIndex() {
  try {
    const file = gameResourceIndexFile();
    const stat = fs.statSync(file);
    if (!gameResourceIndexCache || stat.mtimeMs !== gameResourceIndexMtime) {
      gameResourceIndexCache = JSON.parse(fs.readFileSync(file, 'utf8'));
      gameResourceIndexMtime = stat.mtimeMs;
    }
    return gameResourceIndexCache;
  } catch {
    gameResourceIndexCache = null;
    gameResourceIndexMtime = 0;
    return null;
  }
}
const tlidbCatalogFile = () => userFile('tlidb-affix-catalog.json');
let tlidbCatalogCache = null;
let tlidbCatalogMtime = 0;
function readTlidbCatalog() {
  try {
    const file = tlidbCatalogFile();
    const stat = fs.statSync(file);
    if (!tlidbCatalogCache || stat.mtimeMs !== tlidbCatalogMtime) {
      tlidbCatalogCache = JSON.parse(fs.readFileSync(file, 'utf8'));
      tlidbCatalogMtime = stat.mtimeMs;
    }
    return tlidbCatalogCache;
  } catch {
    tlidbCatalogCache = null;
    tlidbCatalogMtime = 0;
    return null;
  }
}
function writeTlidbCatalog(index) {
  const serialized = JSON.stringify(index, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > 30 * 1024 * 1024) {
    throw new Error('Кэш TLIDB превышает 30 МБ. Импорт прерван.');
  }
  fs.mkdirSync(path.dirname(tlidbCatalogFile()), { recursive: true });
  const temp = tlidbCatalogFile() + '.tmp';
  fs.writeFileSync(temp, serialized, 'utf8');
  fs.renameSync(temp, tlidbCatalogFile());
  tlidbCatalogCache = index;
  tlidbCatalogMtime = fs.statSync(tlidbCatalogFile()).mtimeMs;
}
const TLIDB_AUTO_SYNC_STARTUP_DELAY_MS = 5000;
const TLIDB_AUTO_SYNC_RETRY_MS = 60 * 60 * 1000;
let tlidbAutoSyncTimer = null;
let tlidbSyncInFlight = null;
let tlidbLastSyncError = null;

function tlidbAutoSyncEnabled() {
  return appData?.settings?.tlidbAutoSyncEnabled !== false;
}
function tlidbSyncIntervalHours() {
  const allowed = [6, 12, 24, 48, 168];
  const requested = Number(appData?.settings?.tlidbSyncIntervalHours);
  return allowed.includes(requested) ? requested : 24;
}
function tlidbSyncIntervalMs() {
  return tlidbSyncIntervalHours() * 60 * 60 * 1000;
}
function tlidbStatusSnapshot() {
  return {
    ...tlidbCatalogStatus(readTlidbCatalog()),
    autoSyncEnabled: tlidbAutoSyncEnabled(),
    syncIntervalHours: tlidbSyncIntervalHours(),
    lastError: tlidbLastSyncError,
  };
}
function notifyTlidbUpdate(automatic, error = null) {
  const payload = { status: tlidbStatusSnapshot(), automatic: automatic === true, error: error || null };
  if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send('tlidb:updated', payload);
  return payload;
}
function scheduleTlidbAutoSync(delayMs) {
  if (tlidbAutoSyncTimer) clearTimeout(tlidbAutoSyncTimer);
  tlidbAutoSyncTimer = null;
  if (!tlidbAutoSyncEnabled() || !appData) return;

  tlidbAutoSyncTimer = setTimeout(async () => {
    tlidbAutoSyncTimer = null;
    try {
      const result = await runTlidbSync({ automatic: true });
      const partial = Number(result.status?.summary?.pagesFailed) > 0;
      scheduleTlidbAutoSync(partial ? TLIDB_AUTO_SYNC_RETRY_MS : tlidbSyncIntervalMs());
    } catch (error) {
      console.warn('[TLI Nexus] Автоматическая синхронизация TLIDB не удалась:', error?.message || error);
      scheduleTlidbAutoSync(TLIDB_AUTO_SYNC_RETRY_MS);
    }
  }, Math.max(1000, Number(delayMs) || TLIDB_AUTO_SYNC_STARTUP_DELAY_MS));
  tlidbAutoSyncTimer.unref?.();
}
function configureTlidbAutoSync() {
  if (tlidbAutoSyncTimer) clearTimeout(tlidbAutoSyncTimer);
  tlidbAutoSyncTimer = null;
  if (!tlidbAutoSyncEnabled() || !appData) return;

  const cached = readTlidbCatalog();
  const syncedAt = Number(cached?.syncedAt) || 0;
  const retrySoon = Number(cached?.summary?.pagesFailed) > 0;
  const nextInterval = retrySoon ? TLIDB_AUTO_SYNC_RETRY_MS : tlidbSyncIntervalMs();
  const remaining = syncedAt ? nextInterval - (Date.now() - syncedAt) : 0;
  scheduleTlidbAutoSync(remaining > 0 ? remaining : TLIDB_AUTO_SYNC_STARTUP_DELAY_MS);
}
async function runTlidbSync({ automatic = false } = {}) {
  if (tlidbSyncInFlight) return tlidbSyncInFlight;

  const task = (async () => {
    try {
      const downloaded = await fetchTlidbCatalog();
      if (!(Number(downloaded.summary?.pagesImported) > 0) || !downloaded.records?.length) {
        const reason = downloaded.failedPages?.[0]?.reason || 'Не удалось прочитать таблицы аффиксов TLIDB.';
        throw new Error('База TLIDB не обновлена: ' + reason);
      }
      const merged = mergeTlidbCatalog(readTlidbCatalog(), downloaded);
      if (!merged.records.length) throw new Error('TLIDB не вернула ни одной записи. Старый кэш сохранён.');
      writeTlidbCatalog(merged);
      tlidbLastSyncError = null;
      notifyTlidbUpdate(automatic);
      return { status: tlidbStatusSnapshot() };
    } catch (error) {
      tlidbLastSyncError = String(error?.message || error).slice(0, 500);
      notifyTlidbUpdate(automatic, tlidbLastSyncError);
      throw error;
    }
  })();

  tlidbSyncInFlight = task;
  try {
    return await task;
  } finally {
    if (tlidbSyncInFlight === task) tlidbSyncInFlight = null;
  }
}

function mergeData(value) { return mergeAppData(value); }
function loadData() {
  try { appData = mergeData(JSON.parse(fs.readFileSync(dataFile(), 'utf8'))); }
  catch { appData = mergeData(DEFAULTS); }
  return appData;
}
function writeData(value) {
  const merged = mergeData(value);
  const serialized = JSON.stringify(merged, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > 10 * 1024 * 1024) throw new Error('Локальная база Nexus превышает 10 МБ');
  fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
  const temp = `${dataFile()}.tmp`;
  fs.writeFileSync(temp, serialized, 'utf8');
  fs.renameSync(temp, dataFile());
  appData = merged;
  live?.setPriceWatch(merged.priceWatch);
  applySettings();
  return appData;
}
function publish(state) {
  persistLiveMetadata(state);
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('live:update', state);
  if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send('live:update', state);
  persistAutoSession(state);
}
function persistDataSilently() {
  if (!appData) return;
  try {
    const temp = `${dataFile()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(appData, null, 2), 'utf8');
    fs.renameSync(temp, dataFile());
  } catch {}
}

function persistLiveMetadata(state) {
  if (!appData || !state) return;
  let changed = false;
  const identity = state.characterIntel?.identity || null;
  let profile = findCharacterProfile(appData.characterProfiles, state.player, state.seasonId, identity?.playerId);
  const now = Date.now();
  if (!profile && identity && appData.settings.autoCreateDetectedProfiles !== false) {
    profile = createCharacterProfileFromIdentity(identity, now);
    if (profile) {
      const duplicate = appData.characterProfiles.some((row) => row.id === profile.id);
      if (!duplicate) { appData.characterProfiles.push(profile); changed = true; }
      if (appData.settings.autoSelectDetectedProfile !== false) appData.settings.activeProfileId = profile.id;
    }
  }
  if (profile) {
    const liveProfileUpdate = updateProfileFromLive(profile, state, now);
    if (liveProfileUpdate) { Object.assign(profile, liveProfileUpdate); changed = true; }
    const intel = state.characterIntel;
    const incomingIntelAt = Number(intel?.lastObservedAt) || 0;
    const savedIntelAt = Number(profile.characterIntelSnapshot?.lastObservedAt) || 0;
    if (incomingIntelAt > savedIntelAt) {
      profile.characterIntelSnapshot = {
        ...intel,
        equipment: state.equipment ? { ...state.equipment, items: (state.equipment.items || []).map((x) => ({ ...x })) } : null,
        capturedAt: now,
        source: 'UE_game.log · parsed messages (evidence-first)',
      };
      const detected = intel?.identity || {};
      if (detected.playerId) { profile.playerId = detected.playerId; profile.detectedPlayerId = detected.playerId; }
      if (detected.seasonId) { profile.seasonId = detected.seasonId; profile.detectedSeasonId = detected.seasonId; profile.lastSeasonId = detected.seasonId; }
      if (detected.heroId) profile.detectedHeroId = detected.heroId;
      if (Number.isFinite(Number(detected.level)) && Number(detected.level) > 0) profile.detectedLevel = Number(detected.level);
      if (detected.specializationId) profile.detectedSpecializationId = detected.specializationId;
      if (detected.heroName && !profile.hero) profile.hero = detected.heroName;
      if (detected.specializationName && !profile.specialization) profile.specialization = detected.specializationName;
      if (detected.level) profile.level = Number(detected.level);
      const captured = captureProfileCharacterSnapshot(profile, intel, state.equipment, now);
      Object.assign(profile, captured.profile);
      profile.updatedAt = now;
      changed = true;
    }

    const transitionAt = Number(state.equipment?.lastTransition?.at) || null;
    const previousTransitionAt = Number(profile.equipmentSnapshot?.lastTransitionAt) || null;
    if (transitionAt && transitionAt !== previousTransitionAt) {
      const snapshot = buildProfileEquipmentSnapshot(state.equipment, state.seasonId, now) || {
        items: [], capturedAt: now, seasonId: Number(state.seasonId) || null,
        source: 'BagMgr · PutOn / PutOff', completeness: 'partial', slotMapping: 'not-available',
        lastTransition: state.equipment.lastTransition ? { ...state.equipment.lastTransition } : null,
        limitations: state.equipment?.limitations || [],
      };
      snapshot.lastTransitionAt = transitionAt;
      const old = profile.equipmentSnapshot;
      profile.equipmentHistory = Array.isArray(profile.equipmentHistory) ? profile.equipmentHistory : [];
      if (old && old.lastTransitionAt !== transitionAt) profile.equipmentHistory.push({ ...old });
      profile.equipmentHistory = profile.equipmentHistory.slice(-20);
      profile.equipmentSnapshot = snapshot;
      const currentIntel = profile.characterIntelSnapshot || state.characterIntel;
      const captured = captureProfileCharacterSnapshot(profile, currentIntel, state.equipment, now);
      Object.assign(profile, captured.profile);
      profile.updatedAt = now;
      changed = true;
    }
  }

  const watchStatus = new Map((state.priceWatchStatus || []).map((row) => [Number(row.itemId), row]));
  for (const rule of appData.priceWatch || []) {
    const status = watchStatus.get(Number(rule.itemId));
    if (!status) continue;
    const next = {
      wasBelowTarget: status.belowTarget === true,
      lastAlertAt: Number(status.lastAlertAt) || null,
      lastObservedPriceFe: status.currentPriceFe == null ? null : Number(status.currentPriceFe),
      lastPriceSource: status.priceSource || null,
      priceStatusUpdatedAt: Date.now(),
    };
    if (rule.wasBelowTarget !== next.wasBelowTarget || rule.lastAlertAt !== next.lastAlertAt ||
        rule.lastObservedPriceFe !== next.lastObservedPriceFe || rule.lastPriceSource !== next.lastPriceSource) {
      Object.assign(rule, next);
      changed = true;
    }
  }

  if (changed) {
    lastMetadataPersistAt = Date.now();
    persistDataSilently();
  }
}

function persistAutoSession(state) {
  if (!appData || !state?.startedAt) return;
  // A run is keyed only by the confirmed game-process start time.
  // Player identity can arrive late or change on relog, but must not split one game session.
  const key = `game-run:${Number(state.startedAt)}`;
  if (previousSessionKey && previousSessionKey !== key) {
    const existing = appData.farmingSessions.find((x) => x.source === 'live' && x.sessionKey === previousSessionKey);
    if (existing) existing.endedAt = Date.now();
  }
  previousSessionKey = key;
  const profile = findCharacterProfile(appData.characterProfiles, state.player, state.seasonId, state.characterIntel?.identity?.playerId);
  let row = appData.farmingSessions.find((x) => x.source === 'live' && x.sessionKey === key);
  if (!row) {
    row = { id: key, sessionKey: key, source: 'live', player: state.player || '', area: state.area || '',
      startedAt: state.startedAt, endedAt: null, durationSec: 0, lootValueFe: 0, feGained: 0, profileId: profile?.id || null,
      itemCount: 0, pickupEvents: 0, costsFe: 0, strategy: 'Автоматическая сессия' };
    appData.farmingSessions.push(row);
  }
  row.player = state.player || row.player;
  row.profileId = profile?.id || row.profileId || null;
  row.area = state.area || row.area;
  const sessionEndAt = state.gameEndedAt || Date.now();
  row.durationSec = Math.max(0, Math.floor((sessionEndAt - state.startedAt) / 1000));
  row.lootValueFe = Number(state.sessionValueFe) || 0;
  row.feGained = Number(state.feGained) || 0;
  row.itemCount = Number(state.drops) || 0;
  row.pickupEvents = Number(state.pickupEvents) || 0;
  row.lootTotals = (state.lootSummary || []).map((item) => ({
    itemId: Number(item.id), count: Number(item.count) || 0,
  })).filter((item) => Number.isSafeInteger(item.itemId) && item.itemId > 0 && item.count > 0);
  row.gameProcessId = Number(state.gameProcessId) || null;
  row.gameProcessStartedAt = Number(state.gameProcessStartedAt) || null;
  row.mapsCompleted = Number(state.mapsCompleted) || 0;
  row.mapRuns = Array.isArray(state.mapRuns) ? state.mapRuns.slice(-100) : (row.mapRuns || []);
  row.currentMap = state.currentMap || null;
  row.lastMap = state.lastMap || row.lastMap || null;
  row.updatedAt = Date.now();
  if (!state.gameRunning && row.endedAt === null) row.endedAt = state.gameEndedAt || Date.now();
  // Persist periodic snapshots, and always persist the transition to stopped.
  const now = Date.now();
  if (!state.gameRunning || now - lastSessionPersistAt >= 4000) {
    lastSessionPersistAt = now;
    try { fs.writeFileSync(dataFile(), JSON.stringify(appData, null, 2), 'utf8'); } catch {}
  }
}

function dimensions() {
  const mode = appData?.settings?.overlayMode === 'expanded' ? 'expanded' : 'compact';
  return mode === 'expanded' ? { width: 410, height: 570 } : { width: 390, height: 156 };
}
function scaledDimensions() {
  const base = dimensions();
  const scale = Math.max(0.8, Math.min(1.25, Number(appData?.settings?.overlayScale ?? 100) / 100));
  return { width: Math.round(base.width * scale), height: Math.round(base.height * scale), scale };
}
function setClickThrough(enabled) {
  if (!appData) return false;
  appData.settings.clickThrough = enabled === true;
  writeData(appData);
  return appData.settings.clickThrough;
}

function toggleClickThrough() {
  return setClickThrough(appData.settings.clickThrough !== true);
}

function refreshTrayMenu() {
  if (!tray || !appData) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Nexus', click: openDashboard },
    { label: 'Показать / скрыть HUD', click: () => overlay?.isVisible() ? overlay.hide() : overlay?.show() },
    { label: 'Компактный HUD', click: () => { appData.settings.overlayMode = 'compact'; writeData(appData); } },
    { label: 'Расширенный HUD', click: () => { appData.settings.overlayMode = 'expanded'; writeData(appData); } },
    { type: 'separator' },
    { label: 'Сквозной клик (HUD не принимает мышь)', type: 'checkbox', checked: appData.settings.clickThrough === true, click: (item) => setClickThrough(item.checked) },
    { label: 'Отключить сквозной клик сейчас', enabled: appData.settings.clickThrough === true, click: () => setClickThrough(false) },
    { label: 'Поверх всех окон', type: 'checkbox', checked: appData.settings.alwaysOnTop !== false, click: (item) => { appData.settings.alwaysOnTop = item.checked; writeData(appData); } },
    { type: 'separator' },
    { label: 'Выход', click: () => app.quit() },
  ]));
}

function registerGlobalHotkeys() {
  globalShortcut.unregisterAll();
  const definitions = getGlobalHotkeyDefinitions(appData?.settings?.hotkeysEnabled !== false);
  const actions = {
    'toggle-overlay': () => overlay?.isVisible() ? overlay.hide() : overlay?.show(),
    'open-dashboard': openDashboard,
    'toggle-pin': () => { appData.settings.alwaysOnTop = appData.settings.alwaysOnTop === false; writeData(appData); },
    'toggle-clickthrough': toggleClickThrough,
    'disable-clickthrough': () => setClickThrough(false),
  };
  for (const definition of definitions) {
    const handler = actions[definition.action];
    if (typeof handler !== 'function') continue;
    const registered = globalShortcut.register(definition.accelerator, handler);
    if (!registered) console.warn(`[TLI Nexus] Не удалось зарегистрировать горячую клавишу ${definition.accelerator}`);
  }
}

function applySettings() {
  refreshTrayMenu();
  const settings = appData?.settings || DEFAULTS.settings;
  if (overlay && !overlay.isDestroyed()) {
    const size = scaledDimensions();
    const [x, y] = overlay.getPosition();
    const display = screen.getDisplayMatching({ x, y, width: size.width, height: size.height });
    const area = display.workArea;
    const nx = Math.max(area.x, Math.min(x, area.x + area.width - size.width));
    const ny = Math.max(area.y, Math.min(y, area.y + area.height - size.height));
    overlay.setBounds({ x: nx, y: ny, width: size.width, height: size.height });
    overlay.webContents.setZoomFactor(size.scale);
    overlay.setOpacity(Math.max(0.55, Math.min(1, Number(settings.overlayOpacity ?? 94) / 100)));
    // Use a regular explicit false call to fully release the native topmost flag.
    if (settings.alwaysOnTop === false) overlay.setAlwaysOnTop(false);
    else overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setIgnoreMouseEvents(settings.clickThrough === true, { forward: true });
    overlay.webContents.send('app:settings', settings);
  }
  if (dashboard && !dashboard.isDestroyed()) dashboard.webContents.send('app:settings', settings);
}
function createOverlay() {
  const area = screen.getPrimaryDisplay().workArea;
  const size = scaledDimensions();
  const saved = appData.settings.overlayBounds || {};
  overlay = new BrowserWindow({ width: size.width, height: size.height,
    x: Number.isFinite(saved.x) ? saved.x : area.x + 22,
    y: Number.isFinite(saved.y) ? saved.y : area.y + 95,
    frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true,
    resizable: false, movable: true, skipTaskbar: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'electron-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.once('ready-to-show', () => { applySettings(); overlay.show(); });
  overlay.on('move', () => {
    if (!overlay || overlay.isDestroyed()) return;
    const [x, y] = overlay.getPosition(); appData.settings.overlayBounds = { x, y };
    try { fs.writeFileSync(dataFile(), JSON.stringify(appData, null, 2), 'utf8'); } catch {}
  });
  overlay.on('closed', () => { overlay = null; });
}
function openDashboard() {
  if (dashboard && !dashboard.isDestroyed()) { dashboard.show(); dashboard.focus(); return; }
  dashboard = new BrowserWindow({ width: 1440, height: 960, minWidth: 1040, minHeight: 720,
    backgroundColor: '#0b0d14', show: false,
    webPreferences: { preload: path.join(__dirname, 'electron-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
  dashboard.loadFile(path.join(__dirname, 'dashboard.html'));
  dashboard.once('ready-to-show', () => dashboard.show());
  dashboard.on('closed', () => { dashboard = null; });
}
async function resolveCachedIcon(itemId) {
  const id = Number(itemId);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  if (iconMemory.has(id)) return iconMemory.get(id);
  const url = getItemImageUrl(id);
  if (!url || new URL(url).hostname !== 'cdn.tlidb.com' || !url.startsWith('https://')) return null;
  const dir = userFile('item-icons');
  const file = path.join(dir, `${id}.img`);
  try {
    if (!fs.existsSync(file)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      if (!type.startsWith('image/')) throw new Error('Ответ не является изображением');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 1_500_000) throw new Error('Недопустимый размер изображения');
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, bytes);
      fs.writeFileSync(`${file}.type`, type, 'utf8');
    }
    const type = fs.existsSync(`${file}.type`) ? fs.readFileSync(`${file}.type`, 'utf8') : 'image/webp';
    const dataUrl = `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
    iconMemory.set(id, dataUrl); return dataUrl;
  } catch { iconMemory.set(id, null); return null; }
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  app.setAppUserModelId('com.tlinexus.desktop');
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => { event.preventDefault(); });
  });
  loadData();
  const resumableRun = appData.farmingSessions
    .filter((row) => row.source === 'live' && !row.endedAt && Number(row.gameProcessId) > 0)
    .sort((a, b) => Number(b.startedAt) - Number(a.startedAt))[0] || null;
  previousSessionKey = resumableRun?.sessionKey || null;
  live = new LiveService({
    onUpdate: publish,
    manualLogFile: appData.settings.manualLogFile || null,
    userDataDir: app.getPath('userData'),
    resumeSession: resumableRun,
    onResumeExpired: (row) => {
      const saved = appData.farmingSessions.find((item) =>
        item.source === 'live' && item.sessionKey === row.sessionKey);
      if (!saved || saved.endedAt) return;

      const endedAt = Date.now();
      const map = saved.currentMap;
      if (map) {
        const finishedMap = {
          ...map,
          endedAt,
          durationSec: Math.max(0, Math.floor((endedAt - Number(map.startedAt || endedAt)) / 1000)),
          completionReason: 'game-stopped',
        };
        saved.lastMap = finishedMap;
        saved.mapRuns = [...(saved.mapRuns || []), finishedMap].slice(-100);
        saved.mapsCompleted = Math.max(0, Number(saved.mapsCompleted) || 0) + 1;
        saved.currentMap = null;
      }
      saved.endedAt = endedAt;
      saved.durationSec = Math.max(0, Math.floor((endedAt - Number(saved.startedAt || endedAt)) / 1000));
      saved.updatedAt = endedAt;
      persistDataSilently();
    },
  });
  live.setNotificationPreferences({ enabled: appData.settings.notificationsEnabled, soundEnabled: appData.settings.soundEnabled, thresholdFe: appData.settings.notificationThresholdFe });
  live.setPriceWatch(appData.priceWatch);
  createOverlay();
  live.start();
  configureTlidbAutoSync();
  const trayImage = nativeImage.createFromPath(path.join(__dirname, 'assets', 'nexus-icon.png'));
  tray = new Tray(trayImage); tray.setToolTip('TLI Nexus — игровой компаньон');
  refreshTrayMenu();

  ipcMain.handle('live:get', () => live?.snapshot() || {});
  ipcMain.handle('live:choose-log', async () => {
    const result = await dialog.showOpenDialog(overlay, { title: 'Выберите активный UE_game.log', properties: ['openFile'], filters: [{ name: 'Логи игры', extensions: ['log','txt'] }, { name: 'Все файлы', extensions: ['*'] }] });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const selected = result.filePaths[0]; await live.setManualLog(selected);
    appData.settings.manualLogFile = selected; writeData(appData);
    return { canceled: false, file: selected };
  });
  ipcMain.handle('live:auto-log', async () => { await live.setManualLog(null); delete appData.settings.manualLogFile; writeData(appData); return { success: true }; });
  ipcMain.handle('live:refresh-character', async () => live?.refreshCharacterIntel?.() || { characterIntel: null });
  ipcMain.handle('character:report', (_event, profileId) => {
    const profile = appData.characterProfiles.find((row) => row.id === profileId) || null;
    const identity = live?.snapshot()?.characterIntel?.identity || null;
    const matchesLive = profile && identity && String(profile.playerId || profile.detectedPlayerId || '') === String(identity.playerId || '') && Number(profile.lastSeasonId || profile.seasonId || 0) === Number(identity.seasonId || 0);
    const state = live?.snapshot() || {};
    const intel = matchesLive ? state.characterIntel : profile?.characterIntelSnapshot || null;
    return buildCharacterReport({ profile, intel, equipment: matchesLive ? state.equipment : profile?.characterIntelSnapshot?.equipment || profile?.equipmentSnapshot, builds: appData.builds, now: Date.now() });
  });
  ipcMain.handle('character:capture-snapshot', (_event, profileId) => {
    const profile = appData.characterProfiles.find((row) => row.id === profileId);
    if (!profile) throw new Error('Профиль персонажа не найден');
    const state = live?.snapshot() || {}; const identity = state.characterIntel?.identity || {};
    const matchesLive = String(profile.playerId || profile.detectedPlayerId || '') === String(identity.playerId || '') && Number(profile.lastSeasonId || profile.seasonId || 0) === Number(identity.seasonId || 0);
    const intel = matchesLive ? state.characterIntel : profile.characterIntelSnapshot;
    if (!intel) throw new Error('Нет данных Character Intelligence для снимка');
    const captured = captureProfileCharacterSnapshot(profile, intel, matchesLive ? state.equipment : profile.equipmentSnapshot, Date.now());
    Object.assign(profile, captured.profile); persistDataSilently();
    return { added: captured.added, snapshot: captured.snapshot, profile };
  });
  ipcMain.handle('character:compare-snapshots', (_event, previous, current) => compareCharacterSnapshots(previous, current));
  ipcMain.handle('character:export-diagnostics', async (_event, profileId) => {
    const profile = appData.characterProfiles.find((row) => row.id === profileId) || null;
    const state = live?.snapshot() || {}; const intel = profile?.characterIntelSnapshot || state.characterIntel || {};
    const report = buildAnonymizedDiagnostic({ intel, gameLog: state.gameLog || {}, equipment: state.equipment || {}, appVersion: app.getVersion() });
    const result = await dialog.showSaveDialog(dashboard, { title: 'Экспорт обезличенной диагностики Nexus', defaultPath: `TLI-Nexus-Diagnostics-${new Date().toISOString().slice(0,10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(report, null, 2), 'utf8');
    return { canceled: false, file: result.filePath };
  });
  ipcMain.handle('app:load-data', () => loadData());
  ipcMain.handle('app:save-data', (_event, value) => writeData(mergeRendererUpdate(appData, value)));
  ipcMain.handle('app:show-dashboard', () => { openDashboard(); return true; });
  ipcMain.handle('app:open-data-folder', async () => { fs.mkdirSync(app.getPath('userData'), { recursive: true }); const result = await shell.openPath(app.getPath('userData')); if (result) throw new Error(result); return app.getPath('userData'); });
  ipcMain.handle('app:show-overlay', () => { overlay?.show(); return true; });
  ipcMain.handle('app:copy', async (_event, text) => { await clipboard.writeText(String(text || '').slice(0, 200000)); return true; });
  ipcMain.handle('app:set-overlay-mode', (_event, mode) => { appData.settings.overlayMode = mode === 'expanded' ? 'expanded' : 'compact'; writeData(appData); return appData.settings.overlayMode; });
  ipcMain.handle('app:set-clickthrough', (_event, enabled) => {
    setClickThrough(enabled === true);
    return { ...appData.settings };
  });
  ipcMain.handle('app:toggle-clickthrough', () => {
    toggleClickThrough();
    return { ...appData.settings };
  });
  ipcMain.handle('app:set-always-on-top', (_event, enabled) => {
    appData.settings.alwaysOnTop = enabled === true;
    writeData(appData);
    return { ...appData.settings, applied: !!overlay && !overlay.isDestroyed() && overlay.isAlwaysOnTop() === appData.settings.alwaysOnTop };
  });
  ipcMain.handle('app:update-settings', (_event, settings) => {
    appData.settings = { ...appData.settings, ...(settings && typeof settings === 'object' ? settings : {}) };
    writeData(appData);
    live?.setNotificationPreferences({ enabled: appData.settings.notificationsEnabled, soundEnabled: appData.settings.soundEnabled, thresholdFe: appData.settings.notificationThresholdFe });
    registerGlobalHotkeys();
    configureTlidbAutoSync();
    return appData.settings;
  });
  ipcMain.handle('app:export', async () => {
    const result = await dialog.showSaveDialog(dashboard, { title: 'Экспорт резервной копии Nexus', defaultPath: `TLI-Nexus-Backup-${new Date().toISOString().slice(0,10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { canceled: true };
    const backup = { ...appData, _priceHistorySnapshot: live?.exportPriceHistory?.() || null };
    fs.writeFileSync(result.filePath, JSON.stringify(backup, null, 2), 'utf8'); return { canceled: false, file: result.filePath };
  });
  ipcMain.handle('app:import', async () => {
    const result = await dialog.showOpenDialog(dashboard, { title: 'Импорт резервной копии Nexus', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const stat = fs.statSync(result.filePaths[0]);
    if (stat.size > 50 * 1024 * 1024) throw new Error('Резервная копия больше 50 МБ');
    const parsed = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Файл резервной копии имеет неверный формат');
    const priceHistorySnapshot = parsed._priceHistorySnapshot || null;
    if (priceHistorySnapshot && (typeof priceHistorySnapshot !== 'object' || !priceHistorySnapshot.items || typeof priceHistorySnapshot.items !== 'object' || Array.isArray(priceHistorySnapshot.items))) {
      throw new Error('История цен в резервной копии имеет неверный формат');
    }
    delete parsed._priceHistorySnapshot;
    const imported = mergeData(parsed); writeData(imported); configureTlidbAutoSync();
    let importedPricePoints = 0;
    if (priceHistorySnapshot) importedPricePoints = live?.importPriceHistory?.(priceHistorySnapshot, { merge: true }) || 0;
    return { canceled: false, data: appData, importedPricePoints };
  });
  ipcMain.handle('game-resources:status', () => resourceCatalogStatus(readGameResourceIndex()));
  ipcMain.handle('game-resources:import', async () => {
    const result = await dialog.showOpenDialog(dashboard, {
      title: 'Выбери папку с экспортом FModel / Unreal JSON',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const index = scanGameResourceFolder(result.filePaths[0]);
    const serialized = JSON.stringify(index, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > 45 * 1024 * 1024) {
      throw new Error('Индекс игровых ресурсов превышает 45 МБ. Выбери папку только с игровыми DataTable/JSON-экспортами.');
    }
    const temp = gameResourceIndexFile() + '.tmp';
    fs.writeFileSync(temp, serialized, 'utf8');
    fs.renameSync(temp, gameResourceIndexFile());
    gameResourceIndexCache = index;
    gameResourceIndexMtime = fs.statSync(gameResourceIndexFile()).mtimeMs;
    return { canceled: false, status: resourceCatalogStatus(index), limitations: index.limitations };
  });
  ipcMain.handle('tlidb:status', () => tlidbStatusSnapshot());
  ipcMain.handle('tlidb:sync', async () => {
    const result = await runTlidbSync({ automatic: false });
    if (tlidbAutoSyncEnabled()) {
      const partial = Number(result.status?.summary?.pagesFailed) > 0;
      scheduleTlidbAutoSync(partial ? TLIDB_AUTO_SYNC_RETRY_MS : tlidbSyncIntervalMs());
    }
    return result;
  });
  ipcMain.handle('tlidb:search', (_event, query, options = {}) => searchTlidbAffixes(
    readTlidbCatalog(),
    String(query || '').slice(0, 120),
    {
      gearGroup: String(options?.gearGroup || '').slice(0, 80),
      sourceKind: String(options?.sourceKind || '').slice(0, 40),
      limit: Math.min(100, Math.max(1, Number(options?.limit) || 40)),
    },
  ));
  ipcMain.handle('items:search', (_event, query) => searchItems(query, 500));
  ipcMain.handle('equipment:analyze', (_event, items, priorities) => analyzeEquipment(Array.isArray(items) ? items.slice(0, 100) : [], priorities, readGameResourceIndex()));
  ipcMain.handle('equipment:compare', (_event, left, right, priorities) => compareEquipment(left, right, priorities, readGameResourceIndex()));
  ipcMain.handle('build:analyze', (_event, build) => analyzeBuild(build));
  ipcMain.handle('build:diagnose', (_event, build, profileId) => {
    const selectedProfileId = profileId || build?.profileId || null;
    const profile = appData.characterProfiles.find((row) => row.id === selectedProfileId) || null;
    const state = live?.snapshot() || {};
    const identity = state.characterIntel?.identity || {};
    const matchesLive = Boolean(profile && identity.playerId &&
      String(profile.playerId || profile.detectedPlayerId || '') === String(identity.playerId) &&
      Number(profile.lastSeasonId || profile.seasonId || 0) === Number(identity.seasonId || 0));
    const intel = matchesLive ? state.characterIntel
      : profile ? profile.characterIntelSnapshot || null
        : state.characterIntel || null;
    const observedEquipment = matchesLive ? state.equipment
      : profile?.equipmentSnapshot || profile?.characterIntelSnapshot?.equipment || null;
    return diagnoseBuild({
      build, profile, intel, equipment: observedEquipment,
      resourceIndex: readGameResourceIndex(), tlidbCatalog: readTlidbCatalog(), now: Date.now(),
    });
  });
  ipcMain.handle('farm:analyze', (_event, sessions, options = {}) => analyzeFarmingSessions(Array.isArray(sessions) ? sessions.slice(-1000) : [], { profileId: options.profileId || null, strategy: options.strategy || null, since: Number(options.since) || null }));
  ipcMain.handle('build:compare', (_event, left, right) => compareBuilds(left, right));
  ipcMain.handle('build:encode', (_event, build) => encodeBuild(build));
  ipcMain.handle('build:decode', (_event, code) => decodeBuild(code));
  ipcMain.handle('build:stat-fields', () => BUILD_STAT_FIELDS);
  ipcMain.handle('items:icon', (_event, id) => resolveCachedIcon(id));
  ipcMain.handle('prices:history', (_event, id, days = 30, seasonId = undefined) => {
    const itemId = Number(id);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) throw new Error('Неверный ID предмета');
    return live?.getPriceHistory(itemId, days, seasonId) || { itemId, points: [], minimum: null, maximum: null, latest: null, seasons: [], changePercent: null };
  });
  ipcMain.handle('app:open-external', async (_event, url) => {
    const parsed = new URL(String(url));
    if (!['https:'].includes(parsed.protocol)) throw new Error('Разрешены только HTTPS-ссылки');
    await shell.openExternal(parsed.href); return true;
  });

  ipcMain.on('overlay:close', () => overlay?.hide());
  ipcMain.on('overlay:drag', (_e, dx, dy) => { if (!overlay) return; const [x,y] = overlay.getPosition(); overlay.setPosition(x + Math.round(dx), y + Math.round(dy)); });
  ipcMain.on('overlay:toggle-mode', () => { appData.settings.overlayMode = appData.settings.overlayMode === 'expanded' ? 'compact' : 'expanded'; writeData(appData); });
  ipcMain.on('overlay:open-dashboard', openDashboard);
  overlay?.webContents.once('did-finish-load', () => overlay?.webContents.send('app:settings', appData.settings));
  registerGlobalHotkeys();
});
app.on('before-quit', () => { if (tlidbAutoSyncTimer) clearTimeout(tlidbAutoSyncTimer); live?.stop(); globalShortcut.unregisterAll(); });
app.on('window-all-closed', (e) => e.preventDefault());
