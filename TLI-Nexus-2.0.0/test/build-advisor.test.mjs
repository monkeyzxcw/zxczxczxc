import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseBuild } from '../core/buildAdvisor.js';

const resourceIndex = {
  itemDefinitions:[{id:'41001',name:'Шлем теста',slotRaw:'Head',sourcePath:'DT_Items'}],
  affixDefinitions:[{id:'7001',name:'Life',attributeRaw:'12',tierRaw:'2',minRaw:'100',maxRaw:'150',sourcePath:'DT_Affixes'}],
  attributeDefinitions:[{enumId:'12',enumName:'Maximum Life',enumType:'DT_AffixAttrType'}],
  localizationEntries:[],
};

test('diagnosis prioritizes user target gaps and links exact observed gear evidence', () => {
  const report = diagnoseBuild({
    build:{name:'Test',hero:'Rose',damageType:'Fire',mainSkill:'Skill',stats:{life:900},targets:{life:1000},skills:['ID 501'],talents:['ID 801']},
    intel:{
      lastObservedAt:Date.now(),
      identity:{name:'Tester',playerId:'p1',seasonId:14,heroName:'Rose'},
      stats:[{key:'life',value:900,rawKey:'MaxLife',observedAt:Date.now()}],
      skills:[{id:'501',name:'Main Skill'}],talents:[{id:'801',name:'Talent'}],
      explicitEquipment:[{itemId:41001,name:'Helm',slotRaw:'Head',confidence:'explicit',affixes:[{id:'7001',attributeRaw:'12',values:[{key:'Value',value:'110'}]}]}],
    },
    resourceIndex,now:Date.now(),
  });
  assert.equal(report.summary.targetGaps,1);
  assert.equal(report.stats.find((row)=>row.key==='life').gap,100);
  assert.equal(report.skills.expected[0].status,'observed');
  assert.equal(report.talents.expected[0].status,'observed');
  assert.equal(report.equipment.items[0].name,'Helm');
  assert.equal(report.equipment.items[0].affixes[0].rollPercent,20);
  assert.ok(report.recommendations.some((row)=>row.code==='stat-below-target'&&row.evidence.supportingAffixes.length===1));
  assert.equal(report.summary.isFullLoadoutConfirmed,false);
  assert.match(report.disclaimer,/не рассчитывает DPS/);
});

test('partial PutOn and inventory data are not promoted to full equipment', () => {
  const report=diagnoseBuild({
    build:{skills:[],talents:[]},
    intel:{lastObservedAt:Date.now(),equipment:{items:[{itemId:41001}]},inventorySnapshots:[{items:[{itemId:41001}]}]},
    equipment:{items:[{itemId:41001}]},
    now:Date.now(),
  });
  assert.equal(report.equipment.items.length,0);
  assert.equal(report.equipment.partialObservedItems,0);
  assert.equal(report.summary.isFullLoadoutConfirmed,false);
  assert.ok(report.recommendations.some((row)=>row.code==='gear-not-confirmed'));
});

test('skill and talent mismatches are only asserted when an exact identifier was supplied', () => {
  const report=diagnoseBuild({
    build:{skills:['Skill A · ID 111'],talents:['Node B · ID 222','text-only talent']},
    intel:{lastObservedAt:Date.now(),skills:[{id:'333',name:'Skill C'}],talents:[{id:'444',name:'Node D'}]},
    now:Date.now(),
  });
  assert.equal(report.skills.expected[0].status,'not-observed');
  assert.equal(report.talents.expected[0].status,'not-observed');
  assert.equal(report.talents.expected[1].status,'unverifiable');
  assert.ok(report.recommendations.some((row)=>row.code==='skill-not-observed'));
  assert.ok(report.recommendations.some((row)=>row.code==='talent-not-observed'));
});

test('damage focus reports missing evidence and never synthesizes DPS', () => {
  const report=diagnoseBuild({
    build:{damageType:'Fire',mainSkill:'test',stats:{fireDamage:100},targets:{}},
    intel:{lastObservedAt:Date.now(),stats:[{key:'fireDamage',value:100}]},
    now:Date.now(),
  });
  assert.deepEqual(report.damageFocus.checkedStats.map((row)=>row.key),['fireDamage','firePenetration']);
  assert.ok(report.recommendations.some((row)=>row.code==='damage-focus-incomplete'));
  assert.equal('dps' in report,false);
  assert.ok(report.limitations.some((row)=>/не рассчитываются/i.test(row)));
});

test('stale profile data is marked and TLIDB is shown as reference only', () => {
  const report=diagnoseBuild({
    build:{mainSkill:'Skill'},
    profile:{id:'char',name:'Tester'},
    intel:{lastObservedAt:Date.now()-25*3600000,skills:[],talents:[]},
    tlidbCatalog:{records:Array.from({length:3},()=>({source:'TLIDB'})),patchVerification:'unknown'},
    now:Date.now(),
  });
  assert.equal(report.status,'stale-character-data');
  assert.equal(report.summary.stale,true);
  assert.equal(report.tlidb.records,3);
  assert.ok(report.limitations.some((row)=>/не использованы для ложного сопоставления/i.test(row)));
});
