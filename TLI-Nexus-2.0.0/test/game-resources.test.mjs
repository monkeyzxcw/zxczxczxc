import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractItemAffixEvidence, extractItemMetadata, inspectItemObservation } from '../core/itemObservation.js';
import { resourceCatalogStatus, scanGameResourceFolder } from '../core/gameResourceCatalog.js';

test('item observation extracts affixes only from explicit affix paths', () => {
  const node = {
    ItemBaseId: 41001,
    Level: 85,
    RareValue: 3,
    Quality: 12,
    BaseAffix: {
      1: { Id: 7001, AttrType: 12, Value: 135, Tier: 2 },
      2: { Id: 7002, AttrType: 27, Value: '18%', Tier: 1 },
    },
    ItemMeta: { Id: 41001, Quality: 99 },
  };
  const affixes = extractItemAffixEvidence(node, ['Item']);
  assert.equal(affixes.length, 2);
  assert.equal(affixes[0].id, '7001');
  assert.equal(affixes[0].attributeRaw, '12');
  assert.ok(affixes[0].values.some((field) => field.key === 'Value' && field.value === '135'));
  assert.ok(!affixes.some((row) => row.id === '41001'));
});

test('item metadata keeps unknown enum values literal instead of guessing labels', () => {
  const metadata = extractItemMetadata({
    ItemLevel: 86,
    RareValue: 4,
    Quality: 9,
    EnhanceLevel: 12,
    EquipSlot: 5,
    AffixNum: 6,
  });
  assert.equal(metadata.itemLevelRaw, '86');
  assert.equal(metadata.rarityRaw, '4');
  assert.equal(metadata.qualityRaw, '9');
  assert.equal(metadata.enhanceLevelRaw, '12');
  assert.equal(metadata.slotRaw, '5');
  assert.equal(metadata.affixCountRaw, '6');
});

test('full observation retains raw scalar evidence and affix paths', () => {
  const observation = inspectItemObservation({
    ItemBaseId: 12001,
    RandAffix: { 1: { AffixId: 9001, MinValue: 10, MaxValue: 20 } },
  }, ['Inventory', 'Slot1']);
  assert.equal(observation.affixes[0].id, '9001');
  assert.equal(observation.evidence, 'UE_game parsed item tree');
  assert.ok(observation.rawFields.some((field) => field.key === 'ItemBaseId'));
  assert.match(observation.affixes[0].path, /Inventory\.Slot1\.RandAffix/);
});

test('resource scanner indexes only explicit table rows and preserves CoreRedirect evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-game-resources-'));
  try {
    const config = path.join(root, 'Config');
    const data = path.join(root, 'Content', 'Data');
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(config, 'DefaultGame.json'), [
      '[/Script/EngineSettings.GeneralProjectSettings]',
      'ProjectVersion=17.0.0',
      '[CoreRedirects]',
      '+StructRedirects=(OldName="GameAffixBlackboard",NewName="/Script/UE_game.GameAffixBlackboard")',
      '+StructRedirects=(OldName="GameEquipSlot",NewName="/Script/UE_game.GameEquipSlot")',
    ].join('\n'));
    fs.writeFileSync(path.join(data, 'DT_EquipmentAffix.json'), JSON.stringify({
      Exports: [{
        Type: 'DataTable',
        Name: 'DT_EquipmentAffix',
        Properties: {
          RowMap: [
            { Name: 'Life_T2', Value: { AffixId: 7001, AffixName: 'Life', AttrType: 12, MinValue: 100, MaxValue: 150, Tier: 2 } },
            { Name: 'FireRes_T1', Value: { AffixId: 7002, AffixName: 'Fire resistance', AttrType: 27, MinValue: '10%', MaxValue: '15%', Tier: 1 } },
          ],
        },
      }],
    }));
    const result = scanGameResourceFolder(root);
    assert.equal(result.sourceMeta.projectVersion, '17.0.0');
    assert.deepEqual(result.sourceMeta.knownGameTypes.sort(), ['GameAffixBlackboard', 'GameEquipSlot']);
    assert.equal(result.summary.dataTables, 1);
    assert.equal(result.summary.affixDefinitions, 2);
    assert.equal(result.affixDefinitions[0].attributeRaw, '12');
    assert.equal(result.affixDefinitions[0].minRaw, '100');
    assert.equal(result.affixDefinitions[1].name, 'Fire resistance');
    assert.equal(resourceCatalogStatus(result).imported, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resource scanner separates enum tables from affix roll definitions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-affix-enum-'));
  try {
    const data = path.join(root, 'Content', 'Data');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'DT_AffixAttrType.json'), JSON.stringify({
      Exports: [{
        Type: 'DataTable',
        Name: 'DT_AffixAttrType',
        Properties: {
          RowMap: [
            { Name: 'MaxLife', Value: { Id: 12, Name: 'Maximum Life', NameKey: 'Stat.MaxLife' } },
          ],
        },
      }],
    }));
    const result = scanGameResourceFolder(root);
    assert.equal(result.summary.attributeDefinitions, 1);
    assert.equal(result.attributeDefinitions[0].enumId, '12');
    assert.equal(result.attributeDefinitions[0].enumName, 'Maximum Life');
    assert.equal(result.summary.affixDefinitions, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resource scanner extracts explicit localization keys from exported text tables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-localization-resources-'));
  try {
    const locale = path.join(root, 'Localization', 'ru-RU');
    fs.mkdirSync(locale, { recursive: true });
    fs.writeFileSync(path.join(locale, 'AffixText.json'), JSON.stringify({
      Entries: [
        { TextKey: 'Affix.Life.Name', Text: 'Дополнительное здоровье' },
        { NameKey: 'Affix.FireRes.Name', LocalizedText: 'Сопротивление огню' },
      ],
    }));
    const result = scanGameResourceFolder(root);
    assert.equal(result.summary.localizationEntries, 2);
    assert.equal(result.localizationEntries.find((row) => row.key === 'Affix.Life.Name').text, 'Дополнительное здоровье');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resource scanner does not treat similarly named UI blueprints as affix definitions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-game-ui-resources-'));
  try {
    const ui = path.join(root, 'BluePrint', 'UI', 'Common', 'AffixTipWidget');
    fs.mkdirSync(ui, { recursive: true });
    fs.writeFileSync(path.join(ui, 'CommonEquipAffixTip.json'), JSON.stringify({
      Type: 'WidgetBlueprint',
      Name: 'CommonEquipAffixTip',
      Properties: { Text: 'Affix', Width: 320 },
    }));
    const result = scanGameResourceFolder(root);
    assert.equal(result.summary.affixDefinitions, 0);
    assert.equal(result.summary.dataTables, 0);
    assert.equal(result.assetManifest[0].kind, 'affix-related-asset');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resource scanner indexes talent node names and localization keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tli-talent-resources-'));
  try {
    const data = path.join(root, 'Content', 'Data');
    const locale = path.join(root, 'Localization', 'ru-RU');
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(locale, { recursive: true });
    fs.writeFileSync(path.join(data, 'DT_TalentNode.json'), JSON.stringify({
      Exports: [{ Type: 'DataTable', Name: 'DT_TalentNode', Properties: { RowMap: [
        { Name: 'TalentNode_1001', Value: { TalentNodeId: 1001, NameKey: 'Talent.Power.Name', DescKey: 'Talent.Power.Desc' } },
      ] } }],
    }));
    fs.writeFileSync(path.join(locale, 'TalentText.json'), JSON.stringify({ Entries: [
      { TextKey: 'Talent.Power.Name', Text: 'Сила атаки' },
      { TextKey: 'Talent.Power.Desc', Text: 'Увеличивает урон атаки' },
    ] }));
    const result = scanGameResourceFolder(root);
    assert.equal(result.summary.talentDefinitions, 1);
    assert.equal(result.talentDefinitions[0].id, '1001');
    assert.equal(result.talentDefinitions[0].nameKeyRaw, 'Talent.Power.Name');
    assert.equal(result.talentDefinitions[0].descriptionKeyRaw, 'Talent.Power.Desc');
    assert.equal(result.localizationEntries.find(x => x.key === 'Talent.Power.Name').text, 'Сила атаки');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
