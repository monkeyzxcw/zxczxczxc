const STAT_KEYS = new Set(['life','energyShield','mana','armor','evasion','fireRes','coldRes','lightningRes','erosionRes','critChance','critMultiplier','attackSpeed','castSpeed','moveSpeed','penetration','firePenetration','coldPenetration','lightningPenetration','erosionPenetration','physicalDamage','fireDamage','coldDamage','lightningDamage','erosionDamage','conversionPercent']);
const labels = {
  identity: 'Личность', stats: 'Характеристики', skills: 'Навыки', talents: 'Таланты',
  explicitEquipment: 'Экипировка из явных полей', partialEquipment: 'Наблюдаемые PutOn/PutOff', inventory: 'Сумка / хранилище',
};
const hours = (at, now) => at ? Math.max(0, (now - Number(at)) / 3600000) : null;
const safe = (value) => value === null || value === undefined || value === '' ? null : value;

export function buildCharacterReport({ profile = null, intel = null, equipment = null, builds = [], now = Date.now() } = {}) {
  const state = intel || profile?.characterIntelSnapshot || {};
  const identity = state.identity || {};
  const stats = Array.isArray(state.stats) ? state.stats : [];
  const skills = Array.isArray(state.skills) ? state.skills : [];
  const talents = Array.isArray(state.talents) ? state.talents : [];
  const explicitEquipment = Array.isArray(state.explicitEquipment) ? state.explicitEquipment : [];
  const partialEquipment = Array.isArray(equipment?.items) ? equipment.items : Array.isArray(state.equipment?.items) ? state.equipment.items : [];
  const latestInventory = state.latestInventory || (state.inventorySnapshots || []).at(-1) || null;
  const inventory = Array.isArray(latestInventory?.items) ? latestInventory.items : [];
  const ageHours = hours(state.lastObservedAt || state.capturedAt, now);
  const sections = [
    { key: 'identity', label: labels.identity, weight: 15, count: identity.playerId && identity.seasonId ? 1 : 0, status: identity.playerId && identity.seasonId ? 'verified' : 'missing', detail: identity.playerId && identity.seasonId ? 'PlayerId и SeasonId извлечены из GetPlayerData.' : 'Не найден полный PlayerId + SeasonId.' },
    { key: 'stats', label: labels.stats, weight: 25, count: stats.length, status: stats.length >= 8 ? 'partial' : stats.length ? 'partial' : 'missing', detail: `${stats.length} явно распознанных числовых полей из ${STAT_KEYS.size} известных показателей.` },
    { key: 'skills', label: labels.skills, weight: 12, count: skills.length, status: skills.length ? 'partial' : 'missing', detail: skills.length ? `${skills.length} явных ID навыков; названия зависят от доступности каталога.` : 'ID навыков не найдены.' },
    { key: 'talents', label: labels.talents, weight: 12, count: talents.length, status: talents.length ? 'partial' : 'missing', detail: talents.length ? `${talents.length} явных ID талантов/узлов.` : 'ID талантов не найдены.' },
    { key: 'explicitEquipment', label: labels.explicitEquipment, weight: 18, count: explicitEquipment.length, status: explicitEquipment.length ? 'verified' : 'missing', detail: explicitEquipment.length ? `${explicitEquipment.length} предметов найдены в явной структуре экипировки.` : 'Нет подтверждённого socket-снимка надетых предметов со слотами.' },
    { key: 'partialEquipment', label: labels.partialEquipment, weight: 8, count: partialEquipment.length, status: partialEquipment.length ? 'partial' : 'missing', detail: partialEquipment.length ? `${partialEquipment.length} типов предметов наблюдались через BagMgr PutOn/PutOff; слоты не подтверждены.` : 'Нет наблюдаемых изменений PutOn/PutOff.' },
    { key: 'inventory', label: labels.inventory, weight: 10, count: inventory.length, status: inventory.length ? 'observed' : 'missing', detail: inventory.length ? `${inventory.length} типов предметов в снимке ${latestInventory.action || 'инвентаря'}; это не экипировка.` : 'Нет снимка ResetItemsLayout/GetWareHousePage.' },
  ];
  const weighted = sections.reduce((sum, row) => sum + (row.count > 0 ? row.weight * (row.status === 'verified' ? 1 : row.status === 'partial' ? 0.65 : row.status === 'observed' ? 0.45 : 0) : 0), 0);
  const findings = [];
  const add = (severity, code, title, detail, action) => findings.push({ severity, code, title, detail, action });
  if (!identity.playerId || !identity.seasonId) add('warning', 'identity-incomplete', 'Не подтверждена личность персонажа', 'Без PlayerId и SeasonId нельзя надёжно разделять персонажей и сезоны.', 'Войди персонажем после включения логирования и повтори сканирование.');
  if (profile?.playerId && identity.playerId && String(profile.playerId) !== String(identity.playerId)) add('danger', 'profile-id-mismatch', 'Профиль не совпадает с игровым персонажем', `Профиль PlayerId ${profile.playerId}, лог PlayerId ${identity.playerId}.`, 'Не записывай текущий снимок в этот профиль; выбери правильного персонажа.');
  if (profile?.lastSeasonId && identity.seasonId && Number(profile.lastSeasonId) !== Number(identity.seasonId)) add('warning', 'season-mismatch', 'Сезон профиля и лога различается', `Профиль: ${profile.lastSeasonId}; лог: ${identity.seasonId}.`, 'Создай отдельный профиль сезона или подтверди перенос.');
  if (!stats.length) add('warning', 'stats-missing', 'Лист характеристик не восстановлен', 'В доступных сообщениях нет явных числовых полей персонажа.', 'Открой окно характеристик в игре, обнови данные персонажа и повтори сканирование.');
  else if (stats.length < 8) add('info', 'stats-partial', 'Характеристики восстановлены частично', `Найдено ${stats.length} полей; не все параметры могут присутствовать в логе.`, 'Сравни с игровым листом характеристик и внеси недостающие параметры вручную.');
  if (!skills.length) add('info', 'skills-missing', 'Навыки не обнаружены', 'Лог не содержит распознанных явных ID навыков.', 'Открой интерфейс навыков и обнови данные персонажа.');
  if (!talents.length) add('info', 'talents-missing', 'Таланты не обнаружены', 'Лог не содержит распознанных явных ID талантов.', 'Открой дерево талантов, если игра записывает его состояние, и повтори сканирование.');
  if (!explicitEquipment.length && partialEquipment.length) add('warning', 'equipment-partial', 'Экипировка известна только частично', 'Есть события PutOn/PutOff, но нет подтверждённых слотов и начального снимка.', 'Переэкипируй несколько вещей и проверь реальные строки PutOn/PutOff в диагностике.');
  if (!explicitEquipment.length && !partialEquipment.length) add('warning', 'equipment-missing', 'Надетая экипировка не восстановлена', 'Снимок сумки не считается списком надетых предметов.', 'Открой персонажа, измени экипировку и повтори сканирование.');
  if (ageHours !== null && ageHours > 24) add('warning', 'intel-stale', 'Данные персонажа устарели', `Последнее наблюдение было ${ageHours.toFixed(1)} ч назад.`, 'Пересканируй лог после входа на персонажа.');
  if (latestInventory?.truncated || latestInventory?.completeness === 'truncated') add('warning', 'inventory-truncated', 'Снимок инвентаря неполный', 'Сообщение снимка было обрезано парсером.', 'Повтори сортировку сумки/хранилища и проверь диагностику длины socket-сообщения.');

  const linkedBuilds = (Array.isArray(builds) ? builds : []).filter((build) => !profile || build.profileId === profile.id);
  if (!linkedBuilds.length) add('info', 'build-not-linked', 'Нет сохранённого билда профиля', 'Наблюдаемые данные ещё не сопоставлены с лабораторией билдов.', 'Создай билд из обнаруженных данных, затем дополни ручные цели и недостающие поля.');
  const buildConsistency = linkedBuilds.map((build) => {
    const mismatched = [];
    for (const row of stats) {
      const buildValue = safe(build.stats?.[row.key]);
      const observedValue = safe(row.value);
      if (buildValue !== null && observedValue !== null && Math.abs(Number(buildValue) - Number(observedValue)) > Math.max(0.0001, Math.abs(Number(observedValue)) * 0.0001)) {
        mismatched.push({ key: row.key, buildValue: Number(buildValue), observedValue: Number(observedValue), observedAt: row.observedAt, sourceAction: row.sourceAction });
      }
    }
    return { buildId: build.id, buildName: build.name, mismatchCount: mismatched.length, mismatched };
  });
  for (const row of buildConsistency) if (row.mismatchCount) add('warning', `build-observation-mismatch-${row.buildId}`, `Билд «${row.buildName}» отличается от данных лога`, `Несовпадений характеристик: ${row.mismatchCount}.`, 'Обнови снимок билда или проверь, не относятся ли значения к разным состояниям персонажа.');

  const statusCounts = sections.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});
  const completeness = Math.round(weighted);
  return {
    profileId: profile?.id || null,
    identity: identity.playerId ? { playerId: identity.playerId, name: identity.name, seasonId: identity.seasonId, heroId: identity.heroId, level: identity.level } : null,
    completeness, label: completeness >= 80 ? 'Хорошее покрытие данных' : completeness >= 50 ? 'Частично восстановлен' : completeness > 0 ? 'Мало данных' : 'Нет подтверждённых данных',
    sections, statusCounts, findings, buildConsistency, linkedBuildCount: linkedBuilds.length,
    freshnessHours: ageHours, messagesAnalyzed: Number(state.messagesAnalyzed) || 0,
    lastObservedAt: Number(state.lastObservedAt || state.capturedAt) || null,
    disclaimer: 'Показатель отражает полноту собранных данных, а не силу персонажа и не DPS. Неподтверждённые поля не додумываются.',
  };
}

export function buildAnonymizedDiagnostic({ intel = {}, gameLog = {}, equipment = {}, appVersion = '2.0.0', now = Date.now() } = {}) {
  return {
    schemaVersion: 1, appVersion, exportedAt: new Date(now).toISOString(),
    identity: { playerPresent: Boolean(intel.identity?.name), playerIdPresent: Boolean(intel.identity?.playerId), seasonId: intel.identity?.seasonId || null },
    intelligence: {
      messagesAnalyzed: Number(intel.messagesAnalyzed) || 0,
      lastObservedAt: Number(intel.lastObservedAt) || null,
      stats: (intel.stats || []).map((row) => ({ key: row.key, rawKey: row.rawKey, path: row.path, confidence: row.confidence, sourceAction: row.sourceAction, valueType: typeof row.value })),
      skills: (intel.skills || []).map((row) => ({ idPresent: Boolean(row.id), path: row.path, sourceAction: row.sourceAction, confidence: row.confidence })),
      talents: (intel.talents || []).map((row) => ({ idPresent: Boolean(row.id), path: row.path, sourceAction: row.sourceAction, confidence: row.confidence })),
      fieldSchema: (intel.fieldSchema || []).slice(-300),
      actions: intel.actions || {},
      lastUpdate: intel.lastUpdate ? { action: intel.lastUpdate.action, kind: intel.lastUpdate.kind, at: intel.lastUpdate.at,
        statsFound: intel.lastUpdate.statsFound, skillsFound: intel.lastUpdate.skillsFound, talentsFound: intel.lastUpdate.talentsFound, snapshotFound: intel.lastUpdate.snapshotFound } : null,
    },
    gameLog: { lines: Number(gameLog.gameLines) || 0, recognized: Number(gameLog.recognized) || 0,
      itemChanges: Number(gameLog.itemChanges) || 0, bagInit: Number(gameLog.bagInit) || 0,
      bagModify: Number(gameLog.bagModify) || 0, slotRebases: Number(gameLog.slotRebases) || 0,
      categories: gameLog.categoryCounts || {} },
    equipment: { itemTypes: Number(equipment.itemTypes) || 0, totalItems: Number(equipment.totalItems) || 0,
      stats: equipment.stats || {}, lastTransitionAction: equipment.lastTransition?.action || null },
    privacy: 'Не содержит имя персонажа, PlayerId, сырые строки лога, путь к файлу, цены, билды или данные аккаунта.',
  };
}
