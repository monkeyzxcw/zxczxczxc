import { appendCharacterSnapshot, createCharacterSnapshot } from './snapshotHistory.js';

const normalizeName = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
const normalizeId = (value) => String(value ?? '').trim();

export function findCharacterProfile(profiles = [], playerName, seasonId = null, playerId = null) {
  const rows = Array.isArray(profiles) ? profiles : [];
  const wantedId = normalizeId(playerId);
  const wantedSeason = seasonId === null || seasonId === undefined ? null : Number(seasonId);
  if (wantedId) {
    const idMatches = rows.filter((profile) => normalizeId(profile?.playerId || profile?.detectedPlayerId) === wantedId);
    if (wantedSeason !== null) {
      // A known PlayerId in a new season is a new profile context; never silently bind it to an older season.
      return idMatches.find((profile) => Number(profile.lastSeasonId ?? profile.seasonId ?? profile.detectedSeasonId ?? 0) === wantedSeason) || null;
    }
    if (idMatches.length) return idMatches.slice().sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))[0];
  }
  const wanted = normalizeName(playerName);
  if (!wanted) return null;
  const matches = rows.filter((profile) => normalizeName(profile?.name) === wanted);
  if (!matches.length) return null;
  if (wantedSeason !== null) {
    const seasonMatch = matches.find((profile) => Number(profile.lastSeasonId ?? profile.seasonId ?? profile.detectedSeasonId ?? 0) === wantedSeason);
    if (seasonMatch) return seasonMatch;
  }
  return matches.slice().sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))[0];
}

export function createCharacterProfileFromIdentity(identity, now = Date.now()) {
  if (!identity?.name || !identity?.playerId || !Number.isFinite(Number(identity.seasonId))) return null;
  const playerId = normalizeId(identity.playerId);
  const seasonId = Number(identity.seasonId);
  const id = `char_${playerId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60)}_ss${seasonId}`;
  const seasonNumber = String(seasonId).length >= 4 ? Number(String(seasonId).slice(0, 2)) : seasonId;
  return {
    id, name: String(identity.name).trim(), playerId, detectedPlayerId: playerId,
    seasonId, detectedSeasonId: seasonId, lastSeasonId: seasonId,
    hero: identity.heroName || '', detectedHeroId: identity.heroId || null,
    specialization: identity.specializationName || '', detectedSpecializationId: identity.specializationId || null,
    level: Math.max(1, Math.min(100, Number(identity.level) || 1)), detectedLevel: Number(identity.level) || null,
    season: `SS${seasonNumber}`, notes: '', autoCreated: true,
    createdAt: now, updatedAt: now, lastSeenAt: now,
  };
}

/** Return a profile update only when meaningful live identity/context changed. */
export function updateProfileFromLive(profile, liveState, now = Date.now()) {
  if (!profile || !liveState?.player || normalizeName(profile.name) !== normalizeName(liveState.player)) return null;
  const identity = liveState.characterIntel?.identity || {};
  const seasonId = Number(liveState.seasonId || identity.seasonId) || null;
  const playerId = normalizeId(identity.playerId || profile.playerId || profile.detectedPlayerId);
  const area = String(liveState.area || '').trim() || null;
  const lastSeenAt = Number(profile.lastSeenAt) || 0;
  const changed = profile.lastArea !== area || Number(profile.lastSeasonId || 0) !== Number(seasonId || 0) ||
    (playerId && normalizeId(profile.playerId || profile.detectedPlayerId) !== playerId) || now - lastSeenAt >= 60_000;
  if (!changed) return null;
  return { ...profile, playerId: playerId || profile.playerId || null, detectedPlayerId: playerId || profile.detectedPlayerId || null,
    lastSeenAt: now, lastArea: area, lastSeasonId: seasonId, detectedSeasonId: seasonId,
    lastGameExe: liveState.gameExe || profile.lastGameExe || null, updatedAt: now };
}

export function buildProfileEquipmentSnapshot(equipment, seasonId = null, capturedAt = Date.now()) {
  const items = Array.isArray(equipment?.items) ? equipment.items : [];
  if (!items.length) return null;
  return {
    items: items.map((item) => ({ itemId: Number(item.itemId), name: String(item.name || `Предмет #${item.itemId}`),
      itemType: String(item.itemType || 'Тип неизвестен'), count: Math.max(1, Number(item.count) || 1),
      iconUrl: item.iconUrl || null, lastEquippedAt: Number(item.lastEquippedAt) || null,
      source: String(item.source || 'BagMgr · PutOn / PutOff') })),
    capturedAt, seasonId: seasonId == null ? null : Number(seasonId),
    source: String(equipment.source || 'BagMgr · PutOn / PutOff'),
    completeness: 'partial', slotMapping: 'not-available',
    lastTransition: equipment.lastTransition ? { ...equipment.lastTransition } : null,
    limitations: Array.isArray(equipment.limitations) ? equipment.limitations.slice(0, 20) : [
      'Это частичный снимок, построенный по наблюдаемым изменениям инвентаря.',
      'Слоты, аффиксы и роллы не определяются без явных данных лога.',
    ],
  };
}

export function captureProfileCharacterSnapshot(profile, intel, equipment = null, now = Date.now()) {
  if (!profile || !intel) return { profile, added: false, snapshot: null };
  const snapshot = createCharacterSnapshot(intel, equipment, now);
  const oldHistory = Array.isArray(profile.characterHistory) ? profile.characterHistory : [];
  const characterHistory = appendCharacterSnapshot(oldHistory, snapshot, { maxEntries: 60, retentionDays: 365 });
  const added = characterHistory.length > oldHistory.length || characterHistory.at(-1)?.fingerprint !== oldHistory.at(-1)?.fingerprint;
  return { profile: { ...profile, characterHistory, lastCharacterSnapshotAt: added ? now : profile.lastCharacterSnapshotAt || null,
    lastCharacterFingerprint: snapshot.fingerprint, updatedAt: added ? now : profile.updatedAt }, added, snapshot };
}
