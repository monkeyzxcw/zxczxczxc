import { calculateWithTliBuilder, getTliBuilderCatalogs, getTliBuilderStatus } from './tliBuilderBridge.js';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const cleanId = (value) => {
  const id = String(value ?? '').trim();
  return id && id.length <= 120 ? id : null;
};
const numericSlot = (value) => {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const slot = Number(raw);
  return Number.isInteger(slot) && slot >= 1 && slot <= 9 ? slot : null;
};
const uniqueBy = (rows, key) => [...new Map(rows.map((row) => [key(row), row])).values()];

function normalizeSkills(intelSkills, configuredSkills, warnings, catalogSkills = []) {
  const knownIds = new Set(catalogSkills.map((row) => cleanId(row.id ?? row.skill_id)).filter(Boolean));
  if (Array.isArray(configuredSkills) && configuredSkills.length) {
    return configuredSkills.slice(0, 40).filter((row) => {
      const slot = numericSlot(row?.slot);
      const skillId = cleanId(row?.skill_id ?? row?.skillId ?? row?.id);
      if (!slot || !skillId) {
        warnings.push('Часть ручных навыков пропущена: нужны числовой слот 1–9 и точный skill_id.');
        return false;
      }
      return true;
    }).map((row) => ({
      slot: numericSlot(row.slot),
      skill_id: cleanId(row.skill_id ?? row.skillId ?? row.id),
      level: Math.max(1, Math.min(100, Number(row.level) || 1)),
      enabled: row.enabled !== false,
    })).map((row) => {
      if (knownIds.size && !knownIds.has(row.skill_id)) warnings.push('Ручной skill_id '+row.skill_id+' отсутствует в каталоге активного сезона; движок может вернуть unsupported.');
      return row;
    });
  }

  const rows = [];
  for (const row of Array.isArray(intelSkills) ? intelSkills : []) {
    const slot = numericSlot(row.slot);
    const skillId = cleanId(row.id);
    if (!slot || !skillId) continue;
    const levelField = String(row.levelField || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const hasLevel = levelField === 'skilllevel' && Number.isInteger(Number(row.level)) && Number(row.level) > 0;
    rows.push({ slot, skill_id: skillId, level: hasLevel ? Number(row.level) : 1, enabled: true, observedAt: Number(row.observedAt) || 0 });
    if (!hasLevel) warnings.push(`Для навыка ID ${skillId} уровень не был найден; использован API-default 1. Проверь его перед расчётом.`);
  }
  for (const row of rows) if (knownIds.size && !knownIds.has(row.skill_id)) warnings.push('Навык ID '+row.skill_id+' отсутствует в каталоге активного сезона TLIBuilder; движок может вернуть unsupported.');
  const latestBySlot = new Map();
  for (const row of rows) {
    const previous = latestBySlot.get(row.slot);
    if (!previous || Number(row.observedAt || 0) >= Number(previous.observedAt || 0)) latestBySlot.set(row.slot, row);
  }
  return [...latestBySlot.values()].sort((a, b) => a.slot - b.slot).map(({ observedAt, ...row }) => row);
}

function resolveMainSkill(build, intelSkills, configuredMainSkill, skills, warnings, catalogSkills = []) {
  const configured = object(configuredMainSkill);
  if (configured.skill_id || configured.skillId) {
    const skillId = cleanId(configured.skill_id ?? configured.skillId);
    if (!skillId) return null;
    return { skill_id: skillId, level: Math.max(1, Math.min(100, Number(configured.level) || 1)) };
  }
  const wanted = String(build?.mainSkill || '').trim().toLocaleLowerCase('ru');
  if (!wanted) return null;
  const match = (Array.isArray(intelSkills) ? intelSkills : []).find((row) => {
    const id = String(row.id ?? '').trim().toLocaleLowerCase('ru');
    const catalog = catalogSkills.find((item) => cleanId(item.id ?? item.skill_id) === cleanId(row.id));
    const name = String(row.name ?? catalog?.name ?? catalog?.display_name ?? '').trim().toLocaleLowerCase('ru');
    return wanted === id || (name && wanted === name);
  });
  if (!match) {
    warnings.push('Основной навык из поля билда не совпал с подтверждённым ID/названием из лога. DPS не рассчитывается, пока не указан точный skill_id.');
    return null;
  }
  const skillId = cleanId(match.id);
  if (!skillId) return null;
  const slotted = skills.find((row) => row.skill_id === skillId);
  if (!slotted) {
    warnings.push('Основной навык найден в истории Character Intelligence, но сейчас не подтверждён в активном слоте 1–9. DPS не рассчитывается как для экипированного навыка.');
    return null;
  }
  return { skill_id: skillId, level: Math.max(1, Number(match.level) || Number(slotted?.level) || 1) };
}

export function buildTliBuilderRequest({ build = {}, intel = {}, profile = null, catalogs = {} } = {}) {
  const config = object(build.engineConfig);
  const warnings = [];
  const intelSkills = Array.isArray(intel.skills) ? intel.skills : [];
  const catalogSkills = Array.isArray(catalogs.skills) ? catalogs.skills : [];
  const skills = normalizeSkills(intelSkills, config.skills, warnings, catalogSkills);
  const main_skill = resolveMainSkill(build, intelSkills, config.main_skill, skills, warnings, catalogSkills);

  const configuredSlots = Array.isArray(config.slots) && config.slots.length ? config.slots : null;
  const talentMatches = [];
  const treeRows = Array.isArray(catalogs.trees) ? catalogs.trees : [];
  const nodeIndex = new Map();
  for (const tree of treeRows) for (const node of (tree.nodes || [])) {
    const gameId = cleanId(node.game_id);
    if (!gameId) continue;
    const list = nodeIndex.get(gameId) || [];
    list.push({ treeName: tree.name, nodeId: node.id }); nodeIndex.set(gameId, list);
  }
  for (const row of (Array.isArray(intel.talents) ? intel.talents : [])) {
    const matches = nodeIndex.get(cleanId(row.id)) || [];
    if (matches.length === 1 && matches[0].treeName && matches[0].nodeId) talentMatches.push({ ...matches[0], observed: row });
    else if (matches.length > 1) warnings.push('ID таланта '+row.id+' найден в нескольких деревьях TLIBuilder; автоматическое сопоставление пропущено.');
  }
  const autoTreeMap = new Map();
  for (const match of talentMatches) {
    const nodeStates = autoTreeMap.get(match.treeName) || {};
    const rankField = String(match.observed.levelField || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    const rank = Number(match.observed.level);
    const rankIsExplicit = ['talentlevel', 'nodelevel'].includes(rankField) && Number.isInteger(rank) && rank >= 1 && rank <= 5;
    nodeStates[match.nodeId] = rankIsExplicit ? rank : 1;
    if (!rankIsExplicit) warnings.push('Для узла '+match.nodeId+' не найдено подтверждённое число очков TalentLevel/NodeLevel; для пробного расчёта выставлено 1 очко. Проверь распределение вручную.');
    autoTreeMap.set(match.treeName, nodeStates);
  }
  const rawSlots = configuredSlots || [...autoTreeMap.entries()].map(([treeName, nodeStates]) => ({ treeName, nodeStates }));
  if (!configuredSlots && talentMatches.length) warnings.push('Часть талантов автоматически сопоставлена по точному game_id каталога сезона. Проверь очки узлов: лог не всегда сообщает распределение рангов.');

  const slots = rawSlots.slice(0, 12).map((slot) => {
    if (slot === null) return null;
    const treeName = String(slot?.treeName || '').trim();
    const nodeStates = object(slot?.nodeStates);
    if (!treeName || treeName.length > 100) {
      warnings.push('Некорректный talent tree slot пропущен.');
      return null;
    }
    return { treeName, nodeStates, ...(object(slot.coreTalentSelections) && Object.keys(object(slot.coreTalentSelections)).length
      ? { coreTalentSelections: object(slot.coreTalentSelections) } : {}) };
  });

  if (!slots.some(Boolean)) warnings.push('Деревья талантов не восстановлены: ID из лога не совпали с game_id узлов активного каталога, либо каталог сезона пуст. Расчёт не учитывает таланты.');
  const buildSeasonKey = String(build.season || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const catalogSeasonKey = String(catalogs.season || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (buildSeasonKey && catalogSeasonKey && !buildSeasonKey.includes(catalogSeasonKey) && !catalogSeasonKey.includes(buildSeasonKey)) warnings.push('Сезон билда ('+build.season+') отличается от активного сезона TLIBuilder ('+catalogs.season+'). Проверь, что выбрана правильная база.');
  if (!Array.isArray(config.gear) || !config.gear.length) {
    warnings.push('Экипировка не передана в движок: наблюдаемые PutOn/PutOff и ID предметов не содержат полного набора слотов и строк аффиксов. Для корректного расчёта экипировку нужно указать в engineConfig.gear.');
  }
  if (!main_skill) warnings.push('Основной навык не подтверждён точным ID. Результат не будет содержать достоверный DPS основного навыка.');
  if (!skills.length) warnings.push('Нет навыков с подтверждёнными числовыми слотами 1–9 и ID.');

  const payload = {
    slots,
    slates: Array.isArray(config.slates) ? config.slates.slice(0, 40) : [],
    prisms: Array.isArray(config.prisms) ? config.prisms.slice(0, 20) : [],
    condition_state: object(config.condition_state),
    gear: Array.isArray(config.gear) ? config.gear.slice(0, 40) : [],
    character: Array.isArray(config.character) ? config.character.slice(0, 100) : [],
    skills,
    ...(main_skill ? { main_skill } : {}),
    characterLevel: Math.max(1, Math.min(100, Number(build.level || profile?.level || intel.identity?.level) || 1)),
    ...(cleanId(config.trait_id ?? profile?.detectedSpecializationId) ? { trait_id: cleanId(config.trait_id ?? profile?.detectedSpecializationId) } : {}),
    trait_slot_levels: Array.isArray(config.trait_slot_levels) ? config.trait_slot_levels.slice(0, 4).map((x) => Math.max(1, Math.min(5, Number(x) || 1))) : [],
    advanced_trait_selections: Array.isArray(config.advanced_trait_selections) ? config.advanced_trait_selections.slice(0, 20).map(String) : [],
    custom_mods: Array.isArray(config.custom_mods) ? config.custom_mods.slice(0, 100).map(String) : [],
    attached_supports: Array.isArray(config.attached_supports) ? config.attached_supports.slice(0, 40) : [],
    memory_effects: Array.isArray(config.memory_effects) ? config.memory_effects.slice(0, 40) : [],
    spirit_effects: Array.isArray(config.spirit_effects) ? config.spirit_effects.slice(0, 40) : [],
    trait_effects: Array.isArray(config.trait_effects) ? config.trait_effects.slice(0, 40) : [],
    invalid_slots: Array.isArray(config.invalid_slots) ? config.invalid_slots.slice(0, 9).map(Number).filter((x) => Number.isInteger(x) && x >= 1 && x <= 9) : [],
    uptime_mode: config.uptime_mode === 'real' ? 'real' : 'max',
    ...(config.target_config && typeof config.target_config === 'object' ? { target_config: config.target_config } : {}),
    ...(config.enemy_config && typeof config.enemy_config === 'object' ? { enemy_config: config.enemy_config } : {}),
  };

  const confirmedStats = Array.isArray(intel.stats) ? intel.stats.length : 0;
  const explicitGear = Array.isArray(intel.explicitEquipment) ? intel.explicitEquipment.length : 0;
  const observedTalents = Array.isArray(intel.talents) ? intel.talents.length : 0;
  const configuredTreeNodes = slots.reduce((sum, slot) => sum + Object.keys(slot?.nodeStates || {}).length, 0);
  const configuredGear = payload.gear.length;
  const coverage = {
    skills: { observed: intelSkills.length, mapped: skills.length, mainSkillMapped: Boolean(main_skill) },
    talents: { observedIds: observedTalents, configuredTrees: slots.filter(Boolean).length, configuredNodes: configuredTreeNodes },
    equipment: { observedExplicitItems: explicitGear, engineItems: configuredGear },
    observedStatFields: confirmedStats,
    warnings: [...new Set(warnings)],
    readyForDps: Boolean(main_skill && skills.length && configuredGear && configuredTreeNodes),
    readyForDefense: Boolean(configuredGear || payload.character.length),
  };
  return { payload, coverage };
}

export async function calculateTliBuilderBuild(input) {
  const status = await getTliBuilderStatus();
  if (!status.connected) {
    return { connected: false, status, coverage: null, result: null };
  }
  const catalogs = await getTliBuilderCatalogs();
  const { payload, coverage } = buildTliBuilderRequest({ ...input, catalogs });
  coverage.catalogs = { season: catalogs.season, skills: catalogs.skills.length, trees: catalogs.trees.length };
  const result = await calculateWithTliBuilder(payload);
  return { connected: true, status, coverage, result };
}
