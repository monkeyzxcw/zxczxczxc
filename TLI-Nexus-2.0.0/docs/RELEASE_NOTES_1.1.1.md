# TLI Nexus 1.1.1 — Windows build configuration fix

## Исправлено

- Исправлена схема `electron-builder 26.18.1`: `build.win.target` теперь задан допустимым массивом строк `nsis` и `portable`.
- Удалены объекты target с вложенными `target`/`arch`, из-за которых builder завершался с `Invalid configuration object`. Архитектура x64 задаётся командой `electron-builder --win nsis portable --x64`.
- Имена артефактов разнесены по target-specific секциям: `build.nsis.artifactName` и `build.portable.artifactName`.
- Установщик и portable EXE получают разные имена: `TLI-Nexus-1.1.1-Setup-x64.exe` и `TLI-Nexus-1.1.1-Portable-x64.exe`.

## Проверки

- Синтаксис JS и полный автоматический набор тестов.
- Проверка релизных файлов, иконки 256×256, локальных Electron-окон и builder target schema.
- Фактическая генерация Windows NSIS/portable должна быть выполнена на Windows x64.
