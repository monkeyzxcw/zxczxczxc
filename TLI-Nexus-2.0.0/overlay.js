const $ = (id) => document.getElementById(id);
let state = {}, settings = { overlayMode:'compact', notificationsEnabled:true, soundEnabled:true, soundVolume:45, clickThrough:false };
const iconCache = new Map();
let audioCtx = null, audioUnlocked = false, toastTimer = null, lastToastId = null;
function fmt(n,d=1){return Number(n||0).toLocaleString('ru-RU',{maximumFractionDigits:d});}
function duration(ms){const s=Math.max(0,Math.floor(ms/1000));return [Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(x=>String(x).padStart(2,'0')).join(':');}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function getIcon(id){if(iconCache.has(id))return iconCache.get(id);const value=await window.nexus.getItemIcon(id);iconCache.set(id,value||'');return value||'';}
async function hydrateIcons(root){for(const img of root.querySelectorAll('img[data-item-id]')){const id=Number(img.dataset.itemId);if(!id)continue;const value=await getIcon(id);if(value&&img.isConnected)img.src=value;}}
function renderLootRows(rows, root, emptyText){
  const html=(rows||[]).slice(0,14).map(x=>{
    const val=x.valueFe===null?'—':`${fmt(x.valueFe,2)} FE`;
    const unit=x.unitPrice===null?'Цена неизвестна':`${fmt(x.unitPrice,3)} FE/шт.`;
    const src=x.priceSource==='community'?'БАЗА':x.priceSource==='exchange'?'БИРЖА':x.priceSource==='fixed'?'FE':x.priceSource==='bound'?'ПРИВЯЗАН':'—';
    return `<div class="loot-row"><img data-item-id="${Number(x.id)}" alt=""><div class="loot-main"><span class="loot-name ${Number(x.id)===100300?'fe-item':''}">${esc(x.name)}</span><small>${esc(unit)} · ${src}</small></div><div class="loot-sum"><b>×${fmt(x.count,0)}</b><small>${val}</small></div></div>`;
  }).join('');
  root.className=html?'loot-list':'empty';
  root.innerHTML=html||emptyText;
  if(html)void hydrateIcons(root);
}
function render(s){
  state=s||{};
  const ready=s.logReadiness||{},connected=!!s.connected,live=ready.code==='live';
  const runEnd=Number(s.gameEndedAt)||Date.now();
  const runDuration=s.startedAt?Math.max(0,runEnd-s.startedAt):0;
  const elapsedHours=s.startedAt?Math.max(1,runDuration/3600000):0;
  const map=s.currentMap||s.lastMap||null;
  const mapActive=!!s.currentMap;
  const mapDuration=map?(map.endedAt?Number(map.durationSec||0)*1000:Math.max(0,Date.now()-Number(map.startedAt||Date.now()))):0;

  $('dot').classList.toggle('on',live);$('dot').classList.toggle('warn',connected&&!live);
  $('status').textContent=live?'Игровые сообщения поступают':ready.code==='enable-logging'?'Включи игровое логирование':connected?'Файл найден · ожидание событий':'Ожидание игры';
  $('clock').textContent=live?'LIVE':connected?'SETUP':'SCANNING';
  $('duration').textContent=duration(runDuration);
  $('area-compact').textContent=s.area||s.pendingArea||'Ожидание карты';
  $('session-value').textContent=`${fmt(s.sessionValueFe,2)} FE`;
  $('hour-value').textContent=elapsedHours?`${fmt((s.sessionValueFe||0)/elapsedHours,1)} FE/ч`:'— FE/ч';
  $('last-map-label').textContent=mapActive?'ТЕКУЩАЯ КАРТА':'ПОСЛЕДНЯЯ КАРТА';
  $('last-map-value').textContent=map?`${fmt(map.lootValueFe,2)} FE`:'— FE';
  $('last-map-caption').textContent=map?`${mapActive?'В ПРОЦЕССЕ':'ЗАВЕРШЕНА'} · ${fmt(map.drops,0)} шт.`:'Карта ещё не обнаружена';
  $('player').textContent=s.player||'Не определён';
  $('player-origin').textContent=s.playerSource==='history'?'Восстановлен из истории':'Текущий запуск игры';
  $('area').textContent=s.area||s.pendingArea||'—';
  $('drops').textContent=fmt(s.drops,0);
  $('pickup-events').textContent=fmt(s.pickupEvents,0);
  $('maps-completed').textContent=fmt(s.mapsCompleted,0);
  $('price-coverage').textContent=`${s.pricedTypes||0}/${(s.pricedTypes||0)+(s.unpricedTypes||0)}`;
  $('season').textContent=s.seasonId?`SS${String(s.seasonId).slice(-2)}`:'—';

  $('map-run-label').textContent=mapActive?'ТЕКУЩАЯ КАРТА':'ПОСЛЕДНЯЯ КАРТА';
  $('map-run-name').textContent=map?.name||'Карта ещё не обнаружена';
  $('map-run-value').textContent=map?`${fmt(map.lootValueFe,2)} FE`:'— FE';
  $('map-run-drops').textContent=fmt(map?.drops,0);
  $('map-run-pickups').textContent=fmt(map?.pickupEvents,0);
  $('map-run-duration').textContent=duration(mapDuration);
  $('map-loot-title').textContent=mapActive?'Дроп текущей карты':'Дроп за последнюю карту';
  $('map-loot-status').textContent=map?(mapActive?'LIVE':map.completionReason==='hub'?'ГОРОД':'ЗАВЕРШЕНА'):'—';
  renderLootRows(s.lootSummary,$('items'),'За этот запуск игры пока нет найденных предметов.');
  renderLootRows(map?.lootSummary,$('map-items'),'Для текущей / последней карты пока нет данных о дропе.');

  const readiness=s.logReadiness||{};
  $('setup-hint').hidden=readiness.code!=='enable-logging';
  $('setup-title').textContent='Файл найден, но события игры не поступают';
  $('setup-text').textContent=readiness.hint||'';
  $('logstate').textContent=readiness.label||'LOG OFFLINE';
  $('file').textContent=s.logFile||s.error||'Ожидание UE_game.log';
  $('file').title=s.logFile||s.error||'';
  $('source').textContent=s.logSource==='manual'?'MANUAL':'AUTO';

  const actionSummary=Object.entries(s.byAction||{}).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([k,v])=>`${k} ×${v}`).join(' · ');
  $('last-action').textContent=actionSummary||`GameLog: ${s.gameLog?.gameLines||0} строк`;
  $('unknown').textContent=`Не распознано: ${s.unrecognized||0}`;
  const t=s.tailer||{},raw=(s.rawLines||[]).slice(0,8).join('\n'),message=s.lastMessage||s.lastHistoryMessage;
  $('debug-summary').textContent=`Диагностика · ${t.linesRead||0} строк · ${fmt(t.bytesRead,0)} байт`;
  $('debug-content').innerHTML=`<div class="diag-line"><b>Файл:</b> ${esc(s.logFile||'не выбран')}</div><div class="diag-line"><b>Tail:</b> ${fmt(t.offset,0)} / ${fmt(t.size,0)} байт · хвост ${t.pendingBytes||0}</div><div class="diag-line"><b>GameLog:</b> ${s.gameLog?.gameLines||0} · InitBagData ${s.gameLog?.bagInit||0} · Add ${s.gameLog?.bagAdd||0} · Modify ${s.gameLog?.bagModify||0} · loot Δ ${s.gameLog?.lootDeltas||0}</div><div class="diag-line"><b>Socket:</b> STT ${s.socketStartLines||0} · End ${s.socketEndLines||0} · history ${s.historyMessages||0}</div><div class="diag-line"><b>Цены:</b> биржа ${s.pricing?.ownCount||0} · база ${s.pricing?.communityCount||0} · сезон ${s.seasonId||'—'}</div><div class="diag-line"><b>Карт за запуск:</b> ${s.mapsCompleted||0}</div><div class="diag-line"><b>Последнее сообщение:</b> ${esc(message?`${message.kind}/${message.action}`:'нет')}</div><pre>${esc(message?.preview||raw||'Нет свежих строк')}</pre>`;
  if(s.lastNotification&&s.lastNotification.id!==lastToastId)showToast(s.lastNotification);
}
function unlockAudio(){try{audioCtx??=new (window.AudioContext||window.webkitAudioContext)();audioCtx.resume();audioUnlocked=true;}catch{audioUnlocked=false;}}
function playTone(freq,start,duration,volume,type='sine'){
  if(!audioCtx||!audioUnlocked)return;const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();osc.type=type;osc.frequency.setValueAtTime(freq,audioCtx.currentTime+start);gain.gain.setValueAtTime(.0001,audioCtx.currentTime+start);gain.gain.exponentialRampToValueAtTime(Math.max(.0002,volume),audioCtx.currentTime+start+.025);gain.gain.exponentialRampToValueAtTime(.0001,audioCtx.currentTime+start+duration);osc.connect(gain);gain.connect(audioCtx.destination);osc.start(audioCtx.currentTime+start);osc.stop(audioCtx.currentTime+start+duration+.03);
}
function playAlert(value,type='valuable-drop'){if(!settings.soundEnabled)return;unlockAudio();const v=Math.max(0,Math.min(1,Number(settings.soundVolume??45)/100))*.13;if(type==='price-target'){playTone(520,0,.12,v,'triangle');playTone(780,.15,.22,v,'sine');return;}if(value>=100){playTone(660,0,.25,v,'sine');playTone(880,.13,.28,v,'sine');playTone(1175,.28,.36,v,'triangle');}else if(value>=50){playTone(660,0,.18,v,'sine');playTone(880,.14,.24,v,'triangle');}else{playTone(740,0,.17,v,'sine');playTone(988,.12,.18,v*.7,'sine');}}
async function showToast(n){lastToastId=n.id;$('toast-name').textContent=n.name||'Предмет';$('toast-qty').textContent=n.type==='price-target'?`Цель: ${fmt(n.targetFe,2)} FE`:`×${n.quantity||1}`;$('toast-value').textContent=n.type==='price-target'?`≤${fmt(n.valueFe,2)} FE`:`+${fmt(n.valueFe,2)} FE`;$('toast-tier').textContent=n.type==='price-target'?'ЦЕНА ДОСТИГЛА ТВОЕЙ ЦЕЛИ':n.valueFe>=100?'ЛЕГЕНДАРНАЯ НАХОДКА':n.valueFe>=50?'РЕДКАЯ НАХОДКА':'ЦЕННАЯ НАХОДКА';
  const icon=await getIcon(n.itemId);$('toast-icon').innerHTML=icon?`<img src="${icon}" alt="">`:'✦';const el=$('toast');el.classList.remove('hide');el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>{el.classList.remove('show');el.classList.add('hide');},n.type==='price-target'?3600:2800);playAlert(n.valueFe||0,n.type);
}
function applySettings(s){
  settings={...settings,...(s||{})};
  // Native WebContents zoom and BrowserWindow geometry are adjusted together by the main process.
  $('shell').dataset.mode=settings.overlayMode==='expanded'?'expanded':'compact';
  $('mode').textContent=settings.overlayMode==='expanded'?'⌃':'⌄';
  $('sound').classList.toggle('active',settings.soundEnabled!==false);
  $('clickthrough').classList.toggle('active',settings.clickThrough===true);
  $('clickthrough').setAttribute('aria-pressed',String(settings.clickThrough===true));
  $('clickthrough').title=settings.clickThrough
    ? 'Сквозной клик включён: Ctrl+Shift+M переключает режим; Ctrl+Alt+M аварийно выключает; также доступно меню Nexus в системном трее'
    : 'Сквозной клик: включить проход мыши сквозь HUD';
  $('clickthrough').setAttribute('aria-label',$('clickthrough').title);
  const pinned=settings.alwaysOnTop!==false;
  $('pin').classList.toggle('active',pinned);
  $('pin').classList.toggle('inactive',!pinned);
  $('pin').setAttribute('aria-pressed',String(pinned));
  $('pin').title=pinned?'Открепить HUD: разрешить окнам перекрывать его':'Закрепить HUD поверх окон';
  $('pin').setAttribute('aria-label',$('pin').title);
  $('click-state').textContent=settings.clickThrough?'CLICK-THROUGH · SHIFT+M TOGGLE / ALT+M OFF / TRAY':pinned?'PINNED · INTERACTIVE':'UNPINNED · INTERACTIVE';
}
$('dashboard').onclick=()=>window.nexus.openDashboardWindow();$('mode').onclick=()=>window.nexus.toggleMode();$('clickthrough').onclick=async()=>{try{const updated=await window.nexus.toggleClickThrough();applySettings(updated);}catch(error){$('status').textContent=`Не удалось переключить сквозной клик: ${error.message||error}`;}};$('pin').onclick=async()=>{const next=settings.alwaysOnTop===false;try{const updated=await window.nexus.togglePin(next);applySettings(updated);}catch(error){$('status').textContent=`Не удалось изменить закрепление: ${error.message||error}`;}};$('hide').onclick=()=>window.nexus.close();
$('sound').onclick=async()=>{unlockAudio();settings.soundEnabled=!(settings.soundEnabled!==false);await window.nexus.updateSettings({soundEnabled:settings.soundEnabled});applySettings(settings);playTone(880,0,.2,.07);};
document.addEventListener('pointerdown',unlockAudio,{once:true});
window.nexus.onSettings(applySettings);window.nexus.onState(render);window.nexus.loadData().then(d=>applySettings(d.settings));window.nexus.getState().then(render);
setInterval(()=>{if(state.startedAt){const end=Number(state.gameEndedAt)||Date.now();$('duration').textContent=duration(end-state.startedAt);const h=Math.max(1,(end-state.startedAt)/3600000);$('hour-value').textContent=`${fmt((state.sessionValueFe||0)/h,1)} FE/ч`;}const map=state.currentMap||state.lastMap;if(map){const ms=map.endedAt?Number(map.durationSec||0)*1000:Math.max(0,Date.now()-Number(map.startedAt||Date.now()));$('map-run-duration').textContent=duration(ms);}},1000);
