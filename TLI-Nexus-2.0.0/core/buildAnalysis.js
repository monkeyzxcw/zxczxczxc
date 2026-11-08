const NUMBER_FIELDS = [
  ['life', 'Здоровье'], ['energyShield', 'Энергетический щит'], ['armor', 'Броня'], ['evasion', 'Уклонение'],
  ['fireRes', 'Сопротивление огню'], ['coldRes', 'Сопротивление холоду'],
  ['lightningRes', 'Сопротивление молнии'], ['erosionRes', 'Сопротивление эрозии'],
  ['critChance', 'Шанс критического удара'], ['critMultiplier', 'Множитель критического удара'],
  ['attackSpeed', 'Скорость атаки'], ['castSpeed', 'Скорость применения'], ['moveSpeed', 'Скорость передвижения'],
  ['penetration', 'Пробивание'], ['firePenetration', 'Пробивание огнём'], ['coldPenetration', 'Пробивание холодом'],
  ['lightningPenetration', 'Пробивание молнией'], ['erosionPenetration', 'Пробивание эрозией'],
  ['physicalDamage', 'Физический урон'], ['fireDamage', 'Огненный урон'], ['coldDamage', 'Урон холодом'],
  ['lightningDamage', 'Урон молнией'], ['erosionDamage', 'Урон эрозией'],
  ['conversionPercent', 'Преобразование основного урона'], ['mana', 'Максимальная мана'],
];
const asNumber = (v) => v === '' || v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const id = () => `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;

export const BUILD_STAT_FIELDS = NUMBER_FIELDS.map(([key, label]) => ({ key, label }));
export function normalizeBuild(input = {}) {
  const stats = {};
  for (const [key] of NUMBER_FIELDS) stats[key] = asNumber(input.stats?.[key]);
  const targets = {};
  for (const [key] of NUMBER_FIELDS) targets[key] = asNumber(input.targets?.[key]);
  const gearSlots = Array.isArray(input.gearSlots) ? input.gearSlots.slice(0, 12) : [];
  const skills = Array.isArray(input.skills) ? input.skills.slice(0, 12) : [];
  const talents = Array.isArray(input.talents) ? input.talents.slice(0, 30) : [];
  const observedInventory = Array.isArray(input.observedInventory) ? input.observedInventory.slice(0, 300).map((x) => String(x).slice(0, 300)) : [];
  const observedStats = Array.isArray(input.observedStats) ? input.observedStats.slice(0, 100).map((x) => ({
    key: String(x.key || '').slice(0, 80), value: asNumber(x.value), rawKey: String(x.rawKey || '').slice(0, 100),
    path: String(x.path || '').slice(0, 200), sourceAction: String(x.sourceAction || '').slice(0, 80),
    sourceKind: String(x.sourceKind || '').slice(0, 40), observedAt: Number(x.observedAt) || null, confidence: String(x.confidence || '').slice(0, 40),
  })) : [];
  const engineConfig = input.engineConfig && typeof input.engineConfig === 'object' && !Array.isArray(input.engineConfig)
    ? input.engineConfig : {};
  return {
    id: String(input.id || id()), profileId: input.profileId ? String(input.profileId).slice(0, 120) : null,
    investmentFe: asNumber(input.investmentFe), name: String(input.name || 'Новый билд').slice(0, 100),
    hero: String(input.hero || '').slice(0, 100), level: Math.max(1, Math.min(100, Number(input.level) || 1)),
    season: String(input.season || 'SS14 · Tartarus').slice(0, 50), mainSkill: String(input.mainSkill || '').slice(0, 100),
    damageType: String(input.damageType || '').slice(0, 40), expectsFullConversion: input.expectsFullConversion === true,
    notes: String(input.notes || '').slice(0, 4000), stats, targets, gearSlots, skills, talents, observedInventory, observedStats, engineConfig,
    updatedAt: Number(input.updatedAt) || Date.now(), createdAt: Number(input.createdAt) || Date.now(),
  };
}

/** Rule-based consistency checks only. Does not claim to simulate in-game DPS. */
export function analyzeBuild(input = {}) {
  const build = normalizeBuild(input);
  const findings = [];
  const knownStats = Object.values(build.stats).filter((v) => v !== null).length;
  const totalSlots = 12;
  const occupiedSlots = build.gearSlots.filter((x) => String(x || '').trim()).length;
  const add = (severity, code, title, detail, action = '') => findings.push({ severity, code, title, detail, action });

  if (!build.hero) add('info', 'hero-missing', 'Не выбран герой', 'Укажи героя, чтобы сохранять профиль в контексте специализации.');
  if (!build.mainSkill) add('warning', 'skill-missing', 'Не указан основной навык', 'Без основного навыка нельзя проверить синергию поддержек и талантов.');
  if (build.expectsFullConversion && build.stats.conversionPercent !== null && build.stats.conversionPercent < 100) {
    add('warning', 'conversion-incomplete', 'Преобразование урона не завершено', `Указано ${build.stats.conversionPercent}%, а в настройке билда требуется 100%.`, 'Проверь источники преобразования на экипировке и талантах.');
  }
  if (build.stats.conversionPercent !== null && build.stats.conversionPercent > 100) {
    add('info', 'conversion-overflow', 'Преобразование выше 100%', 'Проверь, складываются ли введённые источники аддитивно и не учтён ли один источник дважды.');
  }
  for (const [key, label] of NUMBER_FIELDS) {
    const current = build.stats[key], target = build.targets[key];
    if (current !== null && target !== null && current < target) {
      add('warning', `below-target-${key}`, `${label} ниже твоей цели`, `${current} / ${target} (не хватает ${Number((target-current).toFixed(2))}).`, `Проверь слоты экипировки и таланты, влияющие на «${label.toLowerCase()}».`);
    }
  }
  if (occupiedSlots > 0 && occupiedSlots < totalSlots) add('info', 'gear-incomplete', 'Экипировка заполнена не полностью', `Заполнено ${occupiedSlots} из ${totalSlots} полей экипировки.`, 'Добавь остальные предметы или очисти поля, которые не используются в твоей сборке.');
  const duplicateGear = build.gearSlots.map((x) => String(x || '').trim()).filter(Boolean).filter((x, i, a) => a.indexOf(x) !== i);
  if (duplicateGear.length) add('warning', 'duplicate-gear', 'Повторяются предметы в слотах', `Повтор: ${[...new Set(duplicateGear)].join(', ')}.`, 'Проверь, не продублирован ли предмет при вводе.');
  if (knownStats < 4) add('info', 'insufficient-stats', 'Недостаточно характеристик', 'Добавь хотя бы здоровье, защитные показатели и параметры основного урона. Анализ пока неполный.');
  if (build.skills.length === 0) add('info', 'skills-empty', 'Навыки не описаны', 'Добавь основной навык и навыки поддержки, чтобы вести карту синергии.');
  if (build.talents.length === 0) add('info', 'talents-empty', 'Таланты не описаны', 'Добавь ключевые таланты и их эффекты.');
  if (!findings.length) add('success', 'no-known-issues', 'Противоречий по введённым данным не найдено', 'Это не подтверждение оптимальности билда: проверены только заполненные поля и заданные тобой цели.');

  const completeness = Math.round((knownStats / NUMBER_FIELDS.length) * 55 + (occupiedSlots / totalSlots) * 25 + (Boolean(build.mainSkill) * 10) + (Boolean(build.hero) * 10));
  return { build, findings, completeness: Math.max(0, Math.min(100, completeness)), knownStats, totalStats: NUMBER_FIELDS.length,
    occupiedSlots, totalSlots, disclaimer: 'Проверка согласованности и пользовательских целей. Не является игровым DPS-симулятором и не использует неподтверждённые формулы.' };
}

export function compareBuilds(a, b) {
  const left = normalizeBuild(a), right = normalizeBuild(b);
  const rows = NUMBER_FIELDS.map(([key, label]) => ({ kind: 'stat', key, label, left: left.stats[key], right: right.stats[key],
    delta: left.stats[key] === null || right.stats[key] === null ? null : Number((right.stats[key] - left.stats[key]).toFixed(3)) }));
  const parseGear = (entries) => {
    const result = new Map();
    entries.forEach((entry, index) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const slot = String(entry.slot || `Позиция ${index + 1}`).trim();
        const item = String(entry.item || entry.name || '').trim() || '—';
        result.set(slot, item);
        return;
      }
      const value = String(entry || '').trim();
      const separator = value.indexOf(':');
      if (separator > 0 && separator < 32) result.set(value.slice(0, separator).trim(), value.slice(separator + 1).trim() || '—');
      else result.set(`gear-${index}`, value || '—');
    });
    return result;
  };
  const leftGear = parseGear(left.gearSlots), rightGear = parseGear(right.gearSlots);
  for (const slot of new Set([...leftGear.keys(), ...rightGear.keys()])) {
    const l = leftGear.get(slot) || '—', r = rightGear.get(slot) || '—';
    if (l !== r) {
      const isPosition = /^gear-\d+$/.test(slot);
      const position = isPosition ? Number(slot.slice(5)) + 1 : null;
      rows.push({ kind: 'gear', key: isPosition ? slot : `gear:${slot}`, label: isPosition ? `Экипировка · позиция ${position}` : `Экипировка · ${slot}`, left: l, right: r, delta: null, changed: true });
    }
  }
  for (const [key, label] of [['skills', 'Навыки и поддержки'], ['talents', 'Ключевые таланты']]) {
    const l = left[key].join(' · ') || '—';
    const r = right[key].join(' · ') || '—';
    if (l !== r) rows.push({ kind: key, key, label, left: l, right: r, delta: null, changed: true });
  }
  const leftObservedStats = left.observedStats.map((x) => `${x.key}=${x.value ?? '—'} [${x.sourceAction || 'unknown'}]`).join(' · ') || '—';
  const rightObservedStats = right.observedStats.map((x) => `${x.key}=${x.value ?? '—'} [${x.sourceAction || 'unknown'}]`).join(' · ') || '—';
  if (leftObservedStats !== rightObservedStats) rows.push({ kind: 'observedStats', key: 'observedStats', label: 'Наблюдаемые показатели из игрового лога', left: leftObservedStats, right: rightObservedStats, delta: null, changed: true });
  const leftInventory = left.observedInventory.join(' · ') || '—';
  const rightInventory = right.observedInventory.join(' · ') || '—';
  if (leftInventory !== rightInventory) rows.push({ kind: 'observedInventory', key: 'observedInventory', label: 'Наблюдаемые снимки инвентаря (не экипировка)', left: leftInventory, right: rightInventory, delta: null, changed: true });
  if (left.investmentFe !== right.investmentFe) rows.push({ kind: 'investment', key: 'investmentFe', label: 'Вложено в билд, FE', left: left.investmentFe, right: right.investmentFe,
    delta: left.investmentFe === null || right.investmentFe === null ? null : Number((right.investmentFe - left.investmentFe).toFixed(2)) });
  return rows;
}

export function encodeBuild(input) {
  const build = normalizeBuild(input);
  const json = JSON.stringify(build);
  const encoded = Buffer.from(json, 'utf8').toString('base64url');
  return `NEXUS1.${encoded}`;
}
export function decodeBuild(code) {
  const match = /^NEXUS1\.([A-Za-z0-9_-]+)$/.exec(String(code || '').trim());
  if (!match) throw new Error('Неверный код билда Nexus');
  const decoded = Buffer.from(match[1], 'base64url').toString('utf8');
  if (decoded.length > 100_000) throw new Error('Код билда слишком большой');
  return normalizeBuild(JSON.parse(decoded));
}
