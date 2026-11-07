const $ = (id) => document.getElementById(id);
const statFields = [
  ['life','Здоровье'],['energyShield','Энергетический щит'],['mana','Максимальная мана'],['armor','Броня'],['evasion','Уклонение'],
  ['fireRes','Сопротивление огню'],['coldRes','Сопротивление холоду'],['lightningRes','Сопротивление молнии'],['erosionRes','Сопротивление эрозии'],
  ['critChance','Шанс критического удара'],['critMultiplier','Множитель критического удара'],['attackSpeed','Скорость атаки'],['castSpeed','Скорость применения'],['moveSpeed','Скорость передвижения'],['penetration','Пробивание'],['firePenetration','Пробивание огнём'],['coldPenetration','Пробивание холодом'],['lightningPenetration','Пробивание молнией'],['erosionPenetration','Пробивание эрозией'],['physicalDamage','Физический урон'],['fireDamage','Огненный урон'],['coldDamage','Урон холодом'],['lightningDamage','Урон молнией'],['erosionDamage','Урон эрозией'],['conversionPercent','Преобразование урона'],
];
const PAGE_META={overview:['COMMAND CENTER','Обзор'],characters:['CHARACTER ROSTER','Персонажи'],loot:['DROP TRACKER','Лут и сессии'],items:['ITEM DATABASE','База предметов'],economy:['MARKET INTELLIGENCE','Экономика'],builds:['BUILD LAB','Лаборатория билдов'],analyzer:['CHARACTER INTELLIGENCE','Анализ персонажа'],farming:['FARM PERFORMANCE','Фарм и аналитика'],tactics:['FIELD NOTES','Тактики и заметки'],settings:['PREFERENCES','Настройки']};
let data={schemaVersion:2,settings:{},characterProfiles:[],builds:[],tactics:[],farmingSessions:[],priceWatch:[],priceHistory:[],notes:[]};
let live={}, activePage='overview', itemQueryTimer=null, iconCache=new Map(), selectedBuildId=null, selectedTacticId=null, selectedProfileId=null, selectedBuildObservedStats=[], latestAnalysis=null, equipmentLabItems=[], equipmentLabProfileId=null, equipmentLabBuildId='profile-default', equipmentLabEvidenceFingerprint='';
const esc=(v)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(v,d=1)=>Number(v||0).toLocaleString('ru-RU',{maximumFractionDigits:d});
const money=(v)=>v===null||v===undefined||!Number.isFinite(Number(v))?'—':`${number(v,2)} FE`;
const date=(v)=>v?new Date(v).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}):'—';
const seasonLabel=(value)=>{const raw=String(value??'').trim();if(!/^\d+$/.test(raw))return raw||'—';const major=raw.length>=4?raw.slice(0,2):raw;return `SS${Number(major)}`;};
const duration=(s)=>{s=Math.max(0,Math.floor(s||0));return `${Math.floor(s/3600)}:${String(Math.floor(s%3600/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};
const lines=(v)=>String(v||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
const makeUid=(prefix)=>`${prefix}_${Date.now().toString(36)}_${(globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2))}`;
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toast._timer);toast._timer=setTimeout(()=>el.classList.remove('show'),2400);}
async function saveData(){try{data=await window.nexus.saveData(data);}catch(e){toast(`Не удалось сохранить: ${e.message||e}`);}}
async function iconFor(id){if(iconCache.has(id))return iconCache.get(id);const src=await window.nexus.getItemIcon(id);iconCache.set(id,src||'');return src||'';}
async function hydrateIcons(root){for(const img of root.querySelectorAll('img[data-id]')){const src=await iconFor(Number(img.dataset.id));if(src&&img.isConnected)img.src=src;}}
function go(page){if(!PAGE_META[page])return;activePage=page;document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===`page-${page}`));document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.page===page));$('page-eyebrow').textContent=PAGE_META[page][0];$('page-title').textContent=PAGE_META[page][1];renderPage();}
document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>go(b.dataset.page)));
document.addEventListener('click',(e)=>{const b=e.target.closest('[data-go]');if(b)go(b.dataset.go);});
function renderConnection(){const r=live.logReadiness||{},isLive=r.code==='live';$('emergency-clickthrough-off').hidden=data.settings?.clickThrough!==true;$('conn-dot').classList.toggle('on',isLive);$('top-dot').classList.toggle('on',isLive);$('conn-title').textContent=isLive?'Игровые сообщения поступают':live.gameRunning?'Игра запущена':'Нет подключения';$('conn-sub').textContent=live.player?`${live.player} · ${live.area||'область не определена'}`:'Ожидание Torchlight: Infinite';$('top-status').textContent=isLive?'LIVE':live.connected?'Лог найден':'Ожидание игры';$('top-season').textContent=live.seasonId?seasonLabel(live.seasonId):'—';}
function renderOverview(){
  $('ov-value').textContent=money(live.sessionValueFe);$('ov-priced').textContent=`Оценено ${live.pricedTypes||0} типов · без цены ${live.unpricedTypes||0}`;
  $('ov-fe').textContent=number(live.feGained,0);$('ov-picks').textContent=number(live.pickupEvents,0);$('ov-items').textContent=`${number(live.drops,0)} предметов`;
  const elapsed=live.startedAt?Math.max(1,(Date.now()-live.startedAt)/3600000):0;$('ov-hour').textContent=elapsed?number((live.sessionValueFe||0)/elapsed,1):'—';
  $('ov-player').textContent=live.player||'Персонаж не определён';$('ov-area').textContent=live.area||'Область не определена';$('ov-duration').textContent=duration(elapsed*3600);$('ov-log').textContent=live.logFile||live.error||'Не подключён';
  const recent=(live.recent||[]).slice(0,6);$('ov-recent').className=recent.length?'drop-list':'drop-list empty';$('ov-recent').innerHTML=recent.map(x=>`<div class="drop-row"><img data-id="${Number(x.id)}" alt=""><div class="drop-name"><b>${esc(x.name)}</b><small>×${number(x.count,0)} · ${esc(x.area||'Текущая зона')}</small></div><strong>${x.id===100300?`${number(x.count,0)} FE`:'Найдено'}</strong></div>`).join('')||'Ожидаю первый дроп…';void hydrateIcons($('ov-recent'));
  const builds=data.builds.slice(-4).reverse();$('ov-builds').className='mini-cards';$('ov-builds').innerHTML=builds.map(x=>`<div class="mini-row"><span>${esc(x.name)} · ${esc(x.hero||'Герой не указан')}</span><b>ур. ${x.level}</b></div>`).join('')||'<div class="empty">Сохрани первую сборку в лаборатории.</div>';
  const farms=data.farmingSessions.slice(-4).reverse();$('ov-farm').className='mini-cards';$('ov-farm').innerHTML=farms.map(x=>`<div class="mini-row"><span>${esc(x.strategy||x.area||'Сессия')}</span><b>${money((Number(x.lootValueFe)||0)-(Number(x.costsFe)||0))}</b></div>`).join('')||'<div class="empty">Завершённые сессии появятся здесь.</div>';
}
function renderLoot(){
  const rows=live.lootSummary||[];$('loot-total').textContent=money(live.sessionValueFe);$('loot-fe').textContent=number(live.feGained,0);$('loot-count').textContent=number(live.totalLootQuantity||live.drops,0);$('loot-coverage').textContent=`${live.pricedTypes||0}/${(live.pricedTypes||0)+(live.unpricedTypes||0)}`;
  $('loot-table').innerHTML=rows.map(x=>`<tr><td><span class="item-table-name"><img data-id="${Number(x.id)}" alt=""><b>${esc(x.name)}</b><small>ID ${Number(x.id)}</small></span></td><td>${number(x.count,0)}</td><td>${x.unitPrice===null?'Неизвестно':money(x.unitPrice)}</td><td class="price-chip">${x.valueFe===null?'—':money(x.valueFe)}</td><td>${esc(x.priceSource||'—')}</td></tr>`).join('')||'<tr><td colspan="5" class="empty">В этой сессии пока нет находок.</td></tr>';void hydrateIcons($('loot-table'));
  $('loot-source').textContent=`${live.pricing?.ownCount||0} цен биржи · ${live.pricing?.communityCount||0} общественных цен · ${live.pricing?.stale?'используется кэш':'база доступна/не проверена'}`;
}
function activeProfile(){return data.characterProfiles.find(x=>x.id===data.settings?.activeProfileId)||null;}
function characterIntelForProfile(profile=activeProfile()){
  const current=live.characterIntel||null;
  const identity=current?.identity||null;
  if(current&&identity?.name&&(!profile||String(identity.name).trim().toLocaleLowerCase('ru')===String(profile.name||'').trim().toLocaleLowerCase('ru'))){
    const storedPlayerId=String(profile?.playerId||profile?.detectedPlayerId||'');const observedPlayerId=String(identity.playerId||'');
    const storedSeason=Number(profile?.lastSeasonId||profile?.seasonId)||0, observedSeason=Number(identity.seasonId)||0;
    const playerMatches=!storedPlayerId||!observedPlayerId||storedPlayerId===observedPlayerId;
    if(!profile||(playerMatches&&(!storedSeason||!observedSeason||storedSeason===observedSeason)))return {intel:current,source:'live'};
  }
  if(profile?.characterIntelSnapshot)return {intel:profile.characterIntelSnapshot,source:'profile'};
  if(!profile&&current)return {intel:current,source:'live'};
  return {intel:null,source:'none'};
}
const statLabels=new Map(statFields.map(([key,label])=>[key,label]));
function renderCharacterIntel(profile=activeProfile()){
  const {intel,source}=characterIntelForProfile(profile);
  const empty='Не обнаружено в доступных сообщениях UE_game.log.';
  if(!intel){
    $('character-intel-source').textContent='НЕТ ДАННЫХ';$('character-intel-coverage').textContent='0 / 6';
    $('character-intel-message-count').textContent='0';$('character-intel-last-action').textContent='Последнее действие: —';
    $('character-intel-scan').textContent='Сначала подключи UE_game.log и нажми «Пересканировать лог»';
    $('character-intel-scan-time').textContent='—';$('character-intel-scan-size').textContent='Файл не сканировался';
    for(const [id,statusId] of [['character-intel-identity','intel-identity-status'],['character-intel-stats','intel-stats-status'],['character-intel-skills','intel-skills-status'],['character-intel-talents','intel-talents-status']]){
      $(id).className='intel-content empty';$(id).textContent=empty;$(statusId).textContent='Не найдено';
    }
    $('intel-explicit-equipment').className='intel-inventory-list empty';$('intel-explicit-equipment').textContent='Подтверждённая структура экипировки ещё не найдена.';$('intel-explicit-equipment-source').textContent='Не найдена';
    $('character-intel-inventory').className='intel-inventory-list empty';$('character-intel-inventory').textContent='Нет снимка инвентаря.';
    $('intel-inventory-source').textContent='Не найден';$('character-intel-fields').textContent='Пока нет подходящих полей.';$('character-intel-actions').textContent='Нет записей';
    $('character-intel-limitations').textContent='Nexus не угадывает слот, название навыка или аффикс, если этого нет в доступных данных.';
    $('rescan-character-log').disabled=!live.connected;$('import-intel-to-build').disabled=true;
    return;
  }
  const identity=intel.identity||null, sections=intel.sections||{};
  $('character-intel-source').textContent=source==='live'?'LIVE · UE_game.log':'СОХРАНЁННЫЙ ПРОФИЛЬ';
  $('character-intel-coverage').textContent=`${Number(intel.observedSections)||0} / ${Number(intel.totalSections)||5}`;
  $('character-intel-message-count').textContent=number(intel.messagesAnalyzed||0,0);
  $('character-intel-last-action').textContent=`Последнее действие: ${intel.lastAction||'—'}`;
  const scan=live.characterScan;
  $('character-intel-scan').textContent=intel.completenessLabel||'Поля восстановлены из игровых сообщений';
  $('character-intel-scan-time').textContent=date(scan?.at||intel.lastObservedAt||intel.capturedAt);
  $('character-intel-scan-size').textContent=scan?`${number(scan.bytesScanned/1024/1024,2)} МБ · ${number(scan.messages,0)} сообщений · окно до 32 МБ`:`Источник: ${source==='live'?'текущая сессия':'сохранённый снимок'}`;
  $('character-intel-identity').className=identity?'intel-content':'intel-content empty';
  $('intel-identity-status').textContent=identity?`ПОДТВЕРЖДЕНО · ${identity.sourceAction||'GetPlayerData'}`:'Не найдено';
  $('character-intel-identity').innerHTML=identity?[
    ['Имя',identity.name],['Player ID',identity.playerId],['Сезон',identity.seasonId?seasonLabel(identity.seasonId):null],['Уровень',identity.level],
    ['Hero ID',identity.heroId],['Герой',identity.heroName],['Specialization ID',identity.specializationId],['Специализация',identity.specializationName],['Сервер',identity.serverId]
  ].filter(([,value])=>value!==null&&value!==undefined&&value!=='').map(([label,value])=>`<div class="intel-kv"><span>${esc(label)}</span><b>${esc(String(value))}</b></div>`).join(''):'<div class="empty">GetPlayerData не найден или не содержит обязательных PlayerId и SeasonId.</div>';
  const stats=(intel.stats||[]).slice().sort((a,b)=>(statLabels.get(a.key)||a.key).localeCompare(statLabels.get(b.key)||b.key,'ru'));
  $('intel-stats-status').textContent=stats.length?`${stats.length} ПОЛЕЙ`:'Не найдено';
  $('character-intel-stats').className=stats.length?'intel-content':'intel-content empty';
  $('character-intel-stats').innerHTML=stats.map(x=>`<div class="intel-stat"><span>${esc(statLabels.get(x.key)||x.key)}</span><b>${number(x.value,3)}</b><small>${esc(x.rawKey)} · ${esc(x.sourceAction||'')} · ${esc(x.path||'')} · ${esc(x.confidence||'')} · ${date(x.observedAt)}</small></div>`).join('')||empty;
  const skills=(intel.skills||[]).slice().sort((a,b)=>String(a.slot||a.id).localeCompare(String(b.slot||b.id),'ru'));
  $('intel-skills-status').textContent=skills.length?`${skills.length} ID`:'Не найдено';
  $('character-intel-skills').className=skills.length?'intel-content':'intel-content empty';
  $('character-intel-skills').innerHTML=skills.map(x=>`<div class="intel-entry"><b>${esc(x.name||`Навык ID ${x.id}`)}</b><small>ID ${esc(x.id)}${x.level!==null&&x.level!==undefined?` · ур. ${x.level}`:''}${x.slot?` · позиция ${esc(x.slot)}`:''}</small><small>${esc(x.sourceAction||'')} · ${esc(x.sourceKind||'')} · ${esc(x.path||'')} · ${esc(x.confidence||'')}</small></div>`).join('')||empty;
  const talents=(intel.talents||[]).slice().sort((a,b)=>String(a.slot||a.id).localeCompare(String(b.slot||b.id),'ru'));
  $('intel-talents-status').textContent=talents.length?`${talents.length} ID`:'Не найдено';
  $('character-intel-talents').className=talents.length?'intel-content':'intel-content empty';
  $('character-intel-talents').innerHTML=talents.map(x=>`<div class="intel-entry"><b>${esc(x.name||`Талант ID ${x.id}`)}</b><small>ID ${esc(x.id)}${x.level!==null&&x.level!==undefined?` · уровень ${x.level}`:''}${x.slot?` · позиция ${esc(x.slot)}`:''}</small><small>${esc(x.sourceAction||'')} · ${esc(x.sourceKind||'')} · ${esc(x.path||'')} · ${esc(x.confidence||'')}</small></div>`).join('')||empty;
  const explicitEquipment=intel.explicitEquipment||[];
  $('intel-explicit-equipment-source').textContent=explicitEquipment.length?`${explicitEquipment.length} объектов · явные поля UE`:'Не найдена';
  $('intel-explicit-equipment').className=explicitEquipment.length?'intel-inventory-list':'intel-inventory-list empty';
  $('intel-explicit-equipment').innerHTML=explicitEquipment.map(item=>`<div class="explicit-equipment-row"><img data-id="${Number(item.itemId)}" alt=""><div><b>${esc(item.name||`Предмет #${item.itemId}`)}</b><small>ID ${Number(item.itemId)} · ${esc(item.slotRaw||'слот не указан')} · ${esc(item.confidence||'явный ID')}</small><small>${(item.affixes||[]).map(a=>`Аффикс ID ${esc(a.id)}`).join(' · ')||'Аффиксы не обнаружены'}</small><small>${esc(item.sourceAction||'')} · ${esc(item.path||'')}</small></div></div>`).join('')||'Нет подтверждённых явных объектов экипировки. Снимки ResetItemsLayout и GetWareHousePage сюда не попадают.';
  void hydrateIcons($('intel-explicit-equipment'));
  const inventory=intel.latestInventory||(intel.inventorySnapshots||[]).slice(-1)[0]||null;
  $('intel-inventory-source').textContent=inventory?`${inventory.action} · ${date(inventory.observedAt)} · ${inventory.itemCount||0} типов`:'Не найден';
  const inventoryItems=inventory?.items||[];
  $('character-intel-inventory').className=inventoryItems.length?'intel-inventory-list':'intel-inventory-list empty';
  $('character-intel-inventory').innerHTML=inventoryItems.map(item=>`<div class="intel-inventory-item"><img data-id="${Number(item.itemId)}" alt=""><div><b>${esc(item.name||`Предмет #${item.itemId}`)}</b><small>ID ${Number(item.itemId)} · ×${number(item.count||1,0)} · ${esc(item.itemType||'тип неизвестен')}</small>${(item.details||[]).slice(0,4).map(d=>`<small>${esc(d.path||d.key)}: ${esc(d.value)}</small>`).join('')}</div></div>`).join('')||'В последнем снимке предметы не распознаны. Открой непустую вкладку сумки/склада и используй сортировку, затем пересканируй лог.';
  void hydrateIcons($('character-intel-inventory'));
  const schema=(intel.fieldSchema||[]).slice(-80).reverse();
  $('character-intel-fields').className=schema.length?'intel-schema-list':'intel-schema-list empty';
  $('character-intel-fields').innerHTML=schema.map(x=>`<div><code>${esc(x.path)}</code><small>${esc(x.sampleValueType)} · ${esc(x.action||'')} · ×${Number(x.seenCount)||1}</small></div>`).join('')||'Пока нет подходящих полей.';
  const actionRows=intel.actionRows||Object.entries(intel.actions||{}).map(([action,count])=>({action,count})).sort((a,b)=>b.count-a.count);
  $('character-intel-actions').className=actionRows.length?'intel-schema-list':'intel-schema-list empty';
  $('character-intel-actions').innerHTML=actionRows.slice(0,35).map(x=>`<div><code>${esc(x.action)}</code><small>${number(x.count,0)}</small></div>`).join('')||'Нет записей';
  $('character-intel-limitations').textContent=(intel.limitations||[]).join(' ');
  $('rescan-character-log').disabled=!live.connected;
  $('import-intel-to-build').disabled=!identity&&!stats.length&&!skills.length&&!talents.length&&!inventoryItems.length;
}
async function renderCharacterReport(profile=activeProfile()){
  if(!profile){
    $('character-report-coverage').textContent='0%';$('character-report-label').textContent='Нет профиля';$('character-history-count').textContent='0';$('character-report-freshness').textContent='Ожидаю данные';$('character-linked-builds').textContent='0';
    $('character-report-sections').className='character-report-sections empty';$('character-report-sections').textContent='Выбери или создай профиль персонажа.';$('character-report-findings').className='findings empty';$('character-report-findings').textContent='Рекомендации появятся после сканирования.';$('character-history-list').className='character-history-list empty';$('character-history-list').textContent='Нет сохранённых снимков.';return;
  }
  try{
    const report=await window.nexus.getCharacterReport(profile.id);
    if(activeProfile()?.id!==profile.id)return;
    $('character-report-coverage').textContent=`${report.completeness}%`;$('character-report-label').textContent=report.label;
    $('character-history-count').textContent=number(profile.characterHistory?.length||0,0);
    $('character-report-freshness').textContent=report.freshnessHours===null?'Наблюдений нет':`Последнее наблюдение ${number(report.freshnessHours,1)} ч назад`;
    $('character-linked-builds').textContent=number(report.linkedBuildCount,0);
    $('character-report-sections').className='character-report-sections';
    $('character-report-sections').innerHTML=report.sections.map(section=>`<div class="character-section-row ${section.status}"><b>${esc(section.label)}</b><span>${section.status==='verified'?'Подтверждено':section.status==='partial'?'Частично':section.status==='observed'?'Наблюдалось':'Нет данных'} · ${section.count}</span><small>${esc(section.detail)}</small></div>`).join('');
    $('character-report-findings').className='findings';
    $('character-report-findings').innerHTML=report.findings.map(f=>`<article class="finding ${f.severity}"><span class="severity">${f.severity==='danger'?'⛔':f.severity==='warning'?'⚠':f.severity==='success'?'✓':'ⓘ'}</span><div><b>${esc(f.title)}</b><p>${esc(f.detail)}${f.action?`<br><strong>Рекомендуемое действие:</strong> ${esc(f.action)}`:''}</p></div></article>`).join('')||'<div class="empty">Нет выявленных проблем качества данных.</div>';
    const history=(profile.characterHistory||[]).slice().reverse();
    $('character-history-list').className=history.length?'character-history-list':'character-history-list empty';
    $('character-history-list').innerHTML=history.map((snap,index)=>{const absoluteIndex=profile.characterHistory.length-1-index;const previous=profile.characterHistory[absoluteIndex-1];return `<div class="character-history-row"><div><b>${date(snap.capturedAt)} · ${esc(snap.name||profile.name)}</b><small>Ур. ${snap.level??'—'} · SS${String(snap.seasonId||'').length>=4?Number(String(snap.seasonId).slice(0,2)):snap.seasonId||'—'} · ${snap.statCount||0} статов · ${snap.skillCount||0} навыков · ${snap.talentCount||0} талантов · ${snap.explicitEquipmentCount||0} явных предметов · ${snap.partialEquipmentCount||0} PutOn</small></div><div class="row-actions">${previous?`<button data-snapshot-compare="${absoluteIndex}">Сравнить с предыдущим</button>`:''}</div></div>`;}).join('')||'Снимки автоматически сохраняются при изменении подтверждённых данных или вручную кнопкой выше.';
  }catch(error){$('character-report-findings').className='findings empty';$('character-report-findings').textContent=`Не удалось построить отчёт: ${error.message||error}`;}
}

function fillProfileForm(profile){
  $('profile-id').value=profile?.id||'';$('profile-player-id').value=profile?.playerId||profile?.detectedPlayerId||'';$('profile-name').value=profile?.name||'';$('profile-hero').value=profile?.hero||'';
  $('profile-specialization').value=profile?.specialization||'';$('profile-level').value=profile?.level||100;
  $('profile-season').value=profile?.season||'SS14 · Tartarus';$('profile-notes').value=profile?.notes||'';
  $('profile-auto-select').checked=data.settings?.autoSelectDetectedProfile!==false;
  $('profile-form-title').textContent=profile?'Редактирование персонажа':'Новый персонаж';$('profile-save').textContent=profile?'Сохранить изменения':'Сохранить персонажа';
}
function profileForLive(state=live){
  const identity=state?.characterIntel?.identity||{};const playerId=String(identity.playerId||'');const season=Number(identity.seasonId||state.seasonId)||0;
  if(playerId){const exact=(data.characterProfiles||[]).find(p=>String(p.playerId||p.detectedPlayerId||'')===playerId&&Number(p.lastSeasonId||p.seasonId||p.detectedSeasonId||0)===season);if(exact)return exact;}
  const name=String(state?.player||identity.name||'').trim().toLocaleLowerCase('ru');if(!name)return null;
  const matches=(data.characterProfiles||[]).filter(p=>String(p.name||'').trim().toLocaleLowerCase('ru')===name);
  if(!matches.length)return null;
  const exactSeason=matches.find(p=>Number(p.lastSeasonId||p.seasonId||p.detectedSeasonId||0)===season);
  if(exactSeason&&(!playerId||!exactSeason.playerId||String(exactSeason.playerId)===playerId))return exactSeason;
  return playerId?null:matches.slice().sort((a,b)=>Number(b.lastSeenAt||0)-Number(a.lastSeenAt||0))[0];
}
function createDetectedProfile(state=live){
  const identity=state?.characterIntel?.identity||{};if(!identity.name||!identity.playerId||!Number.isFinite(Number(identity.seasonId)))return null;
  const seasonId=Number(identity.seasonId),seasonNumber=String(seasonId).length>=4?Number(String(seasonId).slice(0,2)):seasonId;
  const playerId=String(identity.playerId);const id=`char_${playerId.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,60)}_ss${seasonId}`;
  let profile=data.characterProfiles.find(x=>x.id===id);if(profile)return profile;
  profile={id,name:String(identity.name),playerId,detectedPlayerId:playerId,seasonId,detectedSeasonId:seasonId,lastSeasonId:seasonId,
    hero:identity.heroName||'',detectedHeroId:identity.heroId||null,specialization:identity.specializationName||'',detectedSpecializationId:identity.specializationId||null,
    level:Math.max(1,Math.min(100,Number(identity.level)||1)),detectedLevel:Number(identity.level)||null,season:`SS${seasonNumber}`,
    notes:'',autoCreated:true,createdAt:Date.now(),updatedAt:Date.now(),lastSeenAt:Date.now(),lastArea:state.area||null,
    characterIntelSnapshot:{...state.characterIntel,capturedAt:Date.now(),source:'UE_game.log · auto-created character profile'}};
  data.characterProfiles.push(profile);return profile;
}
function syncDetectedProfile(state=live){
  let profile=profileForLive(state);
  let created=false;
  if(!profile&&data.settings?.autoCreateDetectedProfiles!==false){
    profile=createDetectedProfile(state);
    created=Boolean(profile);
  }
  if(!profile)return false;
  const mayAutoSelect=data.settings?.autoSelectDetectedProfile!==false;
  if(mayAutoSelect&&data.settings?.activeProfileId!==profile.id){
    data.settings={...data.settings,activeProfileId:profile.id};
    created=true;
  }
  if(created){
    void saveData().then(()=>{if(activePage==='characters')renderCharacters();if(activePage==='builds')renderBuilds();});
    return true;
  }
  return false;
}
function renderCharacters(){
  const profiles=data.characterProfiles||[];const active=activeProfile();
  $('profile-count').textContent=`${profiles.length} ПРОФИЛЕЙ`;$('active-profile-label').textContent=active?`АКТИВЕН: ${active.name}`:'Нет активного профиля';
  $('profile-auto-select').checked=data.settings?.autoSelectDetectedProfile!==false;
  $('profile-list').className='stack-list';
  $('profile-list').innerHTML=profiles.slice().reverse().map(profile=>{
    const count=data.builds.filter(b=>b.profileId===profile.id).length;const isActive=active?.id===profile.id;
    const gearCount=profile.equipmentSnapshot?.items?.reduce((n,x)=>n+(Number(x.count)||1),0)||0;
    const lastSeen=profile.lastSeenAt?`Последний раз: ${date(profile.lastSeenAt)}${profile.lastArea?` · ${esc(profile.lastArea)}`:''}`:'Ещё не обнаружен в игровой сессии';
    return `<article class="build-row ${isActive?'profile-active':''}"><div class="build-row-head"><div><b>${esc(profile.name)}</b><small>${esc(profile.hero||'Герой не указан')} · ${esc(profile.specialization||'специализация не указана')} · ур. ${profile.level} · ${esc(profile.season)} · ID ${esc(profile.playerId||profile.detectedPlayerId||'неизвестен')}</small></div><div class="row-actions"><button data-profile-activate="${profile.id}">${isActive?'Активен':'Сделать активным'}</button><button data-profile-edit="${profile.id}">Изменить</button><button data-profile-delete="${profile.id}">Удалить</button></div></div><small>${count} билдов · ${gearCount} наблюдаемых предметов · ${esc(lastSeen)}${profile.notes?`<br>${esc(profile.notes.slice(0,120))}`:''}</small></article>`;
  }).join('')||'<div class="empty">Добавь первого персонажа. Профили и билды сохраняются локально.</div>';
  const builds=active?data.builds.filter(x=>x.profileId===active.id):[];
  $('profile-builds').className='mini-cards';$('profile-builds').innerHTML=builds.map(b=>`<div class="mini-row"><span>${esc(b.name)} · ${esc(b.mainSkill||'Навык не указан')}</span><b>ур. ${b.level}</b></div>`).join('')||'<div class="empty">У активного персонажа пока нет привязанных билдов.</div>';
  renderEquipmentObserver(active);
  renderCharacterIntel(active);
  renderEquipmentLab(active);
  void renderCharacterReport(active);
  if(!profiles.length)fillProfileForm(null);
}
function renderEquipmentObserver(profile=activeProfile()){
  const liveEquipment=live.equipment||live.gameLog?.equipment||{items:[],stats:{},completeness:'partial'};
  const liveRows=Array.isArray(liveEquipment.items)?liveEquipment.items:[];
  const saved=profile?.equipmentSnapshot||null;
  const useLive=Boolean(liveEquipment.lastTransition)||liveRows.length>0;
  const rows=useLive?liveRows:(saved?.items||[]);
  const source=useLive?'Текущие события игрового лога':saved?`Сохранённый снимок · ${date(saved.capturedAt)}`:'Снимок пока не сохранён';
  const stats=liveEquipment.stats||{};
  $('equipment-confidence').textContent=useLive?'ЧАСТИЧНЫЙ · LIVE':saved?'СОХРАНЁННЫЙ ЧАСТИЧНЫЙ':'ОЖИДАНИЕ СОБЫТИЙ';
  $('equipment-source').textContent=`${source} · PutOn ${number(stats.putOnTransactions||0,0)} · PutOff ${number(stats.putOffTransactions||0,0)} · непарных снятий ${number(stats.unmatchedPutOff||0,0)}`;
  $('live-equipment-list').className=rows.length?'equipment-grid':'equipment-grid empty';
  $('live-equipment-list').innerHTML=rows.map(item=>`<article class="equipment-item"><img data-id="${Number(item.itemId)}" alt=""><div><b>${esc(item.name||`Предмет #${item.itemId}`)}</b><small>ID ${Number(item.itemId)} · ${esc(item.itemType||'Тип неизвестен')} · ×${number(item.count||1,0)}</small><small>${esc(item.source||'Снимок экипировки')}</small></div></article>`).join('')||'В текущем логе ещё нет подтверждённых предметов. Попробуй снять и снова надеть один предмет. Если PutOff произошло до первого наблюдаемого PutOn, Nexus отметит непарное снятие, но не станет угадывать исходный предмет.';
  if(liveEquipment.lastTransition){const t=liveEquipment.lastTransition;$('live-equipment-list').insertAdjacentHTML('beforeend',`<div class="equipment-transition"><b>Последнее изменение: ${t.action==='put-on'?'надето':'снято'} · ${esc(t.name)} ×${number(t.quantity,0)}</b><small>${date(t.at)} · ${esc(t.transaction||'BagMgr')}</small></div>`);}
  const transitions=(liveEquipment.transitions||[]).slice(-6).reverse();
  if(transitions.length>1){$('live-equipment-list').insertAdjacentHTML('beforeend',`<div class="equipment-transition-history"><b>Недавние изменения</b>${transitions.map(t=>`<div><span>${t.action==='put-on'?'Надето':'Снято'} · ${esc(t.name)} ×${number(t.quantity,0)}</span><small>${date(t.at)}</small></div>`).join('')}</div>`);}
  if(profile?.equipmentHistory?.length){const history=profile.equipmentHistory.slice(-3).reverse();$('live-equipment-list').insertAdjacentHTML('beforeend',`<div class="equipment-transition-history"><b>Предыдущие сохранённые снимки</b>${history.map(x=>`<div><span>${number(x.items?.length||0,0)} типов предметов · ${esc(x.completeness==='partial'?'частичный':'снимок')}</span><small>${date(x.capturedAt)}</small></div>`).join('')}</div>`);}
  void hydrateIcons($('live-equipment-list'));
  $('save-equipment-snapshot').disabled=!profile||(!rows.length&&!liveEquipment.lastTransition);
  $('save-equipment-snapshot').title=!profile?'Сначала выбери активный профиль':!rows.length&&!liveEquipment.lastTransition?'Нет подтверждённых событий':'Сохранить частичный снимок';
  $('build-from-equipment').disabled=!rows.length&&!saved?.items?.length;
}
function renderEquipmentLab(profile=activeProfile()){
  const selected=characterIntelForProfile(profile),intel=selected.intel;
  const nextItems=Array.isArray(intel?.explicitEquipment)?intel.explicitEquipment.filter(row=>row&&typeof row==='object'):[];
  const fingerprint=JSON.stringify([profile?.id||null,nextItems]);
  if(fingerprint!==equipmentLabEvidenceFingerprint){
    $('equipment-analysis-result').className='equipment-analysis-result empty';
    $('equipment-analysis-result').textContent='Наблюдаемые данные изменились или выбран другой профиль. Запусти анализ заново.';
    $('equipment-compare-result').className='equipment-compare-result empty';
    $('equipment-compare-result').textContent='Выбери два предмета и запусти сравнение.';
    equipmentLabEvidenceFingerprint=fingerprint;
  }
  equipmentLabProfileId=profile?.id||null; equipmentLabItems=nextItems;
  const builds=(data.builds||[]).filter(build=>profile&&build.profileId===profile.id);
  const allowed=['profile-default',...builds.map(build=>String(build.id))];
  if(!allowed.includes(equipmentLabBuildId))equipmentLabBuildId='profile-default';
  $('equipment-priority-build').innerHTML='<option value="profile-default">По умолчанию для профиля</option>'+builds.map(build=>'<option value="'+esc(build.id)+'">'+esc(build.name||'Без названия')+'</option>').join('');
  $('equipment-priority-build').value=equipmentLabBuildId;
  const saved=equipmentLabBuildId==='profile-default'?(profile?.equipmentPriorityText||''):(profile?.equipmentPrioritiesByBuild?.[equipmentLabBuildId]??profile?.equipmentPriorityText??'');
  if(document.activeElement!==$('equipment-priorities'))$('equipment-priorities').value=saved;
  const technical=new Set(['id','baseid','affixid','baseaffixid','affixconfigid','affixbaseid','itemid','itembaseid','itemconfigid','equipmentid','equipmentbaseid','configbaseid']);
  const keys=[...new Set(equipmentLabItems.flatMap(item=>(item.affixes||[]).flatMap(affix=>(affix.values||[]).map(value=>String(value.key||'')).filter(key=>key&&!technical.has(key.replace(/[^a-z0-9]/gi,'').toLowerCase())))))].sort((a,b)=>a.localeCompare(b,'ru'));
  $('equipment-observed-keys').className=keys.length?'intel-schema-list':'intel-schema-list empty';
  $('equipment-observed-keys').innerHTML=keys.map(key=>'<span class="equipment-key-chip">'+esc(key)+'</span>').join('')||'В явных объектах экипировки ключи аффиксов пока не обнаружены.';
  const options=equipmentLabItems.map((item,index)=>'<option value="'+index+'">'+esc(item.name||('Предмет #'+(item.itemId||'?')))+' · ID '+(Number(item.itemId)||'—')+' · '+esc(item.slotRaw||'слот неизвестен')+'</option>').join('');
  $('equipment-compare-left').innerHTML=options||'<option value="">Нет предметов</option>';
  $('equipment-compare-right').innerHTML=options||'<option value="">Нет предметов</option>';
  if(equipmentLabItems.length>1)$('equipment-compare-right').value='1';
  $('equipment-lab-count').textContent=equipmentLabItems.length+' предметов';
  $('equipment-lab-count').title=selected.source==='live'?'Источник: текущие данные UE_game.log':'Источник: сохранённый профиль';
  $('equipment-priorities-save').disabled=!profile;
  $('equipment-analyze').disabled=!equipmentLabItems.length;
  $('equipment-compare-run').disabled=equipmentLabItems.length<2;
}
function renderEquipmentAnalysis(result){
  const root=$('equipment-analysis-result');
  if(!result?.available){root.className='equipment-analysis-result empty';root.textContent=(result?.limitations||['Недостаточно данных для анализа.']).join(' ');return;}
  const coverage=result.priorityCoveragePercent===null?'не рассчитано':result.priorityCoveragePercent+'%';
  const itemRows=(result.items||[]).map(item=>{
    const catalogLabel=item.catalogItem?.matched?(item.catalogItem.name||'Строка предмета сопоставлена'):'ID предмета не найден в импортированной базе';
    const catalogAffixes=(item.affixes||[]).filter(a=>a.catalogMatch?.matched||a.catalogMatch?.attributeMatched).map(a=>(a.catalogMatch.name||('Аффикс '+a.id))+(a.catalogMatch.attributeName?' · '+a.catalogMatch.attributeName:'')+(a.catalogMatch.tierRaw?' · T'+a.catalogMatch.tierRaw:'')+(a.catalogMatch.minRaw!==null&&a.catalogMatch.minRaw!==undefined?' · '+a.catalogMatch.minRaw+'–'+a.catalogMatch.maxRaw:'' )).join(' · ');
    const rawMeta=[['уровень',item.itemLevelRaw],['редкость',item.rarityName?(item.rarityName+' ('+item.rarityRaw+')'):item.rarityRaw],['качество',item.qualityName?(item.qualityName+' ('+item.qualityRaw+')'):item.qualityRaw],['усиление',item.enhanceLevelRaw],['число аффиксов',item.affixCountRaw]].filter(pair=>pair[1]!==null&&pair[1]!==undefined&&pair[1]!=='').map(pair=>pair[0]+': '+pair[1]).join(' · ');
    return '<div class="equipment-lab-stat"><span>'+esc(item.name)+' · ID '+(item.itemId||'—')+' · '+esc(item.slotName?(item.slotName+' · '+(item.slotRaw||'')):(item.slotRaw||'слот неизвестен'))+'<small>'+(rawMeta?esc(rawMeta)+' · ':'')+esc(catalogLabel)+(catalogAffixes?' · '+esc(catalogAffixes):'')+'</small></span><b>Найдено полей '+(item.priorityCoveragePercent===null?'—':item.priorityCoveragePercent+'%')+'</b></div>';
  }).join('');
  const rules=(result.rules||[]).map(row=>'<div class="equipment-rule"><div><b>'+esc(row.label)+'</b><small>'+esc(row.rawKey)+' · вес '+row.weight+'</small></div><div><b>'+(row.status==='observed'?'Наблюдается':'Не обнаружено')+'</b><small>'+(row.examples.map(x=>esc(x.itemName)+': '+esc(x.value)+((x.catalogAffix?' · '+esc(x.catalogAffix.name||x.catalogAffix.rowName||'аффикс из таблицы')+(x.catalogAffix.tierRaw?' · T'+esc(x.catalogAffix.tierRaw):'')+(x.catalogAffix.minRaw!==null&&x.catalogAffix.minRaw!==undefined?' · диапазон '+esc(x.catalogAffix.minRaw)+'–'+esc(x.catalogAffix.maxRaw):''):'')+(x.catalogAttribute?' · характеристика: '+esc(x.catalogAttribute.enumName||x.catalogAttribute.name||x.catalogAttribute.rowName||'enum'):'') )).join(' · ')||'Нет примеров в явных аффиксах')+'</small></div></div>').join('');
  const weak=(result.weakSpots||[]).map(row=>'<div class="equipment-weak"><b>'+esc(row.label)+' · '+esc(row.rawKey)+'</b><small>'+esc(row.explanation)+'</small></div>').join('');
  const recommendations=(result.recommendations||[]).map(row=>'<div class="equipment-lab-stat"><span>'+esc(row.label)+' · вес '+row.weight+'</span><b>'+esc(row.message)+'</b></div>').join('');
  root.className='equipment-analysis-result';
  const catalog=result.resourceCatalog||{};
  const resourceLabel=catalog.imported?'Игровая база: '+number(catalog.affixDefinitions||0,0)+' аффиксов, '+number(catalog.attributeDefinitions||0,0)+' таблиц enum и '+number(catalog.itemDefinitions||0,0)+' предметов · сопоставлено '+number(catalog.matchedAffixes||0,0)+' аффиксов':'Игровая база не импортирована';
  root.innerHTML='<div class="equipment-verdict"><b>Покрытие приоритетов в данных: '+coverage+'</b><span>'+result.itemCount+' явно наблюдаемых объектов · '+result.ruleCount+' правил · вес обнаруженных полей '+result.foundWeight+'/'+result.totalWeight+'</span><small>'+esc(resourceLabel)+'</small></div>'+(itemRows?'<div class="form-divider">ДОЛЯ НАЙДЕННЫХ ПОЛЕЙ ПРИОРИТЕТА ПО ПРЕДМЕТАМ (НЕ ОЦЕНКА СИЛЫ)</div>'+itemRows:'')+(rules||'<div class="empty">Не заданы корректные правила приоритета.</div>')+(weak?'<div class="form-divider">ВОЗМОЖНЫЕ СЛАБЫЕ МЕСТА В НАБЛЮДАЕМЫХ ДАННЫХ</div>'+weak:'')+(recommendations?'<div class="form-divider">РЕКОМЕНДАЦИИ ПО ТВОИМ ПРИОРИТЕТАМ</div>'+recommendations:'')+'<div class="equipment-note">'+(result.limitations||[]).map(esc).join(' ')+'</div>';
}
function renderEquipmentComparison(result){
  const root=$('equipment-compare-result');
  if(!result?.available){root.className='equipment-compare-result empty';root.textContent=result?.message||'Для сравнения недостаточно данных.';return;}
  const verdict=result.verdict==='left'?'По сравнимым правилам преимущество у A':result.verdict==='right'?'По сравнимым правилам преимущество у B':result.verdict==='tie'?'По сравнимым правилам равенство':'Недостаточно сопоставимых данных';
  const rows=(result.ruleResults||[]).map(row=>'<div class="equipment-rule"><div><b>'+esc(row.label)+'</b><small>'+esc(row.rawKey)+' · вес '+row.weight+' · '+esc(row.direction)+'</small></div><div><b>'+esc(row.leftValue??'—')+' ↔ '+esc(row.rightValue??'—')+'</b><small>'+esc(row.explanation)+'</small></div></div>').join('');
  root.className='equipment-compare-result';
  const leftMeta=[['слот',result.left.slotName?(result.left.slotName+' ('+result.left.slotRaw+')'):result.left.slotRaw],['уровень',result.left.itemLevelRaw],['редкость',result.left.rarityName?(result.left.rarityName+' ('+result.left.rarityRaw+')'):result.left.rarityRaw],['качество',result.left.qualityName?(result.left.qualityName+' ('+result.left.qualityRaw+')'):result.left.qualityRaw],['усиление',result.left.enhanceLevelRaw]].filter(pair=>pair[1]!==null&&pair[1]!==undefined&&pair[1]!=='').map(pair=>pair[0]+': '+pair[1]).join(' · ');
  const rightMeta=[['слот',result.right.slotName?(result.right.slotName+' ('+result.right.slotRaw+')'):result.right.slotRaw],['уровень',result.right.itemLevelRaw],['редкость',result.right.rarityName?(result.right.rarityName+' ('+result.right.rarityRaw+')'):result.right.rarityRaw],['качество',result.right.qualityName?(result.right.qualityName+' ('+result.right.qualityRaw+')'):result.right.qualityRaw],['усиление',result.right.enhanceLevelRaw]].filter(pair=>pair[1]!==null&&pair[1]!==undefined&&pair[1]!=='').map(pair=>pair[0]+': '+pair[1]).join(' · ');
  const resourceCatalog=result.resourceCatalog||{};
  const catalogRows=(result.catalogAffixes?.left||[]).concat(result.catalogAffixes?.right||[]).filter(row=>row.matched||row.attributeMatched).map(row=>esc(row.name||('Аффикс '+row.id))+(row.attributeName?' · '+esc(row.attributeName):'')+(row.tierRaw?' · T'+esc(row.tierRaw):'')+(row.minRaw!==null&&row.minRaw!==undefined?' · '+esc(row.minRaw)+'–'+esc(row.maxRaw):'')).join(' · ');
  root.innerHTML='<div class="equipment-verdict"><b>'+verdict+'</b><span>'+esc(result.left.name)+' vs '+esc(result.right.name)+' · покрытие сравнимых правил '+(result.score.coveragePercent===null?'—':result.score.coveragePercent+'%')+'</span><small>'+esc(result.explanation)+'</small><small>'+esc(resourceCatalog.imported?'Сопоставлено с локальной базой: '+(resourceCatalog.affixDefinitions||0)+' строк аффиксов, '+(resourceCatalog.attributeDefinitions||0)+' таблиц enum, '+(resourceCatalog.leftAffixMatches||0)+' у A и '+(resourceCatalog.rightAffixMatches||0)+' у B.':'Локальная база игровых аффиксов не импортирована.')+'</small>'+(catalogRows?'<small>Справочник: '+catalogRows+'</small>':'')+'</div><div class="equipment-lab-stat"><span>Предмет A · исходные поля</span><b>'+esc(leftMeta||'Не получены')+'</b></div><div class="equipment-lab-stat"><span>Предмет B · исходные поля</span><b>'+esc(rightMeta||'Не получены')+'</b></div><div class="equipment-lab-stat"><span>Слот</span><b>'+(result.slotComparison.status==='unknown'?'Неизвестен':result.slotComparison.status==='same'?'Совпадает':'Различается')+'</b></div><div class="equipment-lab-stat"><span>Общие ID аффиксов</span><b>'+((result.sharedAffixIds||[]).map(esc).join(', ')||'—')+'</b></div><div class="equipment-lab-stat"><span>Новые ID аффиксов у B</span><b>'+((result.addedAffixIds||[]).map(esc).join(', ')||'—')+'</b></div><div class="equipment-lab-stat"><span>Отсутствующие у B ID аффиксов</span><b>'+((result.removedAffixIds||[]).map(esc).join(', ')||'—')+'</b></div>'+(rows||'<div class="empty">Не заданы правила приоритета или нет сравнимых ключей.</div>')+'<div class="equipment-note">'+(result.limitations||[]).map(esc).join(' ')+'</div>';
}

let displayedItems=[];
async function searchCatalog(q){displayedItems=await window.nexus.searchItems(q);renderItemCards();}
function renderItemCards(){const root=$('item-results');$('item-results-count').textContent=`${displayedItems.length} результатов`;
  root.innerHTML=displayedItems.map(x=>`<article class="item-card"><img data-id="${x.id}" alt=""><div class="item-info"><b>${esc(x.name)}</b><small>${esc(x.type)} · ID ${x.id}</small></div><button data-watch-id="${x.id}" data-watch-name="${esc(x.name)}">Отслеживать</button></article>`).join('')||'<div class="empty">Ничего не найдено.</div>';void hydrateIcons(root);}
function renderEconomy(){const p=live.pricing||{};$('own-prices').textContent=number(p.ownCount,0);$('community-prices').textContent=number(p.communityCount,0);$('price-items').textContent=number((live.prices||[]).length,0);$('price-status').textContent=p.fetching?'Загрузка':p.stale?'Кэш':'Активен';$('price-updated').textContent=p.fetchedAt?`Обновлено ${date(p.fetchedAt)}`:p.error||'Нет отметки обновления';$('economy-season').textContent=live.seasonId?`Сезон ${seasonLabel(live.seasonId)}`:'Сезон не определён';
  const prices=new Map((live.prices||[]).map(x=>[Number(x.configBaseId),x]));
  const statuses=new Map((live.priceWatchStatus||[]).map(x=>[Number(x.itemId),x]));
  $('watch-table').innerHTML=data.priceWatch.map((w,i)=>{const p=prices.get(Number(w.itemId));const status=statuses.get(Number(w.itemId));const price=p?.fe??status?.currentPriceFe??null;const reached=status?.belowTarget===true||(price!==null&&Number(w.targetFe)>0&&price<=Number(w.targetFe));const lastAlert=status?.lastAlertAt||w.lastAlertAt;return `<tr><td>${esc(w.name)} <small>ID ${w.itemId}</small></td><td>${price===null?'Нет цены':money(price)}<small>${esc(status?.priceSource||p?.source||'')}</small></td><td><input class="price-target-input" data-watch-target="${i}" type="number" min="0" step="0.01" value="${Number(w.targetFe)>0?Number(w.targetFe):''}" placeholder="0" aria-label="Целевая цена в FE"></td><td>${reached?'<span class="good">Цель достигнута</span>':price===null?'Ожидание цены':Number(w.targetFe)>0?'Ожидание порога':'Только график'}${lastAlert?`<small>Уведомление: ${date(lastAlert)}</small>`:''}</td><td><button class="row-actions-button" data-price-history="${Number(w.itemId)}" data-price-name="${esc(w.name)}">График</button></td><td><button class="row-delete" data-watch-remove="${i}">×</button></td></tr>`;}).join('')||'<tr><td colspan="6" class="empty">Добавь предмет в список наблюдения.</td></tr>';
  calcDeal();}
async function showPriceHistory(itemId,name,days=30,seasonMode='current'){
  const selectedSeason=seasonMode==='all'?undefined:(Number(live.seasonId)||undefined);
  const history=await window.nexus.getPriceHistory(Number(itemId),days,selectedSeason);const points=history.points||[];
  const seasonCaption=selectedSeason?seasonLabel(selectedSeason):'Все сезоны';
  const filters=`<div class="price-history-filters"><span>Период:</span>${[7,30,90,120].map(x=>`<button class="row-actions-button ${x===days?'selected':''}" data-price-days="${x}" data-price-id="${itemId}" data-price-name="${esc(name)}" data-price-season="${seasonMode}">${x} дн.</button>`).join('')}<button class="row-actions-button ${seasonMode==='all'?'selected':''}" data-price-season-toggle="all" data-price-id="${itemId}" data-price-name="${esc(name)}" data-price-days="${days}">Все сезоны</button></div>`;
  if(!points.length){openModal(`<h3>История цены · ${esc(name)}</h3>${filters}<p class="hint">За выбранный период (${days} дней, ${esc(seasonCaption)}) пока нет ценовых снимков. Nexus записывает точки при изменении от 2% или не чаще одного снимка в сутки.</p>`);return;}
  const width=480,height=150,pad=18,min=Math.min(...points.map(x=>x.fe)),max=Math.max(...points.map(x=>x.fe)),range=Math.max(.0001,max-min);
  const coords=points.map((x,i)=>({x:pad+(points.length===1?0:i/(points.length-1))*(width-pad*2),y:height-pad-((x.fe-min)/range)*(height-pad*2)}));
  const poly=coords.map(x=>`${x.x.toFixed(1)},${x.y.toFixed(1)}`).join(' ');
  const circles=coords.map((x,i)=>`<circle cx="${x.x.toFixed(1)}" cy="${x.y.toFixed(1)}" r="3" fill="#b49aff"><title>${date(points[i].at)} · ${money(points[i].fe)}</title></circle>`).join('');
  const delta=history.changePercent===null?'—':`${history.changePercent>=0?'+':''}${number(history.changePercent,1)}%`;
  openModal(`<h3>История цены · ${esc(name)}</h3>${filters}<div class="price-history-kpis"><span>Последняя <b>${money(history.latest)}</b></span><span>Минимум <b>${money(history.minimum)}</b></span><span>Максимум <b>${money(history.maximum)}</b></span><span>Изменение <b>${delta}</b></span></div><svg class="price-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="История цены в FE"><path d="M${pad} ${height-pad} H${width-pad}" stroke="#41445b" stroke-width="1" fill="none"/><polyline points="${poly}" fill="none" stroke="#ad91f4" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${circles}</svg><p class="hint">Снимков: ${points.length} · период: ${days} дней · выборка: ${esc(seasonCaption)}. Цены из разных сезонов не смешиваются в режиме текущего сезона.</p>`);
}
function calcDeal(){const buy=Number($('deal-buy').value)||0,sell=Number($('deal-sell').value)||0,fee=Number($('deal-fee').value)||0,qty=Math.max(1,Number($('deal-qty').value)||1),net=(sell-buy)*qty-fee,roi=buy>0?(net/(buy*qty))*100:null;$('deal-result').innerHTML=`Чистая разница: <b class="${net>=0?'positive':'negative'}">${number(net,2)} FE</b><br>ROI: <b>${roi===null?'—':`${number(roi,2)}%`}</b><br>Сумма покупки: ${money(buy*qty)} · Сумма продажи: ${money(sell*qty)} · Расходы: ${money(fee)}`;}
function buildFromForm(){const existing=data.builds.find(x=>x.id===$('build-id').value);const stats={...(existing?.stats||{}),...Object.fromEntries(selectedBuildObservedStats.map(x=>[x.key,Number(x.value)])),conversionPercent:$('build-conversion').value};return {id:existing?.id||makeUid('build'),profileId:$('build-profile').value||null,investmentFe:$('build-investment').value===''?null:Number($('build-investment').value),name:$('build-name').value,hero:$('build-hero').value,level:$('build-level').value,season:$('build-season').value,mainSkill:$('build-skill').value,damageType:$('build-damage').value,expectsFullConversion:$('build-full-conversion').checked,stats,observedStats:selectedBuildObservedStats.map(x=>({...x})),observedInventory:lines($('build-observed-inventory').value),targets:existing?.targets||{},gearSlots:lines($('build-gear').value),skills:lines($('build-skills').value),talents:lines($('build-talents').value),notes:$('build-notes').value,createdAt:existing?.createdAt||Date.now(),updatedAt:Date.now()};}
function fillBuildForm(b){selectedBuildObservedStats=(b?.observedStats||[]).map(x=>({...x}));$('build-id').value=b?.id||'';$('build-profile').value=b?.profileId||data.settings?.activeProfileId||'';$('build-investment').value=b?.investmentFe??'';$('build-name').value=b?.name||'';$('build-hero').value=b?.hero||'';$('build-level').value=b?.level||100;$('build-season').value=b?.season||'SS14 · Tartarus';$('build-skill').value=b?.mainSkill||'';$('build-damage').value=b?.damageType||'';$('build-conversion').value=b?.stats?.conversionPercent??'';$('build-full-conversion').checked=b?.expectsFullConversion===true;$('build-gear').value=(b?.gearSlots||[]).join('\n');$('build-observed-inventory').value=(b?.observedInventory||[]).join('\n');$('build-skills').value=(b?.skills||[]).join('\n');$('build-talents').value=(b?.talents||[]).join('\n');$('build-notes').value=b?.notes||'';$('build-form-title').textContent=b?'Редактирование сборки':'Создать сборку';}
function renderBuilds(){const root=$('build-list');$('build-count').textContent=data.builds.length;root.className='stack-list';root.innerHTML=data.builds.slice().reverse().map(b=>{const profile=data.characterProfiles.find(p=>p.id===b.profileId);return `<article class="build-row"><div class="build-row-head"><div><b>${esc(b.name)}</b><small>${esc(profile?.name||b.hero||'Профиль не привязан')} · ур. ${b.level} · ${esc(b.season)}</small></div><div class="row-actions"><button data-build-edit="${b.id}">Изменить</button><button data-build-analyze="${b.id}">Анализ</button><button data-build-delete="${b.id}">Удалить</button></div></div><small>Навык: ${esc(b.mainSkill||'не указан')} · ${esc(b.damageType||'тип урона не указан')} · вложено ${b.investmentFe===null||b.investmentFe===undefined?'—':money(b.investmentFe)}</small></article>`;}).join('')||'<div class="empty">Пока нет сохранённых билдов.</div>';
  const profileOptions=data.characterProfiles.map(p=>`<option value="${p.id}">${esc(p.name)} · ${esc(p.hero||'Герой не указан')}</option>`).join('');const currentProfile=$('build-profile').value;$('build-profile').innerHTML='<option value="">Без привязки</option>'+profileOptions;$('build-profile').value=currentProfile||data.settings?.activeProfileId||'';
  const options=data.builds.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('');$('compare-a').innerHTML=options||'<option value="">Нет билдов</option>';$('compare-b').innerHTML=options||'<option value="">Нет билдов</option>';$('analyzer-build').innerHTML=options||'<option value="">Сначала создай билд</option>';
  if(selectedBuildId&&data.builds.some(b=>b.id===selectedBuildId))$('analyzer-build').value=selectedBuildId;
}
async function renderAnalyzer(){renderBuilds();const build=data.builds.find(b=>b.id===$('analyzer-build').value)||data.builds[0];if(!build){$('stat-editor').innerHTML='<div class="empty">Сначала создай билд в лаборатории.</div>';return;}selectedBuildId=build.id;
  $('stat-editor').innerHTML=statFields.map(([key,label])=>`<div class="stat-input"><b>${label}</b><div class="pair"><input type="number" step="any" data-stat="${key}" value="${build.stats?.[key]??''}" placeholder="Факт" title="Текущее значение"><input type="number" step="any" data-target="${key}" value="${build.targets?.[key]??''}" placeholder="Твоя цель" title="Целевое значение"></div><small>Факт / личная цель</small></div>`).join('');$('analysis-findings').textContent='Измени значения и нажми «Проверить персонажа».';$('analysis-completeness').textContent='Заполни лист характеристик';latestAnalysis=null;}
function importObservedStatsIntoBuild(build, intel){
  if(!build||!intel)return 0;
  build.stats=build.stats||{};build.observedStats=Array.isArray(build.observedStats)?build.observedStats:[];
  let added=0;
  for(const row of intel.stats||[]){
    if(!statLabels.has(row.key)||!Number.isFinite(Number(row.value)))continue;
    build.stats[row.key]=Number(row.value);added++;
  }
  build.observedStats=(intel.stats||[]).filter(row=>statLabels.has(row.key)).map(row=>({...row}));
  return added;
}
function appendCharacterIntelToBuild(){
  const profile=data.characterProfiles.find(x=>x.id===$('build-profile').value)||activeProfile();
  const {intel}=characterIntelForProfile(profile);if(!intel)return {stats:0,skills:0,talents:0,inventory:0,equipment:0};
  let skillsAdded=0,talentsAdded=0,inventoryAdded=0;
  const addUnique=(textarea,entries,format)=>{const current=lines(textarea.value),set=new Set(current);let added=0;for(const entry of entries){const text=format(entry);if(text&&!set.has(text)){current.push(text);set.add(text);added++;}}textarea.value=current.join('\n');return added;};
  skillsAdded=addUnique($('build-skills'),intel.skills||[],x=>`${x.name||`Навык ID ${x.id}`} · ID ${x.id}${x.level!==null&&x.level!==undefined?` · ур. ${x.level}`:''} · источник ${x.sourceAction||'UE'}`);
  talentsAdded=addUnique($('build-talents'),intel.talents||[],x=>`${x.name||`Талант ID ${x.id}`} · ID ${x.id}${x.level!==null&&x.level!==undefined?` · уровень ${x.level}`:''} · источник ${x.sourceAction||'UE'}`);
  const latest=intel.latestInventory||(intel.inventorySnapshots||[]).slice(-1)[0];
  if(latest){
    const existing=lines($('build-observed-inventory').value);const seen=new Set(existing);
    for(const item of latest.items||[]){const text=`${latest.action} · ID ${item.itemId} · ${item.name||`Предмет #${item.itemId}`} ×${Number(item.count)||1}`;if(!seen.has(text)){existing.push(text);seen.add(text);inventoryAdded++;}}
    $('build-observed-inventory').value=existing.join('\n');
  }
  const equipment=(live.equipment?.items?.length?live.equipment:profile?.equipmentSnapshot)?.items||[];
  const currentGear=lines($('build-gear').value),gearSeen=new Set(currentGear);let equipmentAdded=0;
  for(const item of equipment){const text=`Наблюдаемый PutOn без слота · ID ${item.itemId} · ${item.name||`Предмет #${item.itemId}`} ×${Number(item.count)||1}`;if(!gearSeen.has(text)){currentGear.push(text);gearSeen.add(text);equipmentAdded++;}}
  for(const item of intel.explicitEquipment||[]){const text=`Явная экипировка · ${item.slotRaw||'слот не указан'} · ID ${item.itemId} · ${item.name||`Предмет #${item.itemId}`} · ${item.affixes?.length||0} ID аффиксов`;if(!gearSeen.has(text)){currentGear.push(text);gearSeen.add(text);equipmentAdded++;}}
  $('build-gear').value=currentGear.join('\n');
  const statsAdded=importObservedStatsIntoBuild(buildFromForm(),intel);
  selectedBuildObservedStats=(intel.stats||[]).filter(row=>statLabels.has(row.key)).map(row=>({...row}));
  return {stats:statsAdded,skills:skillsAdded,talents:talentsAdded,inventory:inventoryAdded,equipment:equipmentAdded};
}
function importObservedStatsToAnalyzer(){
  const build=data.builds.find(x=>x.id===$('analyzer-build').value);if(!build)return toast('Сначала выбери билд');
  const profile=data.characterProfiles.find(x=>x.id===build.profileId)||activeProfile();const {intel}=characterIntelForProfile(profile);
  if(!intel?.stats?.length)return toast('В игровом логе пока нет распознанных числовых характеристик. Проверь диагностику структуры и пересканируй лог.');
  const count=importObservedStatsIntoBuild(build,intel);if(!count)return toast('В логе нет показателей, поддерживаемых текущим листом характеристик.');
  selectedBuildId=build.id;void saveData().then(()=>renderAnalyzer());toast(`Подставлено явных показателей из лога: ${count}. Значения сохранены с источниками.`);
}
function captureAnalyzer(){const build=data.builds.find(b=>b.id===$('analyzer-build').value);if(!build)return null;build.stats=build.stats||{};build.targets=build.targets||{};for(const input of document.querySelectorAll('[data-stat]'))build.stats[input.dataset.stat]=input.value===''?null:Number(input.value);for(const input of document.querySelectorAll('[data-target]'))build.targets[input.dataset.target]=input.value===''?null:Number(input.value);return build;}
function renderBuildAudit(report){
  const root=$('build-audit-results');
  if(!root)return;
  if(!report){root.className='build-audit-results empty';root.textContent='Нет результата полного анализа.';return;}
  const summary=report.summary||{};
  const character=report.character||{};
  const value=(v)=>v===null||v===undefined||v===''?'—':esc(String(v));
  const statusLabel=(status)=>({observed:'Найдено','not-observed':'Не найдено',unverifiable:'Нельзя сверить','no-live-data':'Нет снимка'})[status]||status;
  const statRows=(report.stats||[]).filter(row=>row.current!==null||row.target!==null).map(row=>`<tr><td>${esc(row.label)}</td><td>${value(row.current)}</td><td>${value(row.target)}</td><td>${row.belowTarget?`<span class="negative">не хватает ${value(row.gap)}</span>`:'—'}</td><td><small>${esc(row.source||'')}</small></td></tr>`).join('');
  const renderEntries=(group)=>group?.expected?.length?group.expected.map(row=>`<div class="audit-line"><div><b>${esc(row.text)}</b><small>${row.id?`ID ${esc(row.id)} · `:''}${row.matched?.length?`Совпало: ${row.matched.map(x=>esc(x.name||x.id)).join(', ')}`:''}</small></div><span class="audit-status ${esc(row.status)}">${esc(statusLabel(row.status))}</span></div>`).join(''):'<div class="empty">В сохранённой сборке нет записей.</div>';
  const gear=(report.equipment?.items||[]).map(item=>`<article class="audit-gear"><div class="audit-gear-head"><div><b>${esc(item.name)}</b><small>${esc(item.slot)} · ID ${value(item.itemId)} · ${item.catalogMatch?'найдено в FModel':'нет точной строки предмета'}</small></div><span>${item.affixes?.length||0} афф.</span></div>${(item.affixes||[]).map(affix=>`<div class="audit-line"><div><b>${esc(affix.name)}</b><small>${affix.id?`ID ${esc(affix.id)} · `:''}${affix.attributeName?esc(affix.attributeName):affix.attributeRaw?`AttrType ${esc(affix.attributeRaw)}`:''}${affix.tier?` · T${esc(affix.tier)}`:''}${affix.min!==null&&affix.min!==undefined?` · диапазон ${esc(String(affix.min))}–${esc(String(affix.max))}`:''}</small></div><span class="audit-status ${affix.rollStatus==='low-quarter'?'not-observed':'observed'}">${affix.value?esc(affix.value):'Значение —'}${affix.rollPercent!==null?` · ${number(affix.rollPercent,1)}%`:''}</span></div>`).join('')||'<small class="muted">Явные аффиксы не найдены.</small>'}</article>`).join('')||'<div class="empty">Подтверждённая экипировка из лога пока не восстановлена.</div>';
  const recommendations=(report.recommendations||[]).map((row,index)=>`<article class="audit-recommendation ${esc(row.severity)}"><div class="audit-rank">${index+1}</div><div><b>${esc(row.title)}</b><p>${esc(row.reason)}</p><small><strong>Что сделать:</strong> ${esc(row.action)}</small></div></article>`).join('')||'<div class="empty">По доступным данным явных действий не найдено. Это не подтверждает оптимальность билда.</div>';
  const focus=(report.damageFocus?.checkedStats||[]).map(row=>`<span class="audit-chip">${esc(row.label)}: ${row.observed?'есть данные':'нет данных'}${row.target!==null?` · цель ${value(row.target)}`:''}</span>`).join('');
  const limitations=(report.limitations||[]).map(row=>`<li>${esc(row)}</li>`).join('');
  root.className='build-audit-results';
  $('build-audit-state').textContent=report.status==='stale-character-data'?'СНИМОК УСТАРЕЛ':report.status==='no-live-character-data'?'НЕТ ДАННЫХ ПЕРСОНАЖА':'АУДИТ ГОТОВ';
  root.innerHTML=`
    <div class="audit-summary"><div><small>ПЕРСОНАЖ</small><b>${esc(character.name||'Не определён')}</b><span>${esc(character.hero||'Герой не указан')} · ${esc(character.specialization||'специализация не указана')}</span></div><div><small>ПОКРЫТИЕ ДАННЫХ</small><b>${number(summary.dataCoveragePercent||0,0)}%</b><span>Не является рейтингом силы</span></div><div><small>ПРОБЛЕМЫ</small><b>${number(summary.recommendations||0,0)}</b><span>Приоритетных действий</span></div><div><small>ЭКИПИРОВКА</small><b>${number(summary.explicitEquipmentItems||0,0)}</b><span>Явно наблюдаемых предметов</span></div></div>
    <section class="audit-section"><h4>1. Характеристики и цели</h4><div class="table-wrap"><table><thead><tr><th>ПАРАМЕТР</th><th>СЕЙЧАС</th><th>ЦЕЛЬ</th><th>РАЗРЫВ</th><th>ИСТОЧНИК</th></tr></thead><tbody>${statRows||'<tr><td colspan="5" class="empty">Нет показателей для сравнения. Внеси значения или импортируй их из лога.</td></tr>'}</tbody></table></div></section>
    <div class="audit-two"><section class="audit-section"><h4>2. Навыки и поддержки</h4><div class="audit-list">${renderEntries(report.skills)}</div><small class="muted">Снимок из лога: ${number(report.skills?.observedCount||0,0)} записей. ID сравниваются точно.</small></section><section class="audit-section"><h4>3. Таланты</h4><div class="audit-list">${renderEntries(report.talents)}</div><small class="muted">Снимок из лога: ${number(report.talents?.observedCount||0,0)} записей. ID сравниваются точно.</small></section></div>
    <section class="audit-section"><h4>4. Экипировка и аффиксы</h4><div class="audit-gear-grid">${gear}</div><small class="muted">Сопоставлено с FModel: предметов ${number(summary.matchedItemDefinitions||0,0)}, аффиксов ${number(summary.matchedAffixes||0,0)}. Частичных событий PutOn/PutOff: ${number(report.equipment?.partialObservedItems||0,0)}. Полный комплект не подтверждён.</small></section>
    <section class="audit-section"><h4>5. Фокус урона</h4><div class="audit-chips">${focus||'<span class="muted">Тип урона не указан.</span>'}</div><small class="muted">Эти параметры помогают найти недостающие данные, но Nexus не выводит выдуманный DPS и не рассчитывает мультипликаторы без подтверждённых формул.</small></section>
    <section class="audit-section"><h4>6. План улучшений по приоритету</h4><div class="audit-recommendations">${recommendations}</div></section>
    <section class="audit-section audit-caveats"><h4>Что пока нельзя надёжно проверить</h4><p>${esc(report.interactions?.explanation||'Связи навыков, поддержек и талантов требуют подтверждённой игровой базы эффектов.')}</p><ul>${limitations}</ul></section>
    <p class="disclaimer">${esc(report.disclaimer||'Результат основан только на подтверждённых игровых полях и пользовательских целях.')}</p>`;
}
async function runAnalyzer(){
  const build=captureAnalyzer();
  if(!build)return toast('Сначала создай билд');
  await saveData();
  const report=await window.nexus.analyzeBuild(build);
  latestAnalysis=report;
  $('analysis-completeness').textContent=`Заполненность ручных данных: ${report.completeness}% · ${report.knownStats}/${report.totalStats} характеристик`;
  $('analysis-findings').className='findings';
  $('analysis-findings').innerHTML=report.findings.map(f=>`<article class="finding ${f.severity}"><span class="severity">${f.severity==='warning'?'⚠':f.severity==='success'?'✓':'ⓘ'}</span><div><b>${esc(f.title)}</b><p>${esc(f.detail)} ${f.action?`<br><strong>Что проверить:</strong> ${esc(f.action)}`:''}</p></div></article>`).join('');
  const audit=await window.nexus.diagnoseBuild(build,build.profileId||null);
  renderBuildAudit(audit);
}
async function renderFarming(){
  const allSessions=data.farmingSessions||[];
  const previousFilter=$('farm-profile-filter').value;
  $('farm-profile-filter').innerHTML='<option value="">Все персонажи</option>'+data.characterProfiles.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if(data.characterProfiles.some(p=>p.id===previousFilter))$('farm-profile-filter').value=previousFilter;
  const profileId=$('farm-profile-filter').value||null;
  const sessions=profileId?allSessions.filter(x=>x.profileId===profileId):allSessions;
  const analytics=await window.nexus.analyzeFarming(sessions,{profileId});
  $('farm-count').textContent=analytics.sessionCount;
  $('farm-median').textContent=analytics.overall?`${number(analytics.overall.medianFePerHour,1)} FE/ч`:'—';
  $('farm-variability').textContent=analytics.overall?.variability||'—';
  $('farm-cv').textContent=analytics.overall?.coefficientOfVariation===null||analytics.overall?.coefficientOfVariation===undefined?'Нужно минимум 3 сессии':`CV ${number(analytics.overall.coefficientOfVariation,1)}% · MAD ${number(analytics.overall.medianAbsoluteDeviation,1)}`;
  $('farm-profitable').textContent=analytics.overall?`${number(analytics.overall.profitablePercent,0)}%`:'—';
  $('farm-time').textContent=`${number(analytics.totalSeconds/3600,1)} ч`;
  $('farm-net').textContent=`Чистый итог: ${money(analytics.totalNetFe)}`;
  const currentRevenue=Number(live.sessionValueFe)||0,sessionEnd=Number(live.gameEndedAt)||Date.now(),seconds=live.startedAt?Math.max(1,(sessionEnd-live.startedAt)/1000):0,cost=Number($('farm-costs').value)||0,lastMap=live.currentMap||live.lastMap;
  $('farm-current-result').innerHTML=`Дроп за запуск игры: <b>${money(currentRevenue)}</b><br>Завершено карт: <b>${number(live.mapsCompleted||0,0)}</b><br>Последняя / текущая карта: <b>${esc(lastMap?.name||'ещё не обнаружена')}</b> · ${money(lastMap?.lootValueFe||0)}<br>Расходы: <b>${money(cost)}</b><br>Чистый результат: <b class="${currentRevenue-cost>=0?'positive':'negative'}">${money(currentRevenue-cost)}</b><br>Продолжительность запуска: ${duration(seconds)} · Чистая скорость: ${seconds?number((currentRevenue-cost)/(seconds/3600),1)+' FE/ч':'—'}`;
  $('farm-strategy-table').innerHTML=analytics.strategies.map(x=>`<tr><td>${esc(x.name)}</td><td>${x.sessions}</td><td><b>${number(x.medianFePerHour,1)} FE/ч</b></td><td>${number(x.p25FePerHour,1)}–${number(x.p75FePerHour,1)} FE/ч</td><td>${number(x.profitablePercent,0)}% (${x.profitableSessions}/${x.sessions})</td><td>${x.sessions<3?'<span class="warn">Мало данных</span>':esc(x.variability)}</td></tr>`).join('')||'<tr><td colspan="6" class="empty">Нужны завершённые сессии с названием стратегии.</td></tr>';
  $('farm-analysis-note').textContent=analytics.note+(analytics.topStrategy?` Лучшая подтверждённая выборка: ${analytics.topStrategy.name} — медиана ${number(analytics.topStrategy.medianFePerHour,1)} FE/ч, ${number(analytics.topStrategy.profitablePercent,0)}% прибыльных сессий (${analytics.topStrategy.sessions} забегов).`:' Пока нет стратегии с тремя завершёнными сессиями.');
  $('farm-table').innerHTML=sessions.slice().sort((a,b)=>(b.startedAt||0)-(a.startedAt||0)).map(x=>{const net=(Number(x.lootValueFe)||0)-(Number(x.costsFe)||0),h=Number(x.durationSec)||0,rate=h>0?net/(h/3600):null;const profile=data.characterProfiles.find(p=>p.id===x.profileId),maps=Number(x.mapsCompleted??x.mapRuns?.length)||0;const mapButton=maps?`<button class="map-history-button" data-map-history="${esc(x.sessionKey||x.id)}">${maps} карт</button>`:'0';return `<tr><td>${date(x.startedAt)}</td><td>${esc(x.strategy||x.area||'Игровой запуск')}<small>${esc(profile?.name||x.player||'Профиль не привязан')}</small></td><td>${duration(h)}</td><td>${mapButton}</td><td>${money(x.lootValueFe)}</td><td>${money(x.costsFe)}</td><td class="${net>=0?'positive':'negative'}">${money(net)}</td><td>${rate===null?'—':`${number(rate,1)} FE/ч`}</td></tr>`;}).join('')||'<tr><td colspan="8" class="empty">История игровых запусков пока пуста.</td></tr>';
}
$('farm-table').addEventListener('click',e=>{
  const button=e.target.closest('[data-map-history]');
  if(!button)return;
  const session=data.farmingSessions.find(row=>(row.sessionKey||row.id)===button.dataset.mapHistory);
  const maps=(session?.mapRuns||[]).slice().reverse();
  if(!maps.length)return toast('У этого игрового запуска пока нет сохранённых карт');
  const content=maps.map(map=>{
    const loot=(map.lootSummary||[]).slice(0,10).map(item=>`<div class="map-history-item"><span>${esc(item.name)} ×${number(item.count,0)}</span><b>${item.valueFe===null?'—':money(item.valueFe)}</b></div>`).join('');
    return `<article class="map-history-card"><div class="map-history-head"><div><b>${esc(map.name||'Карта')}</b><small>${date(map.startedAt)} · ${duration((Number(map.durationSec)||0)*1000)} · ${number(map.drops||0,0)} предметов</small></div><strong>${money(map.lootValueFe||0)}</strong></div><div class="map-history-items">${loot||'<span class="hint">Подобранные предметы не записаны.</span>'}</div></article>`;
  }).join('');
  openModal(`<h3>Карты за игровой запуск</h3><p class="hint">${esc(session?.player||'Персонаж не определён')} · ${date(session?.startedAt)} · сохранено карт: ${maps.length}</p><div class="map-history-list">${content}</div>`);
});
function renderTactics(){const q=$('tactic-search').value.toLowerCase();const rows=data.tactics.filter(x=>`${x.title} ${x.category} ${x.context} ${x.body}`.toLowerCase().includes(q)).slice().reverse();$('tactic-count').textContent=data.tactics.length;$('tactic-list').className='stack-list';$('tactic-list').innerHTML=rows.map(x=>`<article class="tactic-card"><div class="tactic-head"><div><b>${esc(x.title)}</b><small>${esc(x.category)} · ${esc(x.context||'без контекста')} · ${date(x.updatedAt)}</small></div><div class="row-actions"><button data-tactic-edit="${x.id}">Изменить</button><button data-tactic-delete="${x.id}">Удалить</button></div></div><p>${esc(x.body).replace(/\n/g,'<br>')}</p></article>`).join('')||'<div class="empty">Нет подходящих заметок.</div>';}
function renderSettings(){const s=data.settings||{};$('set-mode').value=s.overlayMode||'compact';$('set-opacity').value=s.overlayOpacity??94;$('opacity-label').textContent=`${$('set-opacity').value}%`;$('set-scale').value=s.overlayScale??100;$('scale-label').textContent=`${$('set-scale').value}%`;$('set-top').checked=s.alwaysOnTop!==false;$('set-clickthrough').checked=s.clickThrough===true;$('set-hotkeys').checked=s.hotkeysEnabled!==false;$('set-auto-create-profiles').checked=s.autoCreateDetectedProfiles!==false;$('set-notifications').checked=s.notificationsEnabled!==false;$('set-threshold').value=s.notificationThresholdFe??20;$('set-sound').checked=s.soundEnabled!==false;$('set-volume').value=s.soundVolume??45;$('volume-label').textContent=`${$('set-volume').value}%`;renderTlidbAutoControls({autoSyncEnabled:s.tlidbAutoSyncEnabled!==false,syncIntervalHours:s.tlidbSyncIntervalHours??24});}
function renderPage(){renderConnection();switch(activePage){case'overview':renderOverview();break;case'characters':renderCharacters();break;case'loot':renderLoot();break;case'items':if(!$('item-search').value&&!displayedItems.length)void searchCatalog('');else renderItemCards();break;case'economy':renderEconomy();break;case'builds':renderBuilds();break;case'analyzer':renderAnalyzer();break;case'farming':void renderFarming();break;case'tactics':renderTactics();break;case'settings':renderSettings();break;}}
function openModal(html){$('modal-content').innerHTML=html;$('modal').classList.remove('hidden');}
function closeModal(){$('modal').classList.add('hidden');$('modal-content').innerHTML='';}
$('equipment-priority-build').onchange=()=>{equipmentLabBuildId=$('equipment-priority-build').value;renderEquipmentLab(activeProfile());};
$('equipment-priorities-save').onclick=async()=>{const profileId=activeProfile()?.id;if(!profileId)return toast('Сначала выбери или создай профиль персонажа');const value=$('equipment-priorities').value.slice(0,5000).trim();const profile=data.characterProfiles.find(row=>row.id===profileId);if(equipmentLabBuildId==='profile-default')profile.equipmentPriorityText=value;else profile.equipmentPrioritiesByBuild={...(profile.equipmentPrioritiesByBuild||{}),[equipmentLabBuildId]:value};await saveData();renderEquipmentLab(activeProfile());toast('Приоритеты сохранены для выбранного билда');};
$('equipment-analyze').onclick=async()=>{try{const result=await window.nexus.analyzeEquipment(equipmentLabItems,$('equipment-priorities').value);renderEquipmentAnalysis(result);}catch(error){toast('Не удалось проанализировать экипировку: '+(error.message||error));}};
$('equipment-compare-run').onclick=async()=>{const left=equipmentLabItems[Number($('equipment-compare-left').value)],right=equipmentLabItems[Number($('equipment-compare-right').value)];if(!left||!right)return toast('Выбери два предмета');try{const result=await window.nexus.compareEquipment(left,right,$('equipment-priorities').value);renderEquipmentComparison(result);}catch(error){toast('Не удалось сравнить предметы: '+(error.message||error));}};
$('profile-form').onsubmit=async e=>{e.preventDefault();const now=Date.now(),old=data.characterProfiles.find(x=>x.id===$('profile-id').value);const profile={...(old||{}),id:old?.id||makeUid('char'),name:$('profile-name').value.trim(),playerId:$('profile-player-id').value.trim()||old?.playerId||null,detectedPlayerId:$('profile-player-id').value.trim()||old?.detectedPlayerId||null,hero:$('profile-hero').value.trim(),specialization:$('profile-specialization').value.trim(),level:Math.max(1,Math.min(100,Number($('profile-level').value)||1)),season:$('profile-season').value.trim(),notes:$('profile-notes').value.trim(),createdAt:old?.createdAt||now,updatedAt:now};const detected=live.characterIntel?.identity;if(detected?.name&&String(detected.name).trim().toLocaleLowerCase('ru')===profile.name.trim().toLocaleLowerCase('ru')&&(!profile.playerId||String(profile.playerId)===String(detected.playerId||''))){profile.characterIntelSnapshot={...live.characterIntel,capturedAt:now,source:'UE_game.log · parsed messages (evidence-first)'};profile.playerId=detected.playerId||profile.playerId;profile.detectedPlayerId=profile.playerId;profile.seasonId=detected.seasonId||profile.seasonId;profile.lastSeasonId=detected.seasonId||profile.lastSeasonId;profile.detectedHeroId=detected.heroId||profile.detectedHeroId;profile.detectedLevel=detected.level||profile.detectedLevel;profile.detectedSpecializationId=detected.specializationId||profile.detectedSpecializationId;}const idx=data.characterProfiles.findIndex(x=>x.id===profile.id);if(idx>=0)data.characterProfiles[idx]=profile;else data.characterProfiles.push(profile);data.settings={...data.settings,activeProfileId:profile.id,autoSelectDetectedProfile:$('profile-auto-select').checked};await saveData();fillProfileForm(null);renderCharacters();renderBuilds();toast('Профиль персонажа сохранён');};
$('profile-auto-select').onchange=async()=>{data.settings={...data.settings,autoSelectDetectedProfile:$('profile-auto-select').checked};await saveData();toast(data.settings.autoSelectDetectedProfile?'Автовыбор профиля включён':'Автовыбор профиля выключен');};
$('save-equipment-snapshot').onclick=async()=>{const profile=activeProfile();if(!profile)return toast('Сначала создай и активируй профиль персонажа');const equipment=live.equipment||live.gameLog?.equipment;if(!equipment?.items?.length&&!equipment?.lastTransition)return toast('В игровом логе пока нет подтверждённых событий PutOn');const now=Date.now();const previous=profile.equipmentSnapshot;if(previous)profile.equipmentHistory=[...(profile.equipmentHistory||[]),{...previous}].slice(-20);profile.equipmentSnapshot={items:(equipment.items||[]).map(x=>({...x})),capturedAt:now,lastTransitionAt:Number(equipment.lastTransition?.at)||null,lastTransition:equipment.lastTransition?{...equipment.lastTransition}:null,seasonId:live.seasonId??null,source:equipment.source||'BagMgr · PutOn / PutOff',completeness:'partial',slotMapping:'not-available',limitations:[...(equipment.limitations||[])]};profile.updatedAt=now;await saveData();renderCharacters();toast(`Снимок сохранён · ${equipment.items?.length||0} типов предметов. Слоты и аффиксы не подтверждены логом.`);};
$('profile-cancel').onclick=()=>fillProfileForm(null);
$('rescan-character-log').onclick=async()=>{if(!live.connected)return toast('Сначала подключи UE_game.log');const button=$('rescan-character-log');button.disabled=true;button.textContent='Сканирование…';try{const result=await window.nexus.refreshCharacterIntel();live.characterIntel=result.characterIntel;live.characterScan=result.scan;renderCharacters();toast(`Скан завершён: ${result.scan.messages} сообщений, ${result.characterIntel.stats.length} характеристик, ${result.characterIntel.skills.length} навыков, ${result.characterIntel.talents.length} талантов.`);}catch(error){toast(`Не удалось пересканировать лог: ${error.message||error}`);}finally{button.disabled=!live.connected;button.textContent='Пересканировать лог';}};
$('import-intel-to-build').onclick=()=>{const profile=activeProfile();if(!profile)return toast('Сначала создай/активируй профиль персонажа');fillBuildForm(null);$('build-profile').value=profile.id;$('build-name').value=`${profile.name} · восстановление из UE`;if(profile.hero)$('build-hero').value=[profile.hero,profile.specialization].filter(Boolean).join(' · ');$('build-level').value=profile.detectedLevel||profile.level;$('build-season').value=profile.season||$('build-season').value;const result=appendCharacterIntelToBuild();if(!result.stats&&!result.skills&&!result.talents&&!result.inventory&&!result.equipment)return toast('В профиле пока нет доступных данных Character Intelligence');go('builds');toast(`Черновик подготовлен: характеристики ${result.stats}, навыки ${result.skills}, таланты ${result.talents}, инвентарь ${result.inventory}, наблюдаемые PutOn ${result.equipment}. Снимок сумки не записан в экипировку.`);};
$('profile-from-game').onclick=()=>{const identity=live.characterIntel?.identity;if(!live.player&&!identity?.name)return toast('Персонаж ещё не обнаружен в игровом логе');$('profile-name').value=identity?.name||live.player;$('profile-player-id').value=identity?.playerId||'';$('profile-season').value=identity?.seasonId?seasonLabel(identity.seasonId):live.seasonId?seasonLabel(live.seasonId):$('profile-season').value;if(identity?.level)$('profile-level').value=identity.level;if(identity?.heroName)$('profile-hero').value=identity.heroName;if(identity?.specializationName)$('profile-specialization').value=identity.specializationName;toast('Подставлены только явно обнаруженные имя, сезон, уровень и имена героя/специализации. ID без каталога не преобразуются в названия.');};
$('profile-list').addEventListener('click',async e=>{const activate=e.target.closest('[data-profile-activate]'),edit=e.target.closest('[data-profile-edit]'),del=e.target.closest('[data-profile-delete]');if(activate){data.settings={...data.settings,activeProfileId:activate.dataset.profileActivate};await saveData();renderCharacters();renderBuilds();toast('Активный персонаж изменён');return;}if(edit){const profile=data.characterProfiles.find(x=>x.id===edit.dataset.profileEdit);if(profile)fillProfileForm(profile);return;}if(del){const id=del.dataset.profileDelete;if(!confirm('Удалить профиль? Сохранённые билды останутся, но потеряют привязку к персонажу.'))return;data.characterProfiles=data.characterProfiles.filter(x=>x.id!==id);for(const build of data.builds)if(build.profileId===id)build.profileId=null;if(data.settings?.activeProfileId===id)data.settings={...data.settings,activeProfileId:null};await saveData();renderCharacters();renderBuilds();toast('Профиль удалён; билды сохранены');}});
$('capture-character-snapshot').onclick=async()=>{const profile=activeProfile();if(!profile)return toast('Сначала выбери профиль');try{const result=await window.nexus.captureCharacterSnapshot(profile.id);if(result.profile){const index=data.characterProfiles.findIndex(x=>x.id===profile.id);if(index>=0)data.characterProfiles[index]=result.profile;}await saveData();renderCharacters();toast(result.added?'Снимок персонажа сохранён':'Изменений нет: последний снимок уже содержит эти данные');}catch(error){toast(`Не удалось сохранить снимок: ${error.message||error}`);}};
$('export-character-diagnostics').onclick=async()=>{const profile=activeProfile();if(!profile)return toast('Сначала выбери профиль');try{const result=await window.nexus.exportCharacterDiagnostics(profile.id);if(!result.canceled)toast('Обезличенная диагностика сохранена');}catch(error){toast(`Экспорт не удался: ${error.message||error}`);}};
$('character-history-list').addEventListener('click',async e=>{const button=e.target.closest('[data-snapshot-compare]');if(!button)return;const profile=activeProfile();const index=Number(button.dataset.snapshotCompare);const previous=profile?.characterHistory?.[index-1],current=profile?.characterHistory?.[index];if(!previous||!current)return toast('Не удалось найти два снимка для сравнения');try{const result=await window.nexus.compareCharacterSnapshots(previous,current);const rows=result.rows||[];openModal(`<h3>Изменения персонажа</h3><p class="hint">${date(result.previousAt)} → ${date(result.currentAt)}</p>${rows.length?rows.map(row=>`<div class="compare-line"><span>${esc(row.label||row.value||row.key)}</span><b>${row.kind==='stat'?`${row.before??'—'} → ${row.after??'—'} ${row.delta===null?'':`(${row.delta>0?'+':''}${row.delta})`}`:esc(row.change||'Изменение')}</b></div>`).join(''):'<div class="empty">Между снимками изменений в распознанных данных нет.</div>'}`);}catch(error){toast(error.message||String(error));}});
$('modal-close').onclick=closeModal;$('modal').onclick=e=>{if(e.target.id==='modal')closeModal();};
$('emergency-clickthrough-off').onclick=async()=>{try{const updated=await window.nexus.setClickThrough(false);data.settings={...data.settings,...updated};renderConnection();if(activePage==='settings')renderSettings();toast('Сквозной клик выключен. HUD снова принимает мышь.');}catch(error){toast(`Не удалось выключить сквозной клик: ${error.message||error}`);}};$('show-hud').onclick=()=>window.nexus.showOverlay();$('choose-log').onclick=async()=>{try{const r=await window.nexus.chooseLog();if(!r.canceled)toast('Подключён выбранный лог');}catch(e){toast(e.message||String(e));}};$('auto-log').onclick=async()=>{await window.nexus.useAutoLog();toast('Автоматический поиск включён');};
$('backup-export').onclick=async()=>{const r=await window.nexus.exportBackup();if(!r.canceled)toast('Резервная копия сохранена');};$('settings-export').onclick=$('backup-export').onclick;$('settings-import').onclick=async()=>{try{const r=await window.nexus.importBackup();if(!r.canceled){data=r.data;renderPage();toast(`Резервная копия импортирована · точек истории цен: ${number(r.importedPricePoints||0,0)}`);}}catch(e){toast(`Ошибка импорта: ${e.message||e}`);}};
async function refreshGameResourceStatus(){
  try{
    const result=await window.nexus.getGameResourceStatus();
    const badge=$('game-resource-badge');
    const status=$('game-resource-status');
    const details=$('game-resource-details');
    if(!result?.imported){
      badge.textContent='Не импортировано';
      status.textContent='Локальная база игровых ресурсов ещё не создана.';
      return;
    }
    const s=result.summary||{};
    badge.textContent='Импортировано';
    status.textContent='Источник: '+(result.rootLabel||'папка экспорта')+' · ProjectVersion: '+(result.projectVersion||'не определена');
    details.innerHTML=[
      'JSON-файлов проверено: '+number(s.jsonFilesScanned||0,0),
      'DataTable: '+number(s.dataTables||0,0),
      'Строк таблиц: '+number(s.dataTableRows||0,0),
      'Аффиксов: '+number(s.affixDefinitions||0,0),
      'Предметов: '+number(s.itemDefinitions||0,0),
      'Локализаций: '+number(s.localizationEntries||0,0),
      'Таблиц enum/атрибутов: '+number(s.attributeDefinitions||0,0),
      'Ресурсных подсказок: '+number(s.usefulAssets||0,0),
      'Скриптовых подсказок: '+number(s.scriptHints||0,0)
    ].join(' · ');
    if(result.knownGameTypes?.length){
      details.innerHTML+=' <br>Типы из CoreRedirects: '+result.knownGameTypes.map(esc).join(', ');
    }
  }catch(error){
    $('game-resource-status').textContent='Не удалось прочитать статус базы: '+(error.message||error);
  }
}
$('game-resource-import').onclick=async()=>{
  const button=$('game-resource-import');
  button.disabled=true;
  button.textContent='Сканирование…';
  try{
    const result=await window.nexus.importGameResources();
    if(result.canceled)return;
    await refreshGameResourceStatus();
    const s=result.status?.summary||{};
    if((s.affixDefinitions||0)===0&&(s.itemDefinitions||0)===0){
      toast('Экспорт прочитан, но таблицы предметов/аффиксов не найдены. UI-ресурсы не считаются базой характеристик.');
    }else{
      toast('Игровая база обновлена · аффиксов: '+number(s.affixDefinitions||0,0)+' · предметов: '+number(s.itemDefinitions||0,0));
    }
  }catch(error){
    toast('Ошибка импорта игровых ресурсов: '+(error.message||error));
  }finally{
    button.disabled=false;
    button.textContent='Импортировать игровые ресурсы';
  }
};

function renderTlidbAutoControls(result={}){
  const settings=data.settings||{};
  const enabled=typeof result.autoSyncEnabled==='boolean'?result.autoSyncEnabled:settings.tlidbAutoSyncEnabled!==false;
  const interval=Number(result.syncIntervalHours||settings.tlidbSyncIntervalHours)||24;
  $('tlidb-auto-sync').checked=enabled;
  $('tlidb-sync-interval').value=String(interval);
  $('tlidb-sync-interval').disabled=!enabled;
  let message=enabled?`Автообновление включено · раз в ${interval} ч. При устаревшем кэше обновление начнётся после запуска приложения.`:'Автообновление выключено · база будет обновляться только вручную.';
  if(result.lastFullSyncAt)message+=' Последняя полная синхронизация: '+date(result.lastFullSyncAt)+'.';
  if(result.lastError)message+=' Последняя ошибка: '+String(result.lastError).slice(0,240);
  $('tlidb-auto-status').textContent=message;
}
async function refreshTlidbStatus(){
  try{
    const result=await window.nexus.getTlidbCatalogStatus();
    renderTlidbAutoControls(result);
    const badge=$('tlidb-badge');
    const status=$('tlidb-status');
    const details=$('tlidb-details');
    if(!result?.imported){
      badge.textContent='Не загружена';
      status.textContent='Локальный кэш TLIDB ещё не создан.';
      details.textContent='Nexus загрузит базовые аффиксы, коррозию и крафтовые таблицы по 38 страницам экипировки при запуске или по кнопке.';
      return;
    }
    const summary=result.summary||{};
    badge.textContent=(summary.pagesFailed||0)>0?'Загружена частично':'Загружена';
    status.textContent='Источник: TLIDB · обновлено '+date(result.syncedAt)+' · версия сезона/патча не подтверждена';
    details.textContent='Страниц обновлено: '+number(summary.pagesImported||0,0)+' / '+number(summary.pagesRequested||0,0)+' · строк аффиксов: '+number(summary.affixRows||0,0)+' · ошибок: '+number(summary.pagesFailed||0,0)+' · старых страниц сохранено: '+number(summary.retainedPages||0,0);
    if(result.failedPages?.length){
      details.textContent+=' · Ошибки: '+result.failedPages.slice(0,3).map(x=>x.slug+': '+x.reason).join('; ');
    }
  }catch(error){
    renderTlidbAutoControls({lastError:error.message||String(error)});
    $('tlidb-status').textContent='Не удалось прочитать кэш TLIDB: '+(error.message||error);
  }
}
async function searchTlidbCatalog(){
  const query=$('tlidb-search').value.trim();
  if(!query){
    $('tlidb-search-count').textContent='Введи название характеристики на английском, например Max Life или Fire Resistance.';
    $('tlidb-results').innerHTML='';
    return;
  }
  try{
    const result=await window.nexus.searchTlidbAffixes(query,{gearGroup:$('tlidb-gear-filter').value,limit:40});
    $('tlidb-search-count').textContent='Найдено: '+number(result.total||0,0)+' · показано: '+number(result.results?.length||0,0);
    $('tlidb-results').innerHTML=(result.results||[]).map(row=>{
      const group=row.prefixSuffix==='prefix'?'префикс':row.prefixSuffix==='suffix'?'суффикс':'тип не указан';
      const kind=row.sourceKind==='base-affix'?'Базовый':row.sourceKind==='corrosion-base'?'Коррозия':row.sourceKind==='craft-affix'?'Крафт':'Аффикс';
      const ranges=(row.rollRanges||[]).map(x=>number(x.min,2)+'–'+number(x.max,2)).join(', ');
      return '<div class="tlidb-result"><div class="tlidb-result-main"><b>'+esc(row.modifierRaw)+'</b><small>'+esc(row.sourcePageLabel)+' · '+kind+' · '+group+' · тир '+esc(row.tierRaw||'—')+'</small></div><div class="tlidb-result-meta"><span>Ур. '+esc(row.levelRaw||'—')+'</span><span>Вес '+esc(row.weightRaw||'—')+'</span><span>'+esc(row.library||row.sourceKind||'—')+'</span>'+(ranges?'<span>Диапазон '+esc(ranges)+'</span>':'')+'</div><button class="btn secondary" data-tlidb-url="'+esc(row.sourceUrl)+'">Источник</button></div>';
    }).join('')||'<div class="empty">Совпадений нет. Попробуй другое английское название или сними фильтр типа экипировки.</div>';
  }catch(error){
    $('tlidb-search-count').textContent='Ошибка поиска: '+(error.message||error);
    $('tlidb-results').innerHTML='';
  }
}
$('tlidb-sync').onclick=async()=>{
  const button=$('tlidb-sync');
  button.disabled=true;
  button.textContent='Загрузка страниц…';
  try{
    const result=await window.nexus.syncTlidbCatalog();
    await refreshTlidbStatus();
    const summary=result.status?.summary||{};
    const retained=Number(summary.retainedPages)||0;
    toast('TLIDB обновлена · записей: '+number(summary.affixRows||0,0)+' · страниц: '+number(summary.pagesImported||0,0)+(retained?' · старые данные сохранены для '+retained+' страниц':''));
    await searchTlidbCatalog();
  }catch(error){
    toast('Ошибка загрузки TLIDB: '+(error.message||error));
  }finally{
    button.disabled=false;
    button.textContent='Загрузить / обновить сейчас (38 страниц)';
  }
};
$('tlidb-auto-sync').onchange=()=>{$('tlidb-sync-interval').disabled=!$('tlidb-auto-sync').checked;};
$('tlidb-search-button').onclick=()=>void searchTlidbCatalog();
$('tlidb-search').addEventListener('keydown',e=>{if(e.key==='Enter')void searchTlidbCatalog();});
$('tlidb-results').addEventListener('click',e=>{
  const button=e.target.closest('[data-tlidb-url]');
  if(!button)return;
  const url=button.dataset.tlidbUrl||'';
  if(/^https:\/\/tlidb\.com\/en\/[A-Za-z0-9_-]+$/.test(url)){
    void window.nexus.openExternal(url).catch(error=>toast(error.message||String(error)));
  }
});
refreshTlidbStatus();
window.nexus.onTlidbUpdate((payload)=>{
  void refreshTlidbStatus();
  if(payload?.automatic&&payload?.error){
    toast('Автообновление TLIDB не удалось: '+payload.error);
    return;
  }
  if(payload?.automatic&&payload?.status?.imported){
    const summary=payload.status.summary||{};
    toast('TLIDB автоматически обновлена · '+number(summary.affixRows||0,0)+' записей · страниц: '+number(summary.pagesImported||0,0));
    if($('tlidb-search').value.trim())void searchTlidbCatalog();
  }
});
refreshGameResourceStatus();

$('settings-choose-log').onclick=$('choose-log').onclick;$('settings-auto-log').onclick=$('auto-log').onclick;$('open-data-folder').onclick=async()=>{try{await window.nexus.openDataFolder();toast('Открыта папка данных Nexus');}catch(e){toast(e.message||String(e));}};
$('set-opacity').oninput=()=>$('opacity-label').textContent=`${$('set-opacity').value}%`;$('set-scale').oninput=()=>$('scale-label').textContent=`${$('set-scale').value}%`;$('set-volume').oninput=()=>$('volume-label').textContent=`${$('set-volume').value}%`;
$('apply-settings').onclick=async()=>{const settings={overlayMode:$('set-mode').value,overlayOpacity:Number($('set-opacity').value),overlayScale:Number($('set-scale').value),alwaysOnTop:$('set-top').checked,clickThrough:$('set-clickthrough').checked,hotkeysEnabled:$('set-hotkeys').checked,autoCreateDetectedProfiles:$('set-auto-create-profiles').checked,notificationsEnabled:$('set-notifications').checked,notificationThresholdFe:Number($('set-threshold').value)||0,soundEnabled:$('set-sound').checked,soundVolume:Number($('set-volume').value),tlidbAutoSyncEnabled:$('tlidb-auto-sync').checked,tlidbSyncIntervalHours:Number($('tlidb-sync-interval').value)||24};data.settings={...data.settings,...settings};await window.nexus.updateSettings(settings);await saveData();await refreshTlidbStatus();toast('Настройки применены');};
$('test-sound').onclick=()=>{try{const C=window.AudioContext||window.webkitAudioContext,ctx=new C();ctx.resume();[660,880,1175].forEach((f,i)=>{const o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=f;o.connect(g);g.connect(ctx.destination);g.gain.setValueAtTime(.0001,ctx.currentTime+i*.13);g.gain.exponentialRampToValueAtTime(.055,ctx.currentTime+i*.13+.02);g.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+i*.13+.18);o.start(ctx.currentTime+i*.13);o.stop(ctx.currentTime+i*.13+.2);});toast('Проверочный сигнал воспроизведён');}catch{toast('Браузер не разрешил воспроизвести звук');}};
$('item-search').addEventListener('input',()=>{clearTimeout(itemQueryTimer);const q=$('item-search').value;itemQueryTimer=setTimeout(()=>searchCatalog(q),180);});
$('item-results').addEventListener('click',async e=>{const b=e.target.closest('[data-watch-id]');if(!b)return;const id=Number(b.dataset.watchId);if(data.priceWatch.some(x=>Number(x.itemId)===id))return toast('Предмет уже отслеживается');data.priceWatch.push({itemId:id,name:b.dataset.watchName,targetFe:0,createdAt:Date.now()});await saveData();toast('Предмет добавлен в отслеживание');});
$('add-watch').onclick=()=>openModal(`<h3>Добавить предмет в отслеживание</h3><label>Название или ID<input id="watch-search" placeholder="Резонанс Преисподней"></label><div id="watch-search-results" class="modal-search-results"></div><label>Целевая цена, FE<input id="watch-target" type="number" min="0" step="0.01" value="0"></label><button class="btn primary" id="watch-confirm" disabled>Добавить выбранный предмет</button>`);
$('modal-content').addEventListener('input',async e=>{if(e.target.id!=='watch-search')return;const list=await window.nexus.searchItems(e.target.value);$('watch-search-results').innerHTML=list.slice(0,8).map(x=>`<button class="watch-choice" data-choice-id="${x.id}" data-choice-name="${esc(x.name)}">${esc(x.name)} <small>#${x.id}</small></button>`).join('');});
$('modal-content').addEventListener('click',e=>{const dayButton=e.target.closest('[data-price-days]');const seasonButton=e.target.closest('[data-price-season-toggle]');if(dayButton||seasonButton){const el=dayButton||seasonButton;void showPriceHistory(Number(el.dataset.priceId),el.dataset.priceName||'Предмет',Number(el.dataset.priceDays)||30,seasonButton?'all':(el.dataset.priceSeason||'current'));return;}const c=e.target.closest('[data-choice-id]');if(c){document.querySelectorAll('.watch-choice').forEach(x=>x.classList.remove('selected'));c.classList.add('selected');$('watch-confirm').disabled=false;$('watch-confirm').dataset.id=c.dataset.choiceId;$('watch-confirm').dataset.name=c.dataset.choiceName;}if(e.target.id==='watch-confirm'){const id=Number(e.target.dataset.id);if(!id)return;data.priceWatch.push({itemId:id,name:e.target.dataset.name,targetFe:Number($('watch-target').value)||0,createdAt:Date.now()});void saveData().then(()=>{closeModal();renderEconomy();toast('Предмет добавлен');});}});
$('watch-table').addEventListener('click',async e=>{const history=e.target.closest('[data-price-history]');if(history){try{await showPriceHistory(Number(history.dataset.priceHistory),history.dataset.priceName||'Предмет',30,'current');}catch(error){toast(error.message||String(error));}return;}const b=e.target.closest('[data-watch-remove]');if(!b)return;data.priceWatch.splice(Number(b.dataset.watchRemove),1);await saveData();renderEconomy();});
$('watch-table').addEventListener('change',async e=>{const input=e.target.closest('[data-watch-target]');if(!input)return;const row=data.priceWatch[Number(input.dataset.watchTarget)];if(!row)return;row.targetFe=Math.max(0,Number(input.value)||0);await saveData();renderEconomy();toast(row.targetFe>0?'Ценовая цель сохранена':'Ценовое уведомление отключено');});
['deal-buy','deal-sell','deal-fee','deal-qty'].forEach(id=>$(id).addEventListener('input',calcDeal));
$('new-build').onclick=()=>{fillBuildForm(null);go('builds');};$('clear-build').onclick=()=>fillBuildForm(null);
function appendObservedEquipmentToBuild(){const profile=data.characterProfiles.find(x=>x.id===$('build-profile').value)||activeProfile();const equipment=(live.equipment?.items?.length?live.equipment:profile?.equipmentSnapshot)?.items||[];if(!equipment.length){toast('Нет подтверждённых предметов в текущем логе или сохранённом снимке');return 0;}const current=lines($('build-gear').value);const existingIds=new Set(current.map(x=>/ID\s+(\d+)/i.exec(x)?.[1]).filter(Boolean));let added=0;for(const item of equipment){const id=Number(item.itemId);if(!Number.isSafeInteger(id)||id<=0||existingIds.has(String(id)))continue;current.push(`Наблюдение без слота · ID ${id} · ${item.name||`Предмет #${id}`} ×${Number(item.count)||1}`);existingIds.add(String(id));added++;} $('build-gear').value=current.join('\n');return added;}
$('build-import-equipment').onclick=()=>{const count=appendObservedEquipmentToBuild();toast(count?`Добавлено наблюдаемых предметов: ${count}. Слоты не назначались.`:'Новых предметов для добавления нет');};
$('build-import-character-intel').onclick=()=>{const profile=data.characterProfiles.find(x=>x.id===$('build-profile').value)||activeProfile();const result=appendCharacterIntelToBuild();toast(result.stats||result.skills||result.talents||result.inventory||result.equipment?`Импортировано: показатели ${result.stats}, навыки ${result.skills}, таланты ${result.talents}, снимок сумки ${result.inventory}, PutOn ${result.equipment}.`: 'Нет данных Character Intelligence для выбранного профиля.');};
$('build-from-equipment').onclick=()=>{const profile=activeProfile();if(!profile)return toast('Выбери профиль персонажа');fillBuildForm(null);$('build-profile').value=profile.id;$('build-name').value=`${profile.name} · экипировка ${new Date().toLocaleDateString('ru-RU')}`;$('build-hero').value=[profile.hero,profile.specialization].filter(Boolean).join(' · ');$('build-level').value=profile.level;$('build-season').value=profile.season||$('build-season').value;const count=appendObservedEquipmentToBuild();if(count){go('builds');toast(`Создан черновик с ${count} наблюдаемыми предметами. Заполни реальные слоты вручную.`);}else toast('Нет новых предметов для импорта');};$('build-profile').onchange=()=>{const profile=data.characterProfiles.find(x=>x.id===$('build-profile').value);if(!profile)return;if(!$('build-hero').value.trim())$('build-hero').value=[profile.hero,profile.specialization].filter(Boolean).join(' · ');if(!$('build-level').value||Number($('build-level').value)===100)$('build-level').value=profile.level;if(!$('build-season').value||$('build-season').value==='SS14 · Tartarus')$('build-season').value=profile.season||$('build-season').value;};
$('build-form').onsubmit=async e=>{e.preventDefault();const build=buildFromForm();const old=data.builds.findIndex(x=>x.id===build.id);if(old>=0)data.builds[old]=build;else data.builds.push(build);await saveData();selectedBuildId=build.id;renderBuilds();renderCharacters();toast('Билд сохранён');};
$('build-list').addEventListener('click',async e=>{const edit=e.target.closest('[data-build-edit]'),del=e.target.closest('[data-build-delete]'),an=e.target.closest('[data-build-analyze]');if(edit){const b=data.builds.find(x=>x.id===edit.dataset.buildEdit);fillBuildForm(b);return;}if(del){data.builds=data.builds.filter(x=>x.id!==del.dataset.buildDelete);await saveData();renderBuilds();toast('Билд удалён');return;}if(an){selectedBuildId=an.dataset.buildAnalyze;go('analyzer');$('analyzer-build').value=selectedBuildId;await renderAnalyzer();$('analyzer-build').value=selectedBuildId;}});
$('export-build-code').onclick=async()=>{try{const build=buildFromForm();if(!build.name.trim())return toast('Сначала введи название билда');const code=await window.nexus.encodeBuild(build);$('build-code').value=code;try{await window.nexus.copyText(code);toast('Код билда скопирован');}catch{toast('Код выведен в поле импорта/экспорта');}}catch(e){toast(e.message||String(e));}};
$('import-build-code').onclick=async()=>{try{const build=await window.nexus.decodeBuild($('build-code').value);data.builds.push(build);await saveData();fillBuildForm(build);renderBuilds();toast('Билд импортирован');}catch(e){toast(`Не удалось импортировать: ${e.message||e}`);}};
$('compare-builds').onclick=async()=>{const a=data.builds.find(x=>x.id===$('compare-a').value),b=data.builds.find(x=>x.id===$('compare-b').value);if(!a||!b)return toast('Нужно выбрать два билда');const rows=await window.nexus.compareBuilds(a,b);$('compare-result').innerHTML=rows.map(x=>`<div class="compare-line ${x.changed?'changed':''}"><span>${esc(x.label)}</span><b>${esc(String(x.left??'—'))} → ${esc(String(x.right??'—'))} <i class="${x.delta===null?'':x.delta>=0?'positive':'negative'}">${x.delta===null?'':`(${x.delta>0?'+':''}${x.delta})`}</i></b></div>`).join('')+'<p class="hint">Сравнение показывает изменения введённых характеристик, слотов экипировки, навыков, талантов и указанной стоимости. Оно не предсказывает реальный DPS.</p>';};
$('analyzer-build').onchange=()=>{selectedBuildId=$('analyzer-build').value;void renderAnalyzer();};$('import-observed-stats').onclick=importObservedStatsToAnalyzer;$('run-analysis').onclick=runAnalyzer;$('save-analyzer-stats').onclick=async()=>{if(!captureAnalyzer())return toast('Нет выбранного билда');await saveData();toast('Характеристики сохранены');};
$('save-current-farm').onclick=()=>{go('farming');saveCurrentFarm(0,'Текущая сессия');};$('farm-profile-filter').onchange=()=>void renderFarming();$('save-farm-page').onclick=()=>saveCurrentFarm(Number($('farm-costs').value)||0,$('farm-strategy').value||'Текущая сессия');$('save-farm-costs').onclick=()=>saveCurrentFarm(Number($('farm-costs').value)||0,$('farm-strategy').value||'Текущая сессия');
async function saveCurrentFarm(costs,strategy){if(!live.startedAt)return toast('Активная игровая сессия ещё не обнаружена');const key=`game-run:${Number(live.startedAt)}`;let row=data.farmingSessions.find(x=>x.sessionKey===key);if(!row){row={id:key,sessionKey:key,source:'manual-snapshot',startedAt:live.startedAt,player:live.player||'',profileId:profileForLive()?.id||activeProfile()?.id||null,area:live.area||'',strategy,mapRuns:live.mapRuns||[],mapsCompleted:live.mapsCompleted||0,lastMap:live.lastMap||null};data.farmingSessions.push(row);}row.profileId=profileForLive()?.id||row.profileId||activeProfile()?.id||null;row.mapRuns=live.mapRuns||row.mapRuns||[];row.mapsCompleted=Number(live.mapsCompleted)||row.mapsCompleted||0;row.lastMap=live.lastMap||row.lastMap||null;row.costsFe=costs;row.strategy=strategy||row.strategy;row.lootValueFe=Number(live.sessionValueFe)||0;row.feGained=Number(live.feGained)||0;row.itemCount=Number(live.drops)||0;row.pickupEvents=Number(live.pickupEvents)||0;row.durationSec=Math.max(1,Math.floor(((Number(live.gameEndedAt)||Date.now())-live.startedAt)/1000));await saveData();renderFarming();toast('Сессия сохранена в историю');}
$('tactic-form').onsubmit=async e=>{e.preventDefault();const now=Date.now();const row={id:selectedTacticId||makeUid('tactic'),category:$('tactic-category').value,title:$('tactic-title').value.trim(),context:$('tactic-context').value.trim(),body:$('tactic-body').value.trim(),createdAt:data.tactics.find(x=>x.id===selectedTacticId)?.createdAt||now,updatedAt:now};if(!row.title||!row.body)return toast('Заполни название и описание');const index=data.tactics.findIndex(x=>x.id===row.id);if(index>=0)data.tactics[index]=row;else data.tactics.push(row);selectedTacticId=null;await saveData();$('tactic-title').value='';$('tactic-context').value='';$('tactic-body').value='';$('tactic-submit').textContent='Сохранить заметку';$('tactic-cancel-edit').hidden=true;renderTactics();toast('Заметка сохранена');};
$('tactic-search').oninput=renderTactics;$('tactic-cancel-edit').onclick=()=>{selectedTacticId=null;$('tactic-form').reset();$('tactic-submit').textContent='Сохранить заметку';$('tactic-cancel-edit').hidden=true;};$('tactic-list').addEventListener('click',async e=>{const del=e.target.closest('[data-tactic-delete]'),edit=e.target.closest('[data-tactic-edit]');if(del){data.tactics=data.tactics.filter(x=>x.id!==del.dataset.tacticDelete);if(selectedTacticId===del.dataset.tacticDelete)$('tactic-cancel-edit').click();await saveData();renderTactics();return;}if(edit){const row=data.tactics.find(x=>x.id===edit.dataset.tacticEdit);if(!row)return;selectedTacticId=row.id;$('tactic-category').value=row.category;$('tactic-title').value=row.title;$('tactic-context').value=row.context;$('tactic-body').value=row.body;$('tactic-submit').textContent='Сохранить изменения';$('tactic-cancel-edit').hidden=false;toast('Редактирование заметки');}});

window.nexus.onState((s)=>{live=s||{};const changed=syncDetectedProfile(live);renderConnection();if(changed||['overview','loot','economy','characters','farming'].includes(activePage))renderPage();});
window.nexus.onSettings((settings)=>{data.settings={...data.settings,...settings};renderConnection();if(activePage==='settings')renderSettings();});
window.nexus.loadData().then(d=>{data=d||data;data.characterProfiles=data.characterProfiles||[];syncDetectedProfile(live);renderPage();});window.nexus.getState().then(s=>{live=s||{};syncDetectedProfile(live);renderPage();});
setInterval(()=>{if(activePage==='overview'&&live.startedAt){$('ov-duration').textContent=duration((Date.now()-live.startedAt)/1000);const h=Math.max(1,(Date.now()-live.startedAt)/3600000);$('ov-hour').textContent=number((live.sessionValueFe||0)/h,1);}},1000);
