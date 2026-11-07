import fs from 'node:fs';
import path from 'node:path';

const MAX_FILES = 50000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ROWS_PER_TABLE = 20000;
const TABLE_CONTAINER_KEYS = new Set([
  'rowmap', 'rows', 'datatablerows', 'rowdata', 'entries', 'datarows',
]);
const AFFIx_WORD = /affix|prefix|suffix|enchant|forge/i;
const ENUM_TABLE_WORD = /affixattrtype|gamecharattribute|gamecharfield|gameequipslot|equipmentslot|equipslot|equiprarity|equipquality|itemrarity|itemquality|raritytype|qualitytype|equipmentrarity|equipmentquality/i;
const ITEM_WORD = /item|equip|equipment|gear/i;
const LOCALIZATION_WORD = /localization|locres|stringtable|texttable|language/i;
const EXPLICIT_ID_KEYS = new Set([
  'id', 'affixid', 'baseaffixid', 'affixconfigid', 'affixbaseid',
  'itemid', 'itembaseid', 'itemconfigbaseid', 'configbaseid', 'baseid', 'baseitemid', 'equipmentid', 'equipmentbaseid', 'equipid',
]);
const normalizeKey = (value) => String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
const clean = (value, max = 200) => String(value ?? '').replace(/[\r\n\0]/g, ' ').trim().slice(0, max);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = (value) => Array.isArray(value) ? value.at(-1) : value;

function scalarMap(node) {
  const result = [];
  const payload = rowPayload(node);
  if (!isRecord(payload)) return result;
  walk(payload, (current) => {
    for (const [key, raw] of Object.entries(current)) {
      const value = scalar(raw);
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        result.push({ key, value: clean(value, 300) });
      }
    }
  });
  return result;
}

function rowPayload(row) {
  if (!isRecord(row)) return row;
  for (const key of ['Value', 'Data', 'RowData', 'Fields', 'Properties']) {
    const candidate = scalar(row[key]);
    if (isRecord(candidate)) return candidate;
  }
  return row;
}

function findNamed(node, names) {
  if (!isRecord(node)) return null;
  const wanted = new Set(names.map(normalizeKey));
  for (const [key, raw] of Object.entries(node)) {
    if (!wanted.has(normalizeKey(key))) continue;
    const value = scalar(raw);
    if (typeof value === 'string' || typeof value === 'number') return clean(value, 300);
  }
  return null;
}

function rowContainers(node, pathParts = [], out = []) {
  if (Array.isArray(node)) {
    node.forEach((value, index) => rowContainers(value, [...pathParts, String(index)], out));
    return out;
  }
  if (!isRecord(node)) return out;

  for (const [key, raw] of Object.entries(node)) {
    const normalized = normalizeKey(key);
    // Preserve every DataTable row; duplicate scalar leaves are resolved
    // separately by scalar(), but RowMap/Rows arrays are actual collections.
    const value = raw;
    if (TABLE_CONTAINER_KEYS.has(normalized) && (Array.isArray(value) || isRecord(value))) {
      const entries = Array.isArray(value)
        ? value.map((row, index) => [String(index), row])
        : Object.entries(value);
      for (const [rowName, row] of entries.slice(0, MAX_ROWS_PER_TABLE)) {
        if (isRecord(row)) out.push({ rowName, row, path: [...pathParts, key, rowName].join('.') });
      }
    } else if (isRecord(value) || Array.isArray(value)) {
      // JSON arrays represent multiple exports/objects; do not collapse to the last entry.
      rowContainers(value, [...pathParts, key], out);
    }
  }
  return out;
}

function walk(node, visit, pathParts = []) {
  if (Array.isArray(node)) {
    node.forEach((value, index) => walk(value, visit, [...pathParts, String(index)]));
    return;
  }
  if (!isRecord(node)) return;
  visit(node, pathParts);
  for (const [key, value] of Object.entries(node)) walk(value, visit, [...pathParts, key]);
}

function referencedPaths(doc) {
  const refs = new Set();
  walk(doc, (node) => {
    for (const [key, raw] of Object.entries(node)) {
      const value = scalar(raw);
      if (typeof value === 'string' && /^(?:\/Game\/|\/Script\/|\/Engine\/)/i.test(value)) {
        refs.add(value.slice(0, 300));
      }
    }
  });
  return [...refs].slice(0, 500);
}

function getExportType(doc) {
  const types = new Set();
  walk(doc, (node) => {
    for (const key of ['Type', 'Class', 'ClassName', 'ObjectClass']) {
      const value = findNamed(node, [key]);
      if (value) types.add(value);
    }
  });
  return [...types].slice(0, 20);
}

function classifyResource(resourcePath, doc, exportTypes) {
  const lower = resourcePath.toLowerCase();
  const isBlueprint = /blueprint|widget|umg/i.test(lower) ||
    exportTypes.some((value) => /blueprint|widget|userwidget/i.test(value));
  const hasTableRows = rowContainers(doc).length > 0;
  const hasDataTableType = exportTypes.some((value) => /datatable/i.test(value));
  const pathSuggestsTable = /(^|\/)(?:data|datatable|datatables)(\/|$)/i.test(resourcePath) ||
    /^dt_/i.test(path.basename(resourcePath, path.extname(resourcePath)));
  const isDataTable = !isBlueprint && (hasDataTableType || (hasTableRows && pathSuggestsTable));
  if (LOCALIZATION_WORD.test(lower) || /\.locres$/i.test(resourcePath)) return 'localization-resource';
  if (isDataTable && ENUM_TABLE_WORD.test(lower)) return 'enum-table';
  if (isDataTable) return 'data-table';
  if (AFFIx_WORD.test(lower)) return 'affix-related-asset';
  if (ITEM_WORD.test(lower)) return 'item-related-asset';
  if (isBlueprint) return 'blueprint-or-ui-asset';
  return 'other-game-asset';
}

function extractRows(resourcePath, doc, kind) {
  if (kind !== 'data-table' && kind !== 'enum-table') {
    return { itemRows: [], affixRows: [], enumRows: [], tableRowCount: 0 };
  }
  const tableRows = rowContainers(doc);
  const itemRows = [];
  const affixRows = [];
  const enumRows = [];
  for (const entry of tableRows) {
    const fields = scalarMap(entry.row);
    const fieldKeys = new Set(fields.map((field) => normalizeKey(field.key)));
    const payload = rowPayload(entry.row);
    const name = findNamed(payload, [
      'Name', 'DisplayName', 'ItemName', 'EquipName', 'AffixName', 'Title',
    ]);
    const rowLooksEnum = kind === 'enum-table' || ENUM_TABLE_WORD.test(resourcePath);
    const rowLooksAffix = !rowLooksEnum && (AFFIx_WORD.test(resourcePath) ||
      [...fieldKeys].some((key) => ['affixid', 'baseaffixid', 'affixconfigid', 'affixbaseid'].includes(key)));
    const rowLooksItem = !rowLooksEnum && (ITEM_WORD.test(resourcePath) ||
      [...fieldKeys].some((key) => ['itemid', 'itembaseid', 'itemconfigbaseid', 'configbaseid', 'equipmentid', 'equipmentbaseid', 'equipid'].includes(key)));
    const preferredAffixIdKeys = ['affixid', 'baseaffixid', 'affixconfigid', 'affixbaseid'];
    const preferredItemIdKeys = ['itembaseid', 'itemconfigbaseid', 'configbaseid', 'itemid', 'equipmentbaseid', 'equipmentid', 'equipid', 'baseitemid', 'baseid'];
    const preferredKeys = rowLooksAffix
      ? preferredAffixIdKeys
      : rowLooksItem
        ? preferredItemIdKeys
        : [];
    const idField = fields.find((field) => preferredKeys.includes(normalizeKey(field.key))) ||
      fields.find((field) => normalizeKey(field.key) === 'id');
    const id = idField ? idField.value : null;
    const summary = {
      id: id ? clean(id, 100) : null,
      idField: idField?.key || null,
      rowName: clean(entry.rowName, 120),
      name,
      nameKeyRaw: findNamed(payload, ['NameKey', 'TextKey', 'StringKey', 'LocKey']),
      descriptionKeyRaw: findNamed(payload, ['DescKey', 'DescriptionKey', 'DescriptionTextKey']),
      sourcePath: resourcePath,
      rowPath: entry.path,
      fields: fields.slice(0, 100),
    };

    if (rowLooksEnum) {
      summary.enumId = id || clean(entry.rowName, 120);
      summary.enumName = findNamed(payload, [
        'Name', 'DisplayName', 'AttributeName', 'FieldName', 'SlotName', 'EnumName',
      ]) || name;
      summary.valueRaw = findNamed(payload, [
        'AttrType', 'AttributeId', 'SlotId', 'EnumValue', 'Value', 'ValueId', 'Id',
      ]);
      summary.enumType = path.basename(resourcePath, path.extname(resourcePath));
      enumRows.push(summary);
    } else if (rowLooksAffix && id) {
      summary.attributeRaw = findNamed(payload, [
        'AttrType', 'AffixAttrType', 'AttributeType', 'AttributeId', 'AttrId',
      ]);
      summary.minRaw = findNamed(payload, ['Min', 'MinValue', 'ValueMin', 'MinRoll']);
      summary.maxRaw = findNamed(payload, ['Max', 'MaxValue', 'ValueMax', 'MaxRoll']);
      summary.tierRaw = findNamed(payload, ['Tier', 'AffixTier', 'Level', 'AffixLevel']);
      affixRows.push(summary);
    } else if (rowLooksItem && id) {
      summary.slotRaw = findNamed(payload, ['EquipSlot', 'EquipmentSlot', 'WearSlot', 'Slot']);
      summary.itemTypeRaw = findNamed(payload, ['ItemType', 'EquipType', 'EquipmentType', 'Type']);
      itemRows.push(summary);
    }
  }
  return { itemRows, affixRows, enumRows, tableRowCount: tableRows.length };
}

function extractLocalizationEntries(resourcePath, doc) {
  const entries = new Map();
  walk(doc, (node, nodePath) => {
    const key = findNamed(node, [
      'TextKey', 'NameKey', 'StringKey', 'LocKey', 'LocalizationKey', 'Key', 'StringId',
    ]);
    const value = findNamed(node, [
      'LocalizedText', 'Translation', 'Text', 'String', 'LocalizedString', 'Content',
    ]);
    if (!key || !value || key === value) return;
    const normalizedKey = clean(key, 240);
    if (!entries.has(normalizedKey)) {
      entries.set(normalizedKey, {
        key: normalizedKey,
        text: clean(value, 1000),
        sourcePath: resourcePath,
        rowPath: nodePath.join('.').slice(0, 300),
      });
    }
  });
  return [...entries.values()];
}

function readTextResource(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > maxBytes) return null;
  const buffer = fs.readFileSync(filePath);
  if (buffer.includes(0)) return null;
  const content = buffer.toString('utf8');
  const controlChars = [...content].filter((char) => /\p{C}/u.test(char) && !/[\t\r\n]/.test(char)).length;
  if (content.length && controlChars / content.length > 0.05) return null;
  return content;
}

function listFiles(root, maxFiles, errors) {
  const results = [];
  const stack = [root];
  while (stack.length && results.length < maxFiles) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) { errors.push({ path: current, reason: clean(error.message, 200) }); continue; }

    const preferredDirs = [];
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const directoryName = entry.name.toLowerCase();
        if ([
          'node_modules', '.git', 'cache', 'saved', 'intermediate',
          'art', 'textures', 'meshes', 'materials', 'audio', 'sound', 'sounds',
          'shaders', 'movies', 'cinematics', 'animations', 'animation', 'vfx',
        ].includes(directoryName)) continue;
        const priority = /^(data|datatable|datatables|gamedata|tables|blueprint|blueprints|script|scripts|config|localization|localisation|locale|text|texts)$/i.test(entry.name) ? 2 : 0;
        preferredDirs.push({ path: fullPath, priority });
      } else if (entry.isFile()) {
        const extension = path.extname(entry.name).toLowerCase();
        if (extension === '.json' || extension === '.out' || extension === '.lua' || extension === '.txt' || extension === '.ini' || extension === '.locres') {
          results.push(fullPath);
        }
      }
    }
    // LIFO traversal: visit data/config/script/localization folders before
    // generic folders when the export contains more files than the scan cap.
    preferredDirs.sort((a, b) => a.priority - b.priority);
    for (const directory of preferredDirs) stack.push(directory.path);
  }
  return results;
}

function parseDefaultGameIni(content) {
  const projectVersion = /^\s*ProjectVersion\s*=\s*(.+)$/mi.exec(content)?.[1]?.trim() || null;
  const redirects = [];
  const redirectPattern = /(?:StructRedirects|ClassRedirects)=\([^)]*OldName="([^"]+)"[^)]*NewName="([^"]+)"/g;
  let match;
  while ((match = redirectPattern.exec(content)) !== null) {
    redirects.push({ oldName: match[1], newName: match[2] });
  }
  const names = new Set(redirects.map((row) => row.oldName));
  const knownGameTypes = [
    'GameEquipSlot', 'GameAffixBlackboard', 'AffixAttrType',
    'GameCharAttribute', 'GameCharField',
  ].filter((name) => names.has(name));
  return { projectVersion, redirects, knownGameTypes };
}

/**
 * Offline importer for FModel/Unreal text exports. It does not need network
 * access and never executes game scripts or loads binary assets.
 */
export function scanGameResourceFolder(rootPath, options = {}) {
  const selected = String(rootPath || '').trim();
  if (!selected) throw new Error('Выбери папку с экспортом игровых ресурсов.');
  const root = path.resolve(selected);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('Выбранная папка игровых ресурсов не найдена.');
  }

  const errors = [];
  const files = listFiles(root, Math.min(MAX_FILES, Number(options.maxFiles) || MAX_FILES), errors);
  const manifest = [];
  const itemDefinitions = [];
  const affixDefinitions = [];
  const attributeDefinitions = [];
  const tableSchemas = [];
  const scriptHints = [];
  const localizationHints = [];
  const localizationEntries = [];
  const schemaEvidence = new Map();
  let scannedJson = 0;
  let skippedOversized = 0;
  let failedJson = 0;
  let defaultGameIni = null;

  for (const filePath of files) {
    const relativePath = path.relative(root, filePath).replace(/\\/g, '/');
    const extension = path.extname(filePath).toLowerCase();
    let doc = null;
    let text = null;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_BYTES) {
        skippedOversized++;
        continue;
      }

      if (extension === '.json') {
        text = fs.readFileSync(filePath, 'utf8');
        try { doc = JSON.parse(text); }
        catch {
          // FModel may export the Unreal INI DefaultGame config with a .json suffix.
          if (!/DefaultGame\.json$/i.test(relativePath)) failedJson++;
        }
        scannedJson++;
      } else {
        text = readTextResource(filePath, MAX_FILE_BYTES);
      }
    } catch (error) {
      errors.push({ path: relativePath, reason: clean(error.message, 200) });
      continue;
    }

    if (extension === '.locres') {
      localizationHints.push({ path: relativePath, extension, bytes: fs.statSync(filePath).size, parsed: false });
      continue;
    }

    if (relativePath.toLowerCase().endsWith('defaultgame.json') && text) {
      defaultGameIni = parseDefaultGameIni(text);
      for (const name of defaultGameIni.knownGameTypes) {
        schemaEvidence.set(name, {
          name,
          sourcePath: relativePath,
          evidence: 'CoreRedirects class/struct redirect',
          verifiedAs: 'game type identifier, not an affix definition',
        });
      }
    }

    if (extension === '.out' || extension === '.lua') {
      if (text && /affix|equip|item|forge/i.test(relativePath)) {
        const symbols = [...new Set(
          (text.match(/[A-Za-z_][A-Za-z0-9_]{2,80}/g) || [])
            .filter((token) => /affix|equip|item|forge|attr|quality|rarity|slot/i.test(token)),
        )].slice(0, 300);
        scriptHints.push({ path: relativePath, bytes: fs.statSync(filePath).size, symbols });
      }
      continue;
    }

    if (!doc) {
      if (extension === '.txt' && text && /affix|equip|item|forge/i.test(relativePath)) {
        scriptHints.push({ path: relativePath, bytes: fs.statSync(filePath).size, symbols: [] });
      }
      continue;
    }

    const exportTypes = getExportType(doc);
    const kind = classifyResource(relativePath, doc, exportTypes);
    const refs = referencedPaths(doc);
    const rowData = extractRows(relativePath, doc, kind);
    if (kind === 'localization-resource') {
      localizationEntries.push(...extractLocalizationEntries(relativePath, doc));
    }
    const name = path.basename(filePath, extension);
    const useful = kind !== 'other-game-asset' || rowData.tableRowCount > 0 ||
      exportTypes.some((value) => /datatable|dataasset/i.test(value));
    if (useful) {
      manifest.push({
        path: relativePath,
        name,
        kind,
        exportTypes,
        tableRowCount: rowData.tableRowCount,
        references: refs.slice(0, 60),
        bytes: fs.statSync(filePath).size,
      });
    }
    itemDefinitions.push(...rowData.itemRows);
    affixDefinitions.push(...rowData.affixRows);
    attributeDefinitions.push(...(rowData.enumRows || []));
    if (rowData.tableRowCount) {
      tableSchemas.push({
        path: relativePath,
        kind,
        rowCount: rowData.tableRowCount,
        exportTypes,
        sampleRowNames: rowContainers(doc).slice(0, 12).map((row) => row.rowName),
      });
    }
    if (kind === 'localization-resource') {
      localizationHints.push({ path: relativePath, extension, bytes: fs.statSync(filePath).size });
    }
  }

  const uniqueItems = new Map();
  for (const row of itemDefinitions) uniqueItems.set([row.id, row.sourcePath, row.rowName].join('|'), row);
  const uniqueAffixes = new Map();
  for (const row of affixDefinitions) uniqueAffixes.set([row.id, row.sourcePath, row.rowName].join('|'), row);
  const uniqueAttributes = new Map();
  for (const row of attributeDefinitions) uniqueAttributes.set([row.enumId, row.sourcePath, row.rowName].join('|'), row);

  const result = {
    schemaVersion: 1,
    importedAt: Date.now(),
    rootLabel: path.basename(root),
    sourceMeta: {
      projectVersion: defaultGameIni?.projectVersion || null,
      defaultGameIniFound: Boolean(defaultGameIni),
      knownGameTypes: defaultGameIni?.knownGameTypes || [],
      redirectsFound: defaultGameIni?.redirects?.length || 0,
    },
    summary: {
      filesDiscovered: files.length,
      jsonFilesScanned: scannedJson,
      usefulAssets: manifest.length,
      dataTables: tableSchemas.length,
      dataTableRows: tableSchemas.reduce((sum, row) => sum + row.rowCount, 0),
      itemDefinitions: uniqueItems.size,
      affixDefinitions: uniqueAffixes.size,
      attributeDefinitions: uniqueAttributes.size,
      scriptHints: scriptHints.length,
      localizationHints: localizationHints.length,
      localizationEntries: localizationEntries.length,
      failedJson,
      skippedOversized,
      errors: errors.length,
    },
    schemaEvidence: [...schemaEvidence.values()],
    itemDefinitions: [...uniqueItems.values()].slice(0, 15000),
    affixDefinitions: [...uniqueAffixes.values()].slice(0, 15000),
    attributeDefinitions: [...uniqueAttributes.values()].slice(0, 10000),
    tableSchemas: tableSchemas.slice(0, 2000),
    assetManifest: manifest.slice(0, 10000),
    scriptHints: scriptHints.slice(0, 2000),
    localizationHints: localizationHints.slice(0, 1000),
    localizationEntries: [...new Map(localizationEntries.map((row) => [row.key, row])).values()].slice(0, 50000),
    errors: errors.slice(0, 200),
    limitations: [
      'UI Blueprint экспорт содержит структуру интерфейса и ссылки, но сам по себе не является таблицей игровых роллов.',
      'Только подтверждённые DataTable/RowMap/Rows записи добавляются в определения предметов и аффиксов.',
      'Неизвестные числовые enum и AttrType сохраняются как исходные значения; их смысл не угадывается.',
      'Бинарные .uasset, .pak и .locres не открываются и не исполняются этим импортёром.',
      'FModel .out/.lua читаются только как обычный текст, когда кодировка и содержимое позволяют безопасный текстовый разбор.',
    ],
  };

  return result;
}

export function resourceCatalogStatus(index) {
  if (!index || typeof index !== 'object') {
    return {
      imported: false,
      label: 'Игровые ресурсы ещё не импортированы',
      summary: null,
      knownGameTypes: [],
    };
  }
  return {
    imported: true,
    label: 'Локальные ресурсы импортированы',
    importedAt: Number(index.importedAt) || null,
    rootLabel: clean(index.rootLabel, 100),
    summary: { ...(index.summary || {}) },
    knownGameTypes: [...(index.sourceMeta?.knownGameTypes || [])],
    projectVersion: index.sourceMeta?.projectVersion || null,
  };
}
