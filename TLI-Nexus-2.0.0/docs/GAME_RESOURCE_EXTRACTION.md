# TLI Nexus 2.2.0 — Game Resources & Item Evidence

This update adds a local-only import pipeline for FModel/Unreal text exports and preserves more explicit item-affix evidence from UE_game messages.

## Source inventory checked for this project

The attached archive `Найденные_файлы.zip` contains 72,761 ZIP entries, including 63,121 copied JSON exports, configuration files, and the FModel log. The exported JSON tree in this archive contains `Exports/UE_game/Content/Art`, configuration, and shader archives; it does not contain the Blueprint JSON exports or Lua `.out` scripts shown in the FModel log.

The included `DefaultGame.json` contains Unreal CoreRedirect identifiers for:
- `GameEquipSlot`
- `GameAffixBlackboard`
- `AffixAttrType`
- `GameCharAttribute`
- `GameCharField`

These are schema/type clues, not affix definitions or value ranges.

The FModel log references the following high-value sources, but the corresponding files are not present in the attached ZIP:
- `UE_game/Content/BluePrint/UI/EquipAffixList/EquipAffixList.uasset`
- `UE_game/Content/BluePrint/UI/Common/AffixTipWidget/CommonEquipAffixTip.uasset`
- `UE_game/Content/BluePrint/UI/Common/AffixTipWidget/CommonForgeEquipAffixTip.uasset`
- `UE_game/Content/BluePrint/UI/Corrosion/AffixDetails.uasset`
- `UE_game/Content/BluePrint/UI/Forge/ForgeAffixUpgrade.uasset`
- `UE_game/Content/BluePrint/UI/ForgePreciseAffixList/ForgePreciseAffixList.uasset`
- `UE_game/Content/BluePrint/UI/HelpManualV2/Affix/ManualAffixListView.uasset`
- `UE_game/Content/Script/Luac/Module/Common/Affix/AffixDataFactory.out`
- `UE_game/Content/Script/Luac/Module/EquipAffixList/Model/EquipAffixListModel.out`
- `UE_game/Content/Script/Luac/Module/EquipAffixList/Mgr/EquipAffixListMgr.out`
- related `EquipAffixList` controller/view `.out` files

FModel reported that the Lua `.out` packages were of an unknown type. The new importer reads them only if they are available as ordinary text; it does not execute or decompile binary code.

## Importing

In Nexus open Settings → Game resources → Import FModel export folder, then select the folder containing `Exports` (or select `Exports` itself). Nexus scans JSON exports locally, detects Unreal DataTables and their explicit row maps, recognizes item/affix rows only when IDs and table evidence are present, and records schema references from `DefaultGame.json`.

UI Blueprints are indexed as asset clues, never misclassified as affix data. Unknown enums stay raw and receive no invented Russian label.

## Item evidence

The UE message parser now retains nested affix context, raw IDs, raw attribute fields, item-level/rarity/quality/slot/enhancement values and original paths for inventory observations. Inventory or warehouse snapshots remain separate from equipped gear.
