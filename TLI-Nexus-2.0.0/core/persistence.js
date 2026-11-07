export const DEFAULT_APP_DATA = Object.freeze({
  schemaVersion: 3,
  settings: Object.freeze({
    overlayMode: 'compact', overlayOpacity: 94, overlayScale: 100, clickThrough: false, autoSelectDetectedProfile: true, autoCreateDetectedProfiles: true,
    alwaysOnTop: true, notificationsEnabled: true, soundEnabled: true,
    notificationThresholdFe: 20, soundVolume: 45, showRecentLoot: true, hotkeysEnabled: true,
  }),
  characterProfiles: [], builds: [], tactics: [], farmingSessions: [], priceWatch: [], notes: [],
});

function safeArray(value, max) { return Array.isArray(value) ? value.slice(-max) : []; }

export function mergeAppData(value = {}) {
  const x = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...DEFAULT_APP_DATA,
    ...x,
    schemaVersion: 3,
    settings: { ...DEFAULT_APP_DATA.settings, ...(x.settings && typeof x.settings === 'object' ? x.settings : {}) },
    characterProfiles: safeArray(x.characterProfiles, 100).map((profile) => ({ ...profile, playerId: profile.playerId || profile.detectedPlayerId || null, characterHistory: safeArray(profile.characterHistory, 60), equipmentHistory: safeArray(profile.equipmentHistory, 20) })),
    builds: safeArray(x.builds, 500),
    tactics: safeArray(x.tactics, 500),
    farmingSessions: safeArray(x.farmingSessions, 1000),
    priceWatch: safeArray(x.priceWatch, 500),
    priceHistory: safeArray(x.priceHistory, 20000),
    notes: safeArray(x.notes, 500),
  };
}

/**
 * Merge a renderer's possibly stale snapshot with the latest main-process state.
 * Live session metrics are owned by the main process; renderer edits such as
 * costs/strategy are retained, but stale metrics can never roll the session back.
 */
export function mergeRendererUpdate(currentValue, rendererValue) {
  const current = mergeAppData(currentValue);
  const incoming = mergeAppData(rendererValue);
  const rows = new Map(incoming.farmingSessions.map((row) => [row.sessionKey || row.id, { ...row }]));

  for (const liveRow of current.farmingSessions.filter((row) => row.source === 'live')) {
    const key = liveRow.sessionKey || liveRow.id;
    const rendererRow = rows.get(key);
    if (!rendererRow) {
      rows.set(key, { ...liveRow });
      continue;
    }
    rows.set(key, {
      ...rendererRow,
      // Main-process telemetry is authoritative.
      player: liveRow.player || rendererRow.player,
      profileId: liveRow.profileId || rendererRow.profileId || null,
      area: liveRow.area || rendererRow.area,
      startedAt: liveRow.startedAt || rendererRow.startedAt,
      endedAt: liveRow.endedAt ?? rendererRow.endedAt ?? null,
      durationSec: Math.max(Number(rendererRow.durationSec) || 0, Number(liveRow.durationSec) || 0),
      lootValueFe: Number(liveRow.lootValueFe) || 0,
      feGained: Number(liveRow.feGained) || 0,
      itemCount: Number(liveRow.itemCount) || 0,
      pickupEvents: Number(liveRow.pickupEvents) || 0,
      // Costs and strategy are user-entered fields, so keep the renderer's edit.
      costsFe: Number(rendererRow.costsFe ?? liveRow.costsFe) || 0,
      strategy: rendererRow.strategy || liveRow.strategy,
      updatedAt: Math.max(Number(rendererRow.updatedAt) || 0, Number(liveRow.updatedAt) || 0, Date.now()),
    });
  }

  incoming.farmingSessions = [...rows.values()].slice(-1000);

  // Merge telemetry-owned profile fields from main process into a stale renderer snapshot.
  const currentProfiles = new Map(current.characterProfiles.map((profile) => [profile.id, profile]));
  incoming.characterProfiles = incoming.characterProfiles.map((profile) => {
    const latest = currentProfiles.get(profile.id);
    if (!latest) return profile;
    const merged = { ...profile };
    if (Number(latest.lastSeenAt || 0) > Number(profile.lastSeenAt || 0)) {
      merged.lastSeenAt = latest.lastSeenAt; merged.lastArea = latest.lastArea;
      merged.lastSeasonId = latest.lastSeasonId; merged.lastGameExe = latest.lastGameExe;
    }
    const latestGearAt = Number(latest.equipmentSnapshot?.lastTransitionAt || latest.equipmentSnapshot?.capturedAt || 0);
    const rendererGearAt = Number(profile.equipmentSnapshot?.lastTransitionAt || profile.equipmentSnapshot?.capturedAt || 0);
    if (latestGearAt > rendererGearAt) merged.equipmentSnapshot = latest.equipmentSnapshot;
    if ((latest.equipmentHistory?.length || 0) > (merged.equipmentHistory?.length || 0)) {
      merged.equipmentHistory = latest.equipmentHistory;
    }
    const history = new Map();
    for (const snapshot of [...(merged.characterHistory || []), ...(latest.characterHistory || [])]) {
      const key = snapshot.fingerprint || snapshot.id;
      if (key) history.set(key, snapshot);
    }
    merged.characterHistory = [...history.values()].sort((a, b) => Number(a.capturedAt || 0) - Number(b.capturedAt || 0)).slice(-60);
    if (Number(latest.lastCharacterSnapshotAt || 0) > Number(merged.lastCharacterSnapshotAt || 0)) {
      merged.lastCharacterSnapshotAt = latest.lastCharacterSnapshotAt;
      merged.lastCharacterFingerprint = latest.lastCharacterFingerprint;
    }
    const latestIntelAt = Number(latest.characterIntelSnapshot?.lastObservedAt || 0);
    const rendererIntelAt = Number(merged.characterIntelSnapshot?.lastObservedAt || 0);
    if (latestIntelAt > rendererIntelAt) {
      merged.characterIntelSnapshot = latest.characterIntelSnapshot;
      merged.detectedHeroId = latest.detectedHeroId || merged.detectedHeroId;
      merged.detectedLevel = latest.detectedLevel || merged.detectedLevel;
      merged.detectedSpecializationId = latest.detectedSpecializationId || merged.detectedSpecializationId;
    }
    return merged;
  });

  // Price-watch trigger state is owned by the main process and must survive stale renderer writes.
  const currentWatch = new Map(current.priceWatch.map((row) => [Number(row.itemId), row]));
  incoming.priceWatch = incoming.priceWatch.map((row) => {
    const latest = currentWatch.get(Number(row.itemId));
    if (!latest) return row;
    const merged = { ...row };
    if (Number(latest.priceStatusUpdatedAt || 0) >= Number(row.priceStatusUpdatedAt || 0)) {
      for (const key of ['wasBelowTarget', 'lastAlertAt', 'lastObservedPriceFe', 'lastPriceSource', 'priceStatusUpdatedAt']) {
        if (Object.hasOwn(latest, key)) merged[key] = latest[key];
      }
    }
    return merged;
  });
  return incoming;
}
