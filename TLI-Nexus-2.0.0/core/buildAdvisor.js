const clean = (value, max = 180) => String(value ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);
const norm = (value) => clean(value, 300).toLocaleLowerCase('en').replace(/[^a-z0-9а-яё]+/giu, '');
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;

const STAT_ALIASES = new Map([
  ['life', ['life','maxlife','lifemax','maxhp','hpmax','maxhealth','healthmax','lifeflat','maximumlife']],
  ['energyShield', ['energyshield','maxenergyshield','energyshieldmax','maxes','maxshield','shieldmax']],
  ['mana', ['mana','maxmana','manamax']],
  ['armor', ['armor','armour','defensearmor']],
  ['evasion', ['evasion','dodge']],
  ['fireRes', ['fireres','fireresist','fireresistance','fire_resistance']],
  ['coldRes', ['coldres','coldresist','coldresistance','cold_resistance']],
  ['lightningRes', ['lightningres','lightningresist','lightningresistance','lightning_resistance']],
  ['erosionRes', ['erosionres','erosionresist','erosionresistance','erosion_resistance']],
  ['critChance', ['critchance','criticalstrikechance','criticalchance']],
  ['critMultiplier', ['critdamage','critmultiplier','criticalstrikemultiplier','criticaldamage']],
  ['attackSpeed', ['attackspeed','attack_speed']],
  ['castSpeed', ['castspeed','cast_speed']],
  ['moveSpeed', ['movespeed','movementspeed','movement_speed']],
  ['penetration', ['penetration','damagepenetration']],
  ['firePenetration', ['firepenetration','firepen']],
  ['coldPenetration', ['coldpenetration','coldpen']],
  ['lightningPenetration', ['lightningpenetration','lightningpen']],
  ['erosionPenetration', ['erosionpenetration','erosionpen']],
  ['physicalDamage', ['physicaldamage','physdamage']],
  ['fireDamage', ['firedamage','firebasedamage']],
  ['coldDamage', ['colddamage','coldbasedamage']],
  ['lightningDamage', ['lightningdamage','lightningbasedamage']],
  ['erosionDamage', ['erosiondamage','erosionbasedamage']],
  ['conversionPercent', ['conversionpercent','totaldamageconversionpercent','damageconversionpercent']],
]);
const STAT_LABELS = {
  life:'Здоровье', energyShield:'Энергетический щит', mana:'Мана', armor:'Броня', evasion:'Уклонение',
  fireRes:'Сопротивление огню', coldRes:'Сопротивление холоду', lightningRes:'Сопротивление молнии',
  erosionRes:'Сопротивление эрозии', critChance:'Шанс крита', critMultiplier:'Множитель крита',
  attackSpeed:'Скорость атаки', castSpeed:'Скорость применения', moveSpeed:'Скорость передвижения',
  penetration:'Пробивание', firePenetration:'Пробивание огнём', coldPenetration:'Пробивание холодом',
  lightningPenetration:'Пробивание молнией', erosionPenetration:'Пробивание эрозией',
  physicalDamage:'Физический урон', fireDamage:'Урон огнём', coldDamage:'Урон холодом',
  lightningDamage:'Урон молнией', erosionDamage:'Урон эрозией', conversionPercent:'Преобразование урона',
};
const ALIASES_BY_KEY = new Map();
for (const [canonical, aliases] of STAT_ALIASES) {
  for (const alias of aliases) ALIASES_BY_KEY.set(norm(alias), canonical);
}
const LABEL_ALIASES = new Map([
  ['maximumlife','life'],['maxlife','life'],['health','life'],['life','life'],
  ['maximumenergyshield','energyShield'],['energyshield','energyShield'],
  ['fireresistance','fireRes'],['fire resistance','fireRes'],
  ['coldresistance','coldRes'],['cold resistance','coldRes'],
  ['lightningresistance','lightningRes'],['lightning resistance','lightningRes'],
  ['erosionresistance','erosionRes'],['erosion resistance','erosionRes'],
  ['movement speed','moveSpeed'],['movement speed bonus','moveSpeed'],
  ['attack speed','attackSpeed'],['cast speed','castSpeed'],
  ['critical strike chance','critChance'],['critical strike damage','critMultiplier'],
  ['fire damage','fireDamage'],['cold damage','coldDamage'],['lightning damage','lightningDamage'],
  ['physical damage','physicalDamage'],['erosion damage','erosionDamage'],
]);
function canonicalStat(rawKey, label = '') {
  const direct = ALIASES_BY_KEY.get(norm(rawKey));
  if (direct) return direct;
  const byLabel = LABEL_ALIASES.get(clean(label, 120).toLocaleLowerCase('en'));
  return byLabel || ALIASES_BY_KEY.get(norm(label)) || null;
}
function parseNumberWithUnit(value) {
  const match = /^\s*([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+))\s*(%|[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9/_-]*)?\s*$/u.exec(String(value ?? ''));
  if (!match) return null;
  const number = Number(match[1].replace(',', '.'));
  return Number.isFinite(number) ? { number, unit: (match[2] || '').toLocaleLowerCase('en') } : null;
}
function readIndexRows(index, key) {
  return Array.isArray(index?.[key]) ? index[key] : [];
}
function rowMatchesId(row, id) {
  const wanted = String(id ?? '');
  return [row?.id,row?.enumId,row?.valueRaw,row?.rowName].some((value) => value !== null && value !== undefined && String(value) === wanted);
}
function localize(definition, resourceIndex) {
  if (!definition) return null;
  const key = definition.nameKeyRaw || definition.textKeyRaw || definition.descriptionKeyRaw;
  if (!key) return null;
  return readIndexRows(resourceIndex,'localizationEntries').find((row) => String(row.key) === String(key))?.text || null;
}
function attributeDefinition(raw, resourceIndex) {
  if (raw === null || raw === undefined || raw === '') return null;
  return readIndexRows(resourceIndex,'attributeDefinitions').find((row) => {
    const type = String(row.enumType || row.sourcePath || '');
    return /affixattrtype|gamecharattribute|gamecharfield/i.test(type) && rowMatchesId(row, raw);
  }) || null;
}
function affixDefinition(id, resourceIndex) {
  if (id === null || id === undefined || id === '') return null;
  return readIndexRows(resourceIndex,'affixDefinitions').find((row) => String(row.id) === String(id)) || null;
}
function itemDefinition(id, resourceIndex) {
  if (id === null || id === undefined || id === '') return null;
  return readIndexRows(resourceIndex,'itemDefinitions').find((row) => String(row.id) === String(id)) || null;
}
function itemLabel(item, definition, resourceIndex) {
  return clean(item.name,140) && !/^Предмет #/i.test(item.name)
    ? clean(item.name,140)
    : clean(definition?.name || localize(definition,resourceIndex) || definition?.rowName || item.name || ('Предмет #'+item.itemId),140);
}
function idFromLine(value) {
  const match = /(?:\bID\s*[:#]?\s*|#)([A-Za-z0-9_-]{1,80})/i.exec(String(value || ''));
  return match ? match[1] : null;
}
function compareDeclaredEntries(entries, observed, label) {
  const expected = (Array.isArray(entries) ? entries : []).map((entry) => ({
    text: clean(entry,240), id: idFromLine(entry),
  })).filter((row) => row.text);
  const rows = expected.map((entry) => {
    const found = entry.id
      ? observed.filter((row) => String(row.id) === String(entry.id))
      : observed.filter((row) => row.name && norm(row.name) === norm(entry.text));
    const unverifiable = !entry.id && !observed.some((row) => row.name);
    return {
      label, text: entry.text, id: entry.id, status: found.length
        ? 'observed' : !entry.id ? 'unverifiable' : observed.length ? 'not-observed' : 'no-live-data',
      matched: found.slice(0,3).map((row) => ({ id: row.id, name: row.name || null, slot: row.slot || null, level: row.level ?? null })),
    };
  });
  const listedIds = new Set(expected.map((row) => row.id).filter(Boolean));
  const unlisted = observed.filter((row) => row.id && !listedIds.has(String(row.id))).map((row) => ({
    id: String(row.id), name: row.name || null, slot: row.slot || null, level: row.level ?? null,
  }));
  return { expected: rows, unlistedObserved: unlisted, observedCount: observed.length };
}
function statEvidence(intel, build) {
  const live = new Map((Array.isArray(intel?.stats) ? intel.stats : []).map((row) => [row.key, row]));
  const keys = new Set([...Object.keys(build?.stats || {}), ...[...live.values()].map((row) => row.key)]);
  const rows = [];
  for (const key of keys) {
    const observed = live.get(key);
    const saved = finite(build?.stats?.[key]);
    const target = finite(build?.targets?.[key]);
    const current = finite(observed?.value) ?? saved;
    const source = finite(observed?.value) !== null ? 'UE_game.log' : saved !== null ? 'Сохранённый билд' : 'Нет данных';
    let mismatch = false;
    if (observed && saved !== null) {
      mismatch = Math.abs(saved - Number(observed.value)) > Math.max(0.0001, Math.abs(Number(observed.value)) * 0.0001);
    }
    const gap = current !== null && target !== null && current < target ? Number((target-current).toFixed(3)) : 0;
    rows.push({
      key, label: STAT_LABELS[key] || key, current, saved, target, gap, source,
      observedAt: Number(observed?.observedAt) || null, rawKey: observed?.rawKey || null,
      mismatch, belowTarget: gap > 0,
    });
  }
  return rows.sort((a,b) => Number(b.belowTarget)-Number(a.belowTarget) || a.label.localeCompare(b.label,'ru'));
}
function analyzeExplicitEquipment(intel, resourceIndex, partialEquipment) {
  const sourceItems = Array.isArray(intel?.explicitEquipment) ? intel.explicitEquipment : [];
  const rows = sourceItems.slice(0,80).map((item) => {
    const definition = itemDefinition(item.itemId,resourceIndex);
    const slotRaw = item.slotRaw || definition?.slotRaw || null;
    const affixes = (Array.isArray(item.affixes) ? item.affixes : []).slice(0,40).map((affix) => {
      const definition = affixDefinition(affix.id,resourceIndex);
      const definitionAttributeRaw = definition?.attributeRaw ?? null;
      const observedAttributeRaw = affix.attributeRaw ?? null;
      const attributeMismatch = definitionAttributeRaw !== null && observedAttributeRaw !== null &&
        String(definitionAttributeRaw) !== String(observedAttributeRaw);
      const attributeRaw = observedAttributeRaw ?? definitionAttributeRaw ?? null;
      const attribute = attributeMismatch ? null : attributeDefinition(attributeRaw,resourceIndex);
      const attrLabel = attribute?.enumName || attribute?.name || localize(attribute,resourceIndex) || attribute?.rowName || null;
      const attrCanonical = canonicalStat(attribute?.enumName || attrLabel || '', attrLabel || '');
      const directValue = (Array.isArray(affix.values) ? affix.values : []).filter((field) =>
        ['value','affixvalue','rollvalue'].includes(norm(field.key)));
      const statValues = (Array.isArray(affix.values) ? affix.values : []).filter((field) =>
        canonicalStat(field.key));
      const candidates = directValue.length === 1 ? directValue : directValue.length > 1 ? [] : statValues.length === 1 ? statValues : [];
      const parsedValue = candidates.length === 1 ? parseNumberWithUnit(candidates[0].value) : null;
      const min = parseNumberWithUnit(definition?.minRaw);
      const max = parseNumberWithUnit(definition?.maxRaw);
      let rollPercent = null;
      let rollStatus = 'unavailable';
      if (!attributeMismatch && parsedValue && min && max && parsedValue.unit === min.unit && min.unit === max.unit && max.number > min.number) {
        if (parsedValue.number < min.number || parsedValue.number > max.number) {
          rollStatus = 'outside-range';
        } else {
          rollPercent = Number(((parsedValue.number-min.number)/(max.number-min.number)*100).toFixed(1));
          rollStatus = rollPercent < 25 ? 'low-quarter' : rollPercent > 75 ? 'high-quarter' : 'middle-range';
        }
      }
      const affixName = clean(affix.name || definition?.name || localize(definition,resourceIndex) || definition?.rowName || ('Аффикс '+(affix.id || 'без ID')),160);
      return {
        id: affix.id ? String(affix.id) : null, name: affixName, tier: definition?.tierRaw || affix.tierRaw || null,
        attributeRaw: attributeRaw === null ? null : String(attributeRaw),
        catalogAttributeRaw: definitionAttributeRaw === null ? null : String(definitionAttributeRaw),
        attributeMismatch, attributeName: attrLabel,
        statKey: attributeMismatch ? null : attrCanonical || (candidates[0] ? canonicalStat(candidates[0].key) : null),
        value: candidates.length === 1 ? clean(candidates[0].value,80) : null,
        rollPercent, rollStatus, min: definition?.minRaw ?? null, max: definition?.maxRaw ?? null,
        exactCatalogMatch: Boolean(definition), sourcePath: definition?.sourcePath || affix.path || null,
        confidence: affix.confidence || null,
      };
    });
    return {
      itemId: Number(item.itemId) || null, name: itemLabel(item,definition,resourceIndex),
      slot: clean(slotRaw,80) || 'Слот не подтверждён',
      slotSource: item.slotRaw ? 'UE_game.log' : definition?.slotRaw ? 'FModel DataTable' : null,
      itemLevel: item.itemLevelRaw || null, rarity: item.rarityRaw || null,
      quality: item.qualityRaw || null, enhance: item.enhanceLevelRaw || null,
      confidence: item.confidence || 'explicit-id', sourceAction: item.sourceAction || null,
      observedAt: Number(item.observedAt) || null, affixes,
      catalogMatch: Boolean(definition),
    };
  });
  return {
    items: rows,
    partialObservedItems: Array.isArray(partialEquipment?.items) ? partialEquipment.items.length : Array.isArray(intel?.equipment?.items) ? intel.equipment.items.length : 0,
    isFullLoadoutConfirmed: false,
    matchedItemDefinitions: rows.filter((row) => row.catalogMatch).length,
    matchedAffixes: rows.reduce((sum,row) => sum+row.affixes.filter((affix)=>affix.exactCatalogMatch).length,0),
  };
}
function mapObservedAffixesToStat(items, statKey) {
  return items.flatMap((item) => item.affixes.filter((affix) =>
    affix.statKey === statKey || affix.exactCatalogMatch && affix.attributeName && canonicalStat(affix.attributeName) === statKey
  ).map((affix) => ({ item: item.name, slot: item.slot, affix: affix.name, value: affix.value, rollPercent: affix.rollPercent })));
}
function damageFocus(build) {
  const key = norm(build?.damageType || '');
  const aliases = {
    physical:['physicalDamage','penetration'], phys:['physicalDamage','penetration'],
    fire:['fireDamage','firePenetration'], огонь:['fireDamage','firePenetration'],
    cold:['coldDamage','coldPenetration'], холод:['coldDamage','coldPenetration'],
    lightning:['lightningDamage','lightningPenetration'], молния:['lightningDamage','lightningPenetration'],
    erosion:['erosionDamage','erosionPenetration'], эрозия:['erosionDamage','erosionPenetration'],
  };
  return aliases[key] || [];
}
export function diagnoseBuild({ build = {}, profile = null, intel = null, equipment = null, resourceIndex = null, tlidbCatalog = null, now = Date.now() } = {}) {
  const stats = statEvidence(intel,build);
  const ageMs = Number(intel?.lastObservedAt || intel?.capturedAt || 0);
  const freshnessHours = ageMs ? Math.max(0,(now-ageMs)/3600000) : null;
  const stale = freshnessHours !== null && freshnessHours > 24;
  const skills = compareDeclaredEntries(build.skills,intel?.skills || [],'Навык / поддержка');
  const talents = compareDeclaredEntries(build.talents,intel?.talents || [],'Талант');
  const gear = analyzeExplicitEquipment(intel,resourceIndex,equipment);
  const recommendations = [];
  const add = (priority,severity,code,title,reason,action,evidence = null) => recommendations.push({
    priority,severity,code,title,reason,action,evidence,
  });
  for (const row of stats.filter((item) => item.belowTarget)) {
    const supporting = mapObservedAffixesToStat(gear.items,row.key);
    add(100 + (row.target ? Math.min(20,Math.abs(row.gap)/(Math.abs(row.target)||1)*100) : 0),'warning','stat-below-target',
      row.label+' ниже твоей цели',
      'Сейчас '+row.current+', целевое значение '+row.target+', разница '+row.gap+'. Источник: '+row.source+'.',
      supporting.length
        ? 'Сравни аффиксы на '+supporting.map((x)=>x.slot+' · '+x.item).join('; ')+'. При наличии точного диапазона проверь ролл.'
        : 'Проверь экипировку и таланты, которые дают этот показатель. В доступном снимке нет однозначно привязанного аффикса для него.',
      { statKey:row.key, supportingAffixes:supporting });
  }
  for (const row of stats.filter((item) => item.mismatch)) {
    add(65,'info','saved-stat-mismatch','Сохранённое значение отличается от игрового',
      row.label+': в билде '+row.saved+', в логе '+row.current+'.',
      'Обнови снимок билда или проверь, что сравниваются один персонаж, сезон и состояние экипировки.',
      {statKey:row.key,observedAt:row.observedAt});
  }
  for (const row of skills.expected.filter((item)=>item.status==='not-observed')) {
    add(85,'warning','skill-not-observed','Навык из билда не найден в последнем снимке',
      row.text+' — ID '+row.id+'. В текущем срезе лога этот ID не обнаружен.',
      'Проверь, установлен ли этот навык и не изменён ли слот; обнови данные навыков в игре и пересканируй лог.',
      {id:row.id});
  }
  for (const row of talents.expected.filter((item)=>item.status==='not-observed')) {
    add(82,'warning','talent-not-observed','Талант из билда не найден в последнем снимке',
      row.text+' — ID '+row.id+'. В текущем срезе лога этот ID не обнаружен.',
      'Проверь распределение очков и соответствие дерева текущему сезону; затем обнови снимок.',
      {id:row.id});
  }
  for (const item of gear.items) {
    for (const affix of item.affixes.filter((row)=>row.attributeMismatch)) {
      add(96,'warning','affix-attrtype-conflict','ID аффикса и AttrType расходятся',
        item.slot+' · '+item.name+' · '+affix.name+': в логе AttrType '+affix.attributeRaw+', в FModel '+affix.catalogAttributeRaw+'.',
        'Не используй это сопоставление для оценки характеристики или диапазона. Проверь, что экспорт FModel относится к той же версии игры, что и лог.',
        {itemId:item.itemId,affixId:affix.id,observedAttrType:affix.attributeRaw,catalogAttrType:affix.catalogAttributeRaw});
    }
    for (const affix of item.affixes.filter((row)=>row.rollStatus==='low-quarter')) {
      add(72,'info','low-affix-roll','Низкий ролл подтверждённого аффикса',
        item.slot+' · '+item.name+' · '+affix.name+': '+affix.value+' из диапазона '+affix.min+'–'+affix.max+' ('+affix.rollPercent+'% диапазона).',
        'Сравни цену и стоимость замены; это значение ближе к нижней четверти диапазона, но само по себе не доказывает, что предмет нужно менять.',
        {itemId:item.itemId,affixId:affix.id,rollPercent:affix.rollPercent});
    }
  }
  if (!build.mainSkill) add(60,'warning','main-skill-missing','Не указан основной навык',
    'Без основного навыка нельзя проверить направленность урона и связку поддержек.',
    'Укажи основной навык и его поддержки в лаборатории билдов.');
  if (gear.items.length === 0) {
    add(45,'info','gear-not-confirmed','Полный набор экипировки не восстановлен',
      'Нет явных объектов экипировки с ID из Character Intelligence. Частичный PutOn/PutOff: '+gear.partialObservedItems+'.',
      'Открой экран персонажа/экипировки, обнови лог и сохрани снимок. Сумка и частичные события не заменяют надетые слоты.');
  }
  if (skills.expected.some((row)=>row.status==='unverifiable') || talents.expected.some((row)=>row.status==='unverifiable')) {
    add(35,'info','skill-talent-name-only','Часть навыков или талантов описана только текстом',
      'В сохранённой сборке и игровом логе нет общего явного ID/названия для точного сравнения.',
      'Добавь точные ID из Character Intelligence к строкам навыков/талантов. Совпадение по свободному тексту не предполагается.');
  }
  const focus = damageFocus(build);
  if (focus.length) {
    const notObserved = focus.filter((key)=>!stats.some((row)=>row.key===key && row.source==='UE_game.log'));
    if (notObserved.length) add(40,'info','damage-focus-incomplete','Не хватает показателей по выбранному типу урона',
      'Для типа «'+clean(build.damageType,60)+'» Nexus проверяет '+focus.map((key)=>STAT_LABELS[key]).join(' и ')+'.',
      'Добавь эти показатели из игрового листа характеристик. Без них Nexus не станет оценивать потенциал урона числом.');
  }
  const observedCount = stats.filter((row)=>row.source==='UE_game.log').length;
  const equipmentCoverage = gear.items.length ? Math.min(100,Math.round(gear.items.length/12*100)) : 0;
  const skillCoverage = skills.expected.length ? Math.round(skills.expected.filter((row)=>row.status==='observed').length/skills.expected.length*100) : 0;
  const talentCoverage = talents.expected.length ? Math.round(talents.expected.filter((row)=>row.status==='observed').length/talents.expected.length*100) : 0;
  const dataCoverage = Math.round((Math.min(1,observedCount/12)*30)+(gear.items.length?18:0)+(skills.observedCount?12:0)+(talents.observedCount?12:0)+(freshnessHours!==null&&!stale?8:0)+(resourceIndex?10:0)+(Array.isArray(intel?.identity?.playerId)?0:intel?.identity?.playerId?10:0));
  const tlidbRecords = Array.isArray(tlidbCatalog?.records) ? tlidbCatalog.records.length : 0;
  const limitations = [
    'Покрытие данных — не рейтинг силы персонажа и не процент готовности билда.',
    'Нет подтверждённого симулятора DPS/защиты для текущего патча: урон и выживаемость не пересчитываются в условный рейтинг.',
    'Навыки и таланты сравниваются по явно наблюдаемым ID/названиям; база эффектов и связей поддержки/талантов пока не подтверждена.',
    'В анализ экипировки входят только явные записи CharacterIntel.explicitEquipment. Это не гарантирует, что показан полный комплект.',
    'PutOn/PutOff и сумка учитываются как отдельные частичные источники, а не как полный комплект экипировки.',
    'TLIDB содержит общественные текстовые диапазоны аффиксов, но не надёжные внутренние AffixId/AttrType и не проверенную метку патча; автоматическое сопоставление по названию не выполняется.',
    ...(!resourceIndex ? ['Локальные DataTable FModel не импортированы: точные названия и диапазоны игровых аффиксов недоступны.'] : []),
    ...(stale ? ['Последний снимок персонажа старше 24 часов; перепроверь его перед принятием решений.'] : []),
  ];
  if (tlidbRecords) limitations.push('В локальном кэше TLIDB '+tlidbRecords+' строк. Они доступны как справочник, но не использованы для ложного сопоставления с ID предметов.');
  const byPriority = recommendations.sort((a,b)=>b.priority-a.priority);
  const status = freshnessHours===null ? 'no-live-character-data' : stale ? 'stale-character-data' : 'partial-character-data';
  return {
    schemaVersion:1, generatedAt:now, status, profileId:profile?.id || build.profileId || null,
    character: intel?.identity ? {
      name:intel.identity.name || profile?.name || null, playerId:intel.identity.playerId || null,
      seasonId:intel.identity.seasonId ?? null, hero:intel.identity.heroName || profile?.hero || build.hero || null,
      specialization:intel.identity.specializationName || profile?.specialization || null, level:intel.identity.level ?? profile?.level ?? build.level ?? null,
    } : profile ? {name:profile.name || null,playerId:profile.playerId || profile.detectedPlayerId || null,seasonId:profile.lastSeasonId || profile.seasonId || null,hero:profile.hero || build.hero || null,specialization:profile.specialization || null,level:profile.level || build.level || null} : null,
    summary:{
      dataCoveragePercent:Math.max(0,Math.min(100,dataCoverage)), knownStats:observedCount,
      targetGaps:stats.filter((row)=>row.belowTarget).length,
      skillMatches:skills.expected.filter((row)=>row.status==='observed').length, skillEntries:skills.expected.length,
      talentMatches:talents.expected.filter((row)=>row.status==='observed').length, talentEntries:talents.expected.length,
      explicitEquipmentItems:gear.items.length, matchedItemDefinitions:gear.matchedItemDefinitions,
      matchedAffixes:gear.matchedAffixes, recommendations:byPriority.length,
      freshnessHours, stale, isFullLoadoutConfirmed:false,
    },
    stats, skills, talents, equipment:gear,
    interactions:{
      skillTalentSynergy:'not-verified',
      supportLinks:'not-verified',
      explanation:'Nexus видит ID/уровень/позицию навыков и талантов, но текущие локальные источники не подтверждают определения всех эффектов и связи поддержек. Поэтому он не делает вывод, что конкретный талант усиливает конкретный навык.',
      availableEvidence:{skillIds: (intel?.skills || []).length, talentIds:(intel?.talents || []).length, itemAffixes:gear.matchedAffixes},
    },
    damageFocus:{damageType:clean(build.damageType,60)||null, checkedStats:focus.map((key)=>({key,label:STAT_LABELS[key],observed:stats.some((row)=>row.key===key&&row.source==='UE_game.log'),target:finite(build.targets?.[key])}))},
    recommendations:byPriority, limitations,
    tlidb:{available:tlidbRecords>0,records:tlidbRecords,patchVerification:tlidbCatalog?.patchVerification || 'unknown'},
    sourceSummary:{
      liveIntel:Boolean(intel), lastObservedAt:ageMs || null, freshnessHours,
      explicitEquipment:gear.items.length, partialEquipment:gear.partialObservedItems,
      resourceCatalog:Boolean(resourceIndex), resourceAffixes:readIndexRows(resourceIndex,'affixDefinitions').length,
    },
    disclaimer:'Анализ объясняет подтверждённые расхождения и качество доступных источников. Он не рассчитывает DPS, не ранжирует билд по мете и не выдаёт предположения за игровые факты.',
  };
}
