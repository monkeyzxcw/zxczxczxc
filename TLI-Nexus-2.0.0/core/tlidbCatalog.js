const SOURCE_ORIGIN = 'https://tlidb.com';
const MAX_PAGE_BYTES = 6 * 1024 * 1024;
const MAX_RECORDS = 100000;
const DEFAULT_DELAY_MS = 350;

export const TLIDB_GEAR_PAGES = Object.freeze([
  ['STR_Helmet', 'Strength helmet', 'Helmet'],
  ['DEX_Helmet', 'Dexterity helmet', 'Helmet'],
  ['INT_Helmet', 'Intelligence helmet', 'Helmet'],
  ['STR_Chest_Armor', 'Strength chest armor', 'Chest Armor'],
  ['DEX_Chest_Armor', 'Dexterity chest armor', 'Chest Armor'],
  ['INT_Chest_Armor', 'Intelligence chest armor', 'Chest Armor'],
  ['STR_Gloves', 'Strength gloves', 'Gloves'],
  ['DEX_Gloves', 'Dexterity gloves', 'Gloves'],
  ['INT_Gloves', 'Intelligence gloves', 'Gloves'],
  ['STR_Boots', 'Strength boots', 'Boots'],
  ['DEX_Boots', 'Dexterity boots', 'Boots'],
  ['INT_Boots', 'Intelligence boots', 'Boots'],
  ['Claw', 'Claw', 'One-handed weapon'],
  ['Dagger', 'Dagger', 'One-handed weapon'],
  ['One-Handed_Sword', 'One-handed sword', 'One-handed weapon'],
  ['One-Handed_Hammer', 'One-handed hammer', 'One-handed weapon'],
  ['One-Handed_Axe', 'One-handed axe', 'One-handed weapon'],
  ['Wand', 'Wand', 'One-handed weapon'],
  ['Rod', 'Rod', 'One-handed weapon'],
  ['Scepter', 'Scepter', 'One-handed weapon'],
  ['Cane', 'Cane', 'One-handed weapon'],
  ['Pistol', 'Pistol', 'One-handed weapon'],
  ['Two-Handed_Sword', 'Two-handed sword', 'Two-handed weapon'],
  ['Two-Handed_Hammer', 'Two-handed hammer', 'Two-handed weapon'],
  ['Two-Handed_Axe', 'Two-handed axe', 'Two-handed weapon'],
  ['Tin_Staff', 'Tin staff', 'Two-handed weapon'],
  ['Cudgel', 'Cudgel', 'Two-handed weapon'],
  ['Bow', 'Bow', 'Two-handed weapon'],
  ['Crossbow', 'Crossbow', 'Two-handed weapon'],
  ['Musket', 'Musket', 'Two-handed weapon'],
  ['Fire_Canon', 'Fire canon', 'Two-handed weapon'],
  ['STR_Shield', 'Strength shield', 'Shield'],
  ['DEX_Shield', 'Dexterity shield', 'Shield'],
  ['INT_Shield', 'Intelligence shield', 'Shield'],
  ['Necklace', 'Necklace', 'Trinket'],
  ['Ring', 'Ring', 'Trinket'],
  ['Belt', 'Belt', 'Trinket'],
  ['Spirit_Ring', 'Spirit ring', 'Trinket'],
].map(([slug, label, group]) => Object.freeze({ slug, label, group })));

const PAGE_BY_SLUG = new Map(TLIDB_GEAR_PAGES.map((page) => [page.slug, page]));
const clean = (value, max = 500) => String(value ?? '').replace(/[\u0000\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const normalize = (value) => clean(value, 2000).toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, ' ').trim();

function decodeEntities(value) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', minus: '−', rsquo: '’', lsquo: '‘',
    rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®',
  };
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, key) => {
    if (key[0] === '#') {
      const hex = key[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : full; } catch { return full; }
    }
    return named[key.toLowerCase()] ?? full;
  });
}

function htmlText(fragment) {
  return decodeEntities(String(fragment || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(?:p|div|li|span|a|h[1-6]|td|th)>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[\u00a0\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCells(rowHtml) {
  return [...String(rowHtml).matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
    .map((match) => htmlText(match[1]));
}

function contextForTable(html, tableOffset, tableHtml) {
  const preceding = html.slice(Math.max(0, tableOffset - 7000), tableOffset);
  const headings = [...preceding.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
  const heading = headings.length ? htmlText(headings.at(-1)[1]) : '';
  const afterHeading = headings.length
    ? preceding.slice(headings.at(-1).index + headings.at(-1)[0].length)
    : preceding;
  const prelude = htmlText(afterHeading + ' ' + String(tableHtml).slice(0, 500));
  const sourceText = (heading + ' ' + prelude).toLocaleLowerCase('en');
  const sourceKind = /corrosion\s+base/i.test(sourceText)
    ? 'corrosion-base'
    : /base\s+affix/i.test(sourceText)
      ? 'base-affix'
      : /craft/i.test(sourceText)
        ? 'craft-affix'
        : 'affix-table';
  const prefixIndex = Math.max(sourceText.lastIndexOf('pre-fix'), sourceText.lastIndexOf('prefix'));
  const suffixIndex = sourceText.lastIndexOf('suffix');
  const prefixSuffix = prefixIndex > suffixIndex ? 'prefix'
    : suffixIndex >= 0 ? 'suffix' : null;
  return { heading: clean(heading, 180) || null, sourceKind, prefixSuffix };
}

export function extractModifierRanges(modifierRaw) {
  const ranges = [];
  const pattern = /\(\s*(-?\d[\d,]*(?:\.\d+)?)\s*[–—−-]\s*(-?\d[\d,]*(?:\.\d+)?)\s*\)/g;
  let match;
  while ((match = pattern.exec(String(modifierRaw || ''))) !== null) {
    ranges.push({
      min: Number(match[1].replace(/,/g, '')),
      max: Number(match[2].replace(/,/g, '')),
      raw: match[0],
    });
  }
  return ranges;
}

function findHeaderIndex(rows) {
  return rows.findIndex((row) => {
    const values = row.map(normalize);
    return values.some((value) => value === 'tier') &&
      values.some((value) => value === 'modifier');
  });
}

function columnIndex(headers, candidates) {
  return headers.findIndex((value) => candidates.includes(normalize(value)));
}

export function parseTlidbGearPage(slug, html, importedAt = Date.now()) {
  const page = PAGE_BY_SLUG.get(String(slug));
  if (!page) throw new Error('Страница TLIDB не входит в разрешённый список экипировки.');
  if (typeof html !== 'string' || !html.trim()) throw new Error('TLIDB вернул пустую HTML-страницу.');

  const sourceUrl = `${SOURCE_ORIGIN}/en/${page.slug}`;
  const records = [];
  const tables = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)];

  tables.forEach((tableMatch, tableIndex) => {
    const rowHtml = [...tableMatch[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
    const rows = rowHtml.map(parseCells);
    const headerRowIndex = findHeaderIndex(rows);
    if (headerRowIndex < 0) return;

    const headers = rows[headerRowIndex];
    const columns = {
      tier: columnIndex(headers, ['tier']),
      modifier: columnIndex(headers, ['modifier', 'affix', 'effect']),
      level: columnIndex(headers, ['lv', 'level', 'item level']),
      weight: columnIndex(headers, ['weight']),
      library: columnIndex(headers, ['library', 'affix library', 'pool']),
    };
    if (columns.tier < 0 || columns.modifier < 0) return;

    const context = contextForTable(html, tableMatch.index, tableMatch[0]);
    rows.slice(headerRowIndex + 1).forEach((cells, rowIndex) => {
      const requiredIndex = Math.max(columns.tier, columns.modifier);
      if (cells.length <= requiredIndex) return;
      const tierRaw = clean(cells[columns.tier], 40);
      const modifierRaw = clean(cells[columns.modifier], 1200);
      if (!tierRaw || !modifierRaw || normalize(tierRaw) === 'tier' || normalize(modifierRaw) === 'modifier') return;
      // Do not infer internal game IDs from public text rows.
      records.push({
        sourceKey: `${page.slug}:${tableIndex}:${rowIndex}`,
        source: 'TLIDB',
        sourceUrl,
        sourcePage: page.slug,
        sourcePageLabel: page.label,
        gearGroup: page.group,
        sourceSection: context.heading,
        sourceKind: context.sourceKind,
        prefixSuffix: context.prefixSuffix,
        tierRaw,
        modifierRaw,
        rollRanges: extractModifierRanges(modifierRaw),
        levelRaw: columns.level >= 0 ? clean(cells[columns.level], 40) || null : null,
        weightRaw: columns.weight >= 0 ? clean(cells[columns.weight], 40) || null : null,
        library: columns.library >= 0 ? clean(cells[columns.library], 100) || null : null,
        gameAffixId: null,
        gameAttrType: null,
        patchVersion: null,
        patchVerification: 'unknown',
        importedAt: Number(importedAt) || Date.now(),
      });
    });
  });

  const unique = [...new Map(records.map((row) => [row.sourceKey, row])).values()];
  return {
    page: { slug: page.slug, label: page.label, group: page.group, sourceUrl, recordCount: unique.length },
    records: unique.slice(0, MAX_RECORDS),
  };
}

export function getTlidbPageUrl(slug) {
  const page = PAGE_BY_SLUG.get(String(slug));
  if (!page) throw new Error('Недопустимая страница TLIDB.');
  return `${SOURCE_ORIGIN}/en/${page.slug}`;
}

export async function fetchTlidbCatalog(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('В этой версии Node.js недоступен fetch.');
  const now = Number(options.now) || Date.now();
  const sleep = options.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delayMs = Math.max(250, Math.min(2000, Number(options.delayMs) || DEFAULT_DELAY_MS));
  const selected = options.slugs
    ? [...new Set(options.slugs.map(String))]
    : TLIDB_GEAR_PAGES.map((page) => page.slug);
  for (const slug of selected) if (!PAGE_BY_SLUG.has(slug)) throw new Error(`Недопустимая страница TLIDB: ${slug}`);

  const records = [];
  const pages = [];
  const errors = [];
  for (let index = 0; index < selected.length; index += 1) {
    const slug = selected[index];
    if (index > 0) await sleep(delayMs);
    const url = getTlidbPageUrl(slug);
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(15000) : undefined,
        redirect: 'follow',
      });
      if (!response?.ok) {
        const error = new Error(`HTTP ${Number(response?.status) || 'ошибка'}`);
        error.status = Number(response?.status) || 0;
        throw error;
      }
      const finalUrl = response.url ? new URL(response.url) : new URL(url);
      if (finalUrl.origin !== SOURCE_ORIGIN) throw new Error('TLIDB перенаправил запрос на другой домен; импорт остановлен.');
      const html = await response.text();
      if (Buffer.byteLength(html, 'utf8') > MAX_PAGE_BYTES) throw new Error('Страница превышает лимит 6 МБ.');
      const parsed = parseTlidbGearPage(slug, html, now);
      if (!parsed.records.length) throw new Error('На странице не найдены таблицы аффиксов с колонками Tier и Modifier.');
      pages.push(parsed.page);
      records.push(...parsed.records);
    } catch (error) {
      errors.push({ slug, url, reason: clean(error?.message || error, 240) });
      if (Number(error?.status) === 403 || Number(error?.status) === 429) {
        for (const skippedSlug of selected.slice(index + 1)) {
          errors.push({
            slug: skippedSlug,
            url: getTlidbPageUrl(skippedSlug),
            reason: `Пропущено после ограничения запросов TLIDB (HTTP ${Number(error.status)}).`,
          });
        }
        break;
      }
    }
  }

  const uniqueRecords = [...new Map(records.map((row) => [row.sourceKey, row])).values()]
    .slice(0, MAX_RECORDS);
  return {
    schemaVersion: 1,
    source: 'TLIDB',
    sourceUrl: 'https://tlidb.com/en/Craft',
    syncedAt: now,
    patchVersion: null,
    patchVerification: 'unknown',
    patchNote: 'TLIDB gear pages do not expose a reliable game-season/patch identifier in the parsed tables.',
    pages,
    failedPages: errors,
    records: uniqueRecords,
    summary: {
      pagesRequested: selected.length,
      pagesImported: pages.length,
      pagesFailed: errors.length,
      affixRows: uniqueRecords.length,
      gearGroups: [...new Set(pages.map((page) => page.group))].length,
    },
    limitations: [
      'TLIDB is a fan-made community reference and is not an official game API.',
      'The parsed pages do not provide internal game AffixId or AttrType IDs; Nexus does not invent or infer them.',
      'Season/patch version is unverified because the parsed equipment tables do not expose a reliable version marker.',
      'The local cache is user-triggered and stored outside the installer; it is not bundled or uploaded by Nexus.',
      'Affix text is sourced in English; localization to Russian is not inferred.',
    ],
  };
}

/**
 * Replace only pages successfully fetched in the latest sync. Pages that failed
 * remain available from the last good cache, so a temporary TLIDB outage cannot
 * silently erase part of the local affix reference.
 */
export function mergeTlidbCatalog(existing, incoming) {
  if (!incoming || incoming.source !== 'TLIDB' || !Array.isArray(incoming.records)) {
    throw new Error('Получен некорректный результат синхронизации TLIDB.');
  }

  const successfulSlugs = new Set((incoming.pages || []).map((page) => page.slug));
  const failedSlugs = new Set((incoming.failedPages || []).map((page) => page.slug));
  const retainedRecords = Array.isArray(existing?.records)
    ? existing.records.filter((row) => failedSlugs.has(row.sourcePage) || !successfulSlugs.has(row.sourcePage))
    : [];
  const records = [...new Map(
    [...retainedRecords, ...incoming.records].map((row) => [row.sourceKey, row]),
  ).values()].slice(0, MAX_RECORDS);

  const pageMap = new Map();
  for (const page of [...(existing?.pages || []), ...(incoming.pages || [])]) {
    const keepOldForFailedPage = failedSlugs.has(page.slug) && !successfulSlugs.has(page.slug);
    if (!keepOldForFailedPage || !pageMap.has(page.slug)) pageMap.set(page.slug, page);
  }
  const pages = TLIDB_GEAR_PAGES.map((page) => pageMap.get(page.slug)).filter(Boolean);
  const retainedPages = [...failedSlugs].filter((slug) =>
    Array.isArray(existing?.records) && existing.records.some((row) => row.sourcePage === slug),
  ).length;
  const pagesImported = Number(incoming.summary?.pagesImported) || 0;
  const pagesRequested = Number(incoming.summary?.pagesRequested) || successfulSlugs.size + failedSlugs.size;
  const pagesFailed = Number(incoming.summary?.pagesFailed) || (incoming.failedPages || []).length;
  const lastFullSyncAt = pagesFailed === 0 && pagesImported === pagesRequested
    ? Number(incoming.syncedAt) || Date.now()
    : Number(existing?.lastFullSyncAt) || null;

  return {
    ...incoming,
    pages,
    records,
    lastSuccessfulSyncAt: pagesImported > 0
      ? Number(incoming.syncedAt) || Date.now()
      : Number(existing?.lastSuccessfulSyncAt) || null,
    lastFullSyncAt,
    summary: {
      ...incoming.summary,
      pagesRequested,
      pagesImported,
      pagesFailed,
      retainedPages,
      affixRows: records.length,
      gearGroups: [...new Set(pages.map((page) => page.group))].length,
    },
    limitations: [
      ...(incoming.limitations || []),
      ...(retainedPages
        ? [`Для ${retainedPages} временно недоступных страниц сохранены данные из предыдущего локального кэша.`]
        : []),
    ],
  };
}

export function tlidbCatalogStatus(index) {
  if (!index || index.source !== 'TLIDB' || !Array.isArray(index.records)) {
    return {
      imported: false,
      label: 'TLIDB ещё не загружена',
      summary: null,
      patchVerification: 'unknown',
    };
  }
  return {
    imported: index.records.length > 0,
    label: index.records.length ? 'Локальный кэш TLIDB загружен' : 'В кэше TLIDB нет записей',
    syncedAt: Number(index.syncedAt) || null,
    patchVersion: index.patchVersion || null,
    patchVerification: index.patchVerification || 'unknown',
    patchNote: clean(index.patchNote, 300),
    summary: { ...(index.summary || {}) },
    failedPages: Array.isArray(index.failedPages) ? index.failedPages.slice(0, 50) : [],
    limitations: Array.isArray(index.limitations) ? index.limitations.slice(0, 20) : [],
  };
}

export function searchTlidbAffixes(index, query = '', options = {}) {
  const records = Array.isArray(index?.records) ? index.records : [];
  const terms = normalize(query).split(' ').filter(Boolean);
  const group = clean(options.gearGroup, 80);
  const kind = clean(options.sourceKind, 40);
  const filtered = records.filter((row) => {
    if (group && row.gearGroup !== group) return false;
    if (kind && row.sourceKind !== kind) return false;
    if (!terms.length) return true;
    const haystack = normalize([
      row.modifierRaw, row.tierRaw, row.library, row.sourcePageLabel,
      row.gearGroup, row.sourceSection, row.prefixSuffix,
    ].filter(Boolean).join(' '));
    return terms.every((term) => haystack.includes(term));
  });
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 40));
  return {
    total: filtered.length,
    results: filtered.slice(0, limit).map((row) => ({ ...row })),
  };
}
