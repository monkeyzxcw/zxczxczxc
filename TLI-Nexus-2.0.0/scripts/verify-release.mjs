import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'electron-main.mjs', 'electron-preload.cjs', 'build-installer.bat',
  'overlay.html', 'overlay.js', 'overlay.css', 'dashboard.html', 'dashboard.js', 'dashboard.css',
  'core/liveService.js', 'core/gameLogEvents.js', 'core/characterIntel.js', 'core/characterReport.js',
  'core/snapshotHistory.js', 'core/buildAnalysis.js', 'core/persistence.js', 'core/farmAnalytics.js',
  'core/priceHistory.js', 'core/hotkeys.js', 'core/equipmentTracker.js', 'core/characterProfiles.js',
  'data/item-catalog.json', 'assets/nexus-icon.svg', 'assets/nexus-icon.png', 'assets/nexus-icon.ico',
  'start-desktop.bat', 'start-desktop-admin.ps1', 'README.md',
  'docs/USER_ACCEPTANCE_CHECKLIST.md', 'docs/RELEASE_NOTES_2.0.0.md',
  'test/release.test.mjs', 'test/character-intel.test.mjs', 'test/character-platform.test.mjs',
];

const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error('Missing release files:', missing.join(', '));
  process.exitCode = 1;
} else {
  const items = JSON.parse(fs.readFileSync(path.join(root, 'data/item-catalog.json'), 'utf8'));
  const ids = new Set(items.map((item) => Number(item.id)).filter(Number.isSafeInteger));
  const iconIds = new Set(items
    .filter((item) => typeof item.iconUrl === 'string' && item.iconUrl.startsWith('https://cdn.tlidb.com/'))
    .map((item) => Number(item.id)));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  // ICO directory entries use 0 to represent a 256px dimension.
  const ico = fs.readFileSync(path.join(root, 'assets/nexus-icon.ico'));
  const reserved = ico.readUInt16LE(0);
  const type = ico.readUInt16LE(2);
  const entryCount = ico.readUInt16LE(4);
  const icoHas256 = reserved === 0 && type === 1 && Array.from({ length: entryCount }, (_, index) => {
    const width = ico[6 + index * 16];
    const height = ico[7 + index * 16];
    return (width === 0 || width >= 256) && (height === 0 || height >= 256);
  }).some(Boolean);

  if (!icoHas256) {
    console.error('Windows icon must be a valid ICO containing a 256x256 image.');
    process.exitCode = 1;
  } else if (
    pkg.version !== '2.0.0' ||
    pkg.main !== 'electron-main.mjs' ||
    pkg.devDependencies?.electron !== '45.2.3' ||
    pkg.dependencies?.electron ||
    !pkg.devDependencies?.['electron-builder'] ||
    !pkg.build?.win?.target?.includes('nsis') ||
    !pkg.build?.win?.target?.includes('portable') ||
    !pkg.scripts.check.includes('core/characterIntel.js') || !pkg.scripts.check.includes('core/characterReport.js') || !pkg.scripts.check.includes('core/snapshotHistory.js') || !pkg.scripts.check.includes('core/hotkeys.js') || !pkg.scripts.check.includes('core/equipmentTracker.js') ||
    pkg.build?.win?.target?.some((target) => typeof target !== 'string') ||
    pkg.build?.nsis?.artifactName !== 'TLI-Nexus-${version}-Setup-${arch}.${ext}' ||
    pkg.build?.portable?.artifactName !== 'TLI-Nexus-${version}-Portable-${arch}.${ext}'
  ) {
    console.error('Unexpected release package metadata.');
    process.exitCode = 1;
  } else {
    const main = fs.readFileSync(path.join(root, 'electron-main.mjs'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8') +
      fs.readFileSync(path.join(root, 'overlay.html'), 'utf8');
    if (!main.includes('.loadFile(') || main.includes('.loadURL(') ||
        /http:\/\/localhost/i.test(html) || fs.existsSync(path.join(root, 'index.html'))) {
      console.error('Desktop-only invariant failed: app must load local files and ship no web prototype.');
      process.exitCode = 1;
    } else {
      console.log(`Release checks passed: ${required.length} files, Electron ${pkg.devDependencies.electron}, ${ids.size} unique item IDs, ${iconIds.size} icon references, valid 256px Windows ICO, NSIS/portable string targets, distinct artifacts, local-file Electron UI.`);
    }
  }
}
