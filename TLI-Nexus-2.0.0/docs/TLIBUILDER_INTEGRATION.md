# Интеграция TLIBuilder Engine

## Назначение

Nexus подключается к уже запущенному локальному backend TLIBuilder через его HTTP API. Python-движок не встраивается в Electron и не копируется в этот репозиторий. Это позволяет обновлять и запускать движок отдельно, сохраняя изоляцию процессов.

## Запуск

1. Установить TLIBuilder согласно его README и настроить доступ к разрешённому автором набору игровых данных.
2. Запустить локальный backend TLIBuilder на стандартном порту 8765.
3. Запустить TLI Nexus.
4. Вызвать `window.nexus.getTliBuilderStatus()` для проверки соединения.
5. Передать нормализованный объект в `window.nexus.calculateWithTliBuilder(build)`.

По умолчанию Nexus обращается только к `http://127.0.0.1:8765`. Можно изменить порт/loopback-хост переменной окружения `TLI_BUILDER_URL`, например `http://127.0.0.1:9000`. Удалённые адреса, HTTPS и URL с credentials намеренно запрещены: мост предназначен только для локального процесса.

## Формат расчёта

Метод `calculateWithTliBuilder` принимает поля API `EngineStatsRequest` TLIBuilder: `slots`, `slates`, `skills`, `gear`, `character`, `condition_state`, `target_config`, `enemy_config` и поддерживаемые движком дополнительные поля. Неизвестные поля отбрасываются. Полный контракт и допустимые значения определяются версией backend TLIBuilder, установленной пользователем.

Пример минимального вызова:

```js
const status = await window.nexus.getTliBuilderStatus();
if (!status.connected) throw new Error(status.message);

const result = await window.nexus.calculateWithTliBuilder({
  slots: [{ treeName: 'example_tree', nodeStates: {} }],
  slates: [],
  skills: [],
  gear: [],
});
```

Это пример формы API, а не готовый билд: `treeName`, узлы, навыки и предметы должны быть заполнены реальными данными выбранного сезона.

## Ограничения текущего этапа

- Мост обеспечивает локальное соединение и безопасную передачу нормализованного payload.
- Он не пытается угадывать отсутствующие в игровом логе навыки, таланты, слоты и аффиксы.
- Автоматическое преобразование Character Intelligence / Nexus Build в `EngineStatsRequest` будет отдельным этапом адаптера.
- Наличие ответа движка не гарантирует, что каждая механика поддерживается: нужно проверять `supported`, NYI/coverage и поля результата.
- Игровые каталоги не копируются в Nexus этим изменением; используются данные той установки TLIBuilder, которую настроил пользователь.

## IPC

- `getTliBuilderStatus()` — проверка доступности локального API.
- `calculateWithTliBuilder(payload)` — расчёт билда через `/api/engine/stats`.

Мост работает в главном процессе Electron; renderer получает только два ограниченных IPC-метода через preload.


## Build Intelligence adapter (stage 2)

The dashboard's **«Расчёт TLIBuilder»** action sends the selected saved build and its profile's latest Character Intelligence snapshot through `core/tliBuilderAdapter.js`.

The adapter fetches the active-season skill and tree catalogs from TLIBuilder. It maps explicit skill IDs with numeric slots (1–9), resolves a main-skill name through the season catalog only when that skill ID is also observed as equipped, and maps talent IDs to tree nodes by exact game_id matches. If the observed talent rank is missing, a one-point provisional selection is marked as a warning. It never turns free-text gear notes or an inventory snapshot into engine contributions.

For complete calculations, a saved build may contain an optional `engineConfig` object. The build editor exposes this as a JSON field. Supported keys follow the installed TLIBuilder `EngineStatsRequest`, including:
- `slots`: exact tree names and selected node states; when available, selected nodes are reconstructed from observed talent game IDs;
- `skills` and `main_skill`: exact skill IDs, slots and levels;
- `gear`: TLIBuilder `GearEngineItem` contributions, including parsed affixes;
- `condition_state`, `target_config`, `enemy_config`;
- `attached_supports`, `trait_id`, trait selections, custom modifiers, memory and spirit effects.

Example shape (illustrative IDs only; not a ready-to-use build):

```json
{
  "slots": [
    { "treeName": "exact_tree_name_from_current_season", "nodeStates": { "exact_node_id": 1 } }
  ],
  "skills": [
    { "slot": 1, "skill_id": "exact_skill_id", "level": 20, "enabled": true }
  ],
  "main_skill": { "skill_id": "exact_skill_id", "level": 20 },
  "gear": [],
  "condition_state": {},
  "uptime_mode": "max"
}
```

The result panel separates engine output from coverage warnings. DPS is displayed only when the engine returns a supported main-skill result. A missing tree, gear contribution, skill ID or slot is reported as a coverage gap rather than guessed. The observed character stat count is shown for context; raw observed stats are not injected as modifiers because they are final values, not contribution lines.


## Build Intelligence adapter (stage 3 — equipment evidence)

`core/gearReconstruction.js` now converts explicit Character Intelligence equipment observations into the `GearEngineItem` envelope accepted by TLIBuilder.

- Only equipment records from an authoritative `GetPlayerData` / `GetEquipment` response are considered current. Historical `PutOn` events and inventory snapshots are not treated as proof of current equipment; `PutOff` handling is still a required follow-up.
- Slot names are mapped only through an explicit allowlist of textual labels. Numeric slot enums are not guessed; they require the matching `GameEquipSlot` resource table.
- Complete raw modifier lines are forwarded in `unresolved_texts` so TLIBuilder's own resolver can parse them. Individual scalar values, tier numbers, and unknown affix IDs are not turned into invented stat contributions.
- Explicit `grantedTalents` and belt blend IDs are forwarded only when present as explicit fields. Legendary effect text is forwarded only when a full raw effect line is present.
- Manual `engineConfig.gear` remains authoritative and is not merged with automatically observed gear, avoiding duplicate contributions.
- Coverage distinguishes observed items, recognized slots, raw modifier lines, and effective engine items. Empty placeholder gear entries do not make the build DPS-ready.
- Attached supports remain manual until the log parser can prove the support gem ID, host active-skill ID, and numeric host slot together. The adapter emits a warning instead of guessing that relationship.

This is a conservative first equipment bridge, not a claim of full item reconstruction. Current open gaps: PutOn/PutOff state reconciliation, numeric slot-enum resolution from the user's local resource index, full affix-ID → TLIBuilder modifier mapping, per-affix numeric roll extraction, and automatic support-to-host association.
