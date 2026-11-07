import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TLIDB_GEAR_PAGES,
  extractModifierRanges,
  fetchTlidbCatalog,
  getTlidbPageUrl,
  parseTlidbGearPage,
  searchTlidbAffixes,
  tlidbCatalogStatus,
} from '../core/tlidbCatalog.js';

const samplePage = `
<!doctype html>
<html><body>
  <h5>STR Boots Base Affix /2</h5>
  <table>
    <tr><th>Tier</th><th>Modifier</th><th>Level</th><th>Weight</th></tr>
    <tr><td>2</td><td>+(54–74) Max Life</td><td>1</td><td>1</td></tr>
  </table>
  <h5>STR Boots Corrosion Base /1</h5>
  <table>
    <tr><th>Tier</th><th>Modifier</th><th>Level</th><th>Weight</th></tr>
    <tr><td>0</td><td>+(15–20)% Movement Speed</td><td>1</td><td>1</td></tr>
  </table>
  <h5>STR Boots Craft</h5>
  <div>Pre-fix</div>
  <table>
    <tr><th>Tier</th><th>Modifier</th><th>Lv</th><th>Weight</th><th>Library</th></tr>
    <tr><td>1</td><td>+(154–220) Max Life</td><td>86</td><td>100</td><td>Basic Affix</td></tr>
  </table>
  <div>Suffix</div>
  <table>
    <tr><th>Tier</th><th>Modifier</th><th>Lv</th><th>Weight</th><th>Library</th></tr>
    <tr><td>1</td><td>+(19–27)% Fire Resistance</td><td>86</td><td>100</td><td>Basic Affix</td></tr>
  </table>
</body></html>`;

test('TLIDB parser keeps base, corrosion and craft records in separate categories', () => {
  const parsed = parseTlidbGearPage('STR_Boots', samplePage, 123456);
  assert.equal(parsed.page.slug, 'STR_Boots');
  assert.equal(parsed.records.length, 4);

  const base = parsed.records.find((row) => row.sourceKind === 'base-affix');
  const corrosion = parsed.records.find((row) => row.sourceKind === 'corrosion-base');
  const prefix = parsed.records.find((row) => row.prefixSuffix === 'prefix');
  const suffix = parsed.records.find((row) => row.prefixSuffix === 'suffix');

  assert.equal(base.tierRaw, '2');
  assert.equal(base.levelRaw, '1');
  assert.equal(corrosion.sourceKind, 'corrosion-base');
  assert.equal(prefix.sourceKind, 'craft-affix');
  assert.equal(prefix.library, 'Basic Affix');
  assert.equal(prefix.levelRaw, '86');
  assert.equal(suffix.modifierRaw, '+(19–27)% Fire Resistance');
  assert.equal(suffix.weightRaw, '100');

  assert.equal(prefix.gameAffixId, null);
  assert.equal(prefix.gameAttrType, null);
  assert.equal(prefix.patchVerification, 'unknown');
  assert.equal(prefix.importedAt, 123456);
  assert.deepEqual(prefix.rollRanges, [{ min: 154, max: 220, raw: '(154–220)' }]);
});

test('modifier parser supports multiple ranges and negative values', () => {
  const ranges = extractModifierRanges('Adds (36–38) - (44–46) Physical Damage; (-13–-12)% extra damage');
  assert.deepEqual(ranges.map((row) => [row.min, row.max]), [
    [36, 38], [44, 46], [-13, -12],
  ]);
});

test('TLIDB search filters by query and gear group without inventing identifiers', () => {
  const parsed = parseTlidbGearPage('STR_Boots', samplePage, 1000);
  const found = searchTlidbAffixes({ records: parsed.records }, 'fire resistance', { limit: 10 });
  assert.equal(found.total, 1);
  assert.equal(found.results[0].gameAffixId, null);

  const filtered = searchTlidbAffixes({ records: parsed.records }, '', {
    gearGroup: 'Boots', sourceKind: 'base-affix',
  });
  assert.equal(filtered.total, 1);
});

test('TLIDB source URLs are allowlisted', () => {
  assert.equal(getTlidbPageUrl('STR_Boots'), 'https://tlidb.com/en/STR_Boots');
  assert.throws(() => getTlidbPageUrl('../other-site'), /Недопустимая/);
  assert.equal(TLIDB_GEAR_PAGES.length, 38);
});

test('TLIDB sync fetches only allowlisted pages and records source/version limitations', async () => {
  const result = await fetchTlidbCatalog({
    slugs: ['STR_Boots'],
    now: 987654,
    delayMs: 250,
    sleepImpl: async () => {},
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      url,
      text: async () => samplePage,
    }),
  });
  assert.equal(result.source, 'TLIDB');
  assert.equal(result.syncedAt, 987654);
  assert.equal(result.summary.pagesImported, 1);
  assert.equal(result.summary.affixRows, 4);
  assert.equal(result.patchVerification, 'unknown');
  assert.ok(result.limitations.some((line) => /internal game/i.test(line)));
  assert.equal(tlidbCatalogStatus(result).imported, true);
  assert.throws(() => fetchTlidbCatalog({ slugs: ['https://attacker.test'], fetchImpl: async () => { throw new Error('should not run'); } }), /Недопустимая/);
});

test('TLIDB sync rejects off-domain redirects and records the failed page', async () => {
  const result = await fetchTlidbCatalog({
    slugs: ['STR_Boots'],
    now: 111,
    sleepImpl: async () => {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: 'https://example.com/redirected',
      text: async () => samplePage,
    }),
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.summary.pagesFailed, 1);
  assert.match(result.failedPages[0].reason, /другой домен/);
});
