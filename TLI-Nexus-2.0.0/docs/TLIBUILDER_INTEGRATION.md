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
