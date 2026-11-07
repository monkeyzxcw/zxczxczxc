# Game Resource Extraction — TLI Nexus 2.2.0

## Что было в пользовательском архиве

Исследованы три вложения:
- `Найденные_файлы.zip` — 191,764,051 байт, 72,761 ZIP entries.
- `Отчет_найденных_файлов.csv` — полный индекс 73,455 просмотренных файлов.
- `Отчет_краткий.txt` — итог сканера.

В ZIP экспортировано в основном `Exports/UE_game/Content/Art`, конфигурация и шейдерные данные. В полном CSV-индексе нет совпадений по `Affix`, `EquipAffix`, `Forge`, `AttrType` или `DataTable`. Совпадения по `Equip` — 158 строк; они относятся в основном к моделям, материалам, текстурам и анимациям в `Art/DropItem/Equip`, а не к игровым таблицам аффиксов.

## Что подтверждает DefaultGame.json

Несмотря на расширение .json, файл `Exports/UE_game/Config/DefaultGame.json` является текстовым Unreal INI-файлом. В нём присутствуют CoreRedirect имена:
- `GameEquipSlot`
- `GameAffixBlackboard`
- `AffixAttrType`
- `GameCharAttribute`
- `GameCharField`

Они подтверждают названия типов / структур, но не дают значений аффиксов, имён статов, допустимых диапазонов или соответствия enum числам.

## Какие реальные ресурсы упомянуты в FModel-логе

Лог указывает на полезные ресурсы:
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
- `UE_game/Content/Script/Luac/Module/EquipAffixList/Ctrl/EquipAffixListCtrl.out`

Эти пути есть в логе FModel, но сами файлы отсутствуют в ZIP. В отношении Lua `.out` файлов FModel пишет `unknown type`; это не подтверждённый экспорт исходного Lua-текста.

## Как получить то, чего не хватает

В FModel нужно экспортировать перечисленные BluePrint-ресурсы в JSON и найти игровые DataTable/DataAsset, на которые они ссылаются. Особенно важны таблицы, содержащие:
- ID аффикса / BaseAffixId / AffixConfigId;
- AttributeId / AttrType;
- TextKey / NameKey / DescriptionKey;
- Tier / Level;
- MinValue / MaxValue / диапазон ролла;
- связи ItemBaseId ↔ слот / тип экипировки;
- локализационные строки, используемые NameKey / TextKey.

Важное отличие: виджеты `CommonEquipAffixTip` и `EquipAffixList` показывают интерфейс/ссылки, но не обязательно являются источником таблицы значений. Нужны сами DataTable/DataAsset или текстовые ресурсы, на которые ссылается UI.

## Встроенный импортёр Nexus

Импортёр работает локально:
- JSON экспортируется и разбирается как данные, скрипты не исполняются.
- DataTable распознаётся по export type DataTable или RowMap/Rows в явно похожем DataTable ресурсе.
- Извлекаются только явные ID и поля; неизвестные enum остаются строками.
- Blueprint/UI остаются подсказками по структуре и не засчитываются как строки аффиксов.
- `.out` / `.lua` читаются только если они доступны как обычный текст UTF-8; бинарные или неизвестные пакеты игнорируются.
- `.locres` учитываются в манифесте, но бинарная локализация не декодируется.
- После импорта ID из UE_game наблюдений автоматически сопоставляются с реальными строками импортированных DataTable.

В приложении: Настройки → Игровая база: предметы и аффиксы → Импортировать игровые ресурсы.


## Enum-таблицы и переводы в 2.2.0

Импортёр также выносит enum-таблицы в отдельный раздел, чтобы не смешивать их с роллами аффиксов. По именам экспортированных ресурсов распознаются таблицы типов:
- `AffixAttrType` — разрешение сырого `AttrType` в название характеристики;
- `GameCharAttribute` и `GameCharField` — дополнительные идентификаторы атрибутов/полей персонажа;
- `GameEquipSlot` / `EquipSlot` — отображаемые названия слотов;
- таблицы редкости и качества — отображение их кодов.

Числовые ID разрешаются только внутри соответствующего типа таблицы. Одинаковое число в таблице слотов и таблице AttrType не считается одним и тем же значением. Если найден только enum, Nexus показывает название характеристики, но не утверждает, что найдено полное определение аффикса или его диапазон.
