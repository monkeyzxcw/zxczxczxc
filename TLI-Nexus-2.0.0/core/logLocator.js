import fs from 'node:fs';
import path from 'node:path';

// Evidence from a real log: the game logs "../../../UE_game/TorchLight/Saved/PersistentDownloadDir/..." relative to
// <install>\UE_game\Binaries\Win64, so logs live in <install>\UE_game\TorchLight\Saved\Logs\UE_game.log and older runs are
// kept next to it as UE_game-backup-<date>.log. The Steam folder name below is still a guess; every candidate is validated by content.
export const STEAM_REL_CANDIDATES = [
  ['steamapps', 'common', 'Torchlight Infinite', 'UE_game', 'TorchLight', 'Saved', 'Logs'],
];
const MARKER_UE = /^\[\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{1,3}\]\[/m; // any UE log line; category is not fixed ("GameLog" in old builds, "TLNetGame" now)
const MARKER_MSG = /(SendMessage|PushMessage|RecvMessage|RecvPushMsg)\s+STT-+/i;

export function steamLibraries(env = process.env) {
  const roots = new Set();
  const pf = [env['ProgramFiles(x86)'], env.ProgramFiles, 'C:\\Program Files (x86)'].filter(Boolean);
  for (const p of pf) {
    const steam = path.join(p, 'Steam');
    roots.add(steam);
    try {
      const vdf = fs.readFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(m[1].replace(/\\\\/g, '\\'));
    } catch { /* no steam here */ }
  }
  return [...roots];
}

/** Decide whether a file is the game's UE log. Scans the file in blocks (newest data first is irrelevant: protocol messages can be
 *  anywhere, e.g. mid-file in a short session), stops at the first protocol message, gives up after maxBytes. */
export function validateLog(file, maxBytes = 64 * 1024 * 1024, block = 1 << 20) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { ok: false, reason: 'not a file' };
    const fd = fs.openSync(file, 'r');
    try {
      let isUe = false, hasMsgs = false, pos = 0, carry = '';
      const buf = Buffer.alloc(block);
      while (pos < st.size && pos < maxBytes && !hasMsgs) {
        const n = fs.readSync(fd, buf, 0, Math.min(block, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const text = carry + buf.toString('utf8', 0, n);
        carry = text.slice(-256); // protocol markers are short; overlap avoids missing one split across blocks
        isUe ||= MARKER_UE.test(text);
        hasMsgs = MARKER_MSG.test(text);
      }
      return { ok: isUe, hasProtocolMessages: hasMsgs, size: st.size, mtimeMs: st.mtimeMs,
        reason: !isUe ? 'no UE log lines found' : !hasMsgs ? 'UE log, but no "Socket ... STT----" protocol messages in the scanned part (short/menu-only session, or the log has no network messages)' : 'ok' };
    } finally { fs.closeSync(fd); }
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

/** Find candidate logs. extraDirs lets the user (or a folder picker) add directories. */
export function findLogCandidates({ extraDirs = [], env = process.env, maxDepth = 6 } = {}) {
  const dirs = new Set(extraDirs);
  for (const lib of steamLibraries(env)) for (const rel of STEAM_REL_CANDIDATES) dirs.add(path.join(lib, ...rel));
  const found = new Map();
  const scan = (dir, depth) => {
    if (depth > maxDepth) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!/^(Content|Binaries|Engine|Plugins|Paks)$/i.test(e.name)) scan(p, depth + 1); }
      else if (/\.log$/i.test(e.name) && /[\\/]Saved[\\/]Logs$/i.test(dir)) found.set(p, true);
    }
  };
  for (const d of dirs) scan(d, 0);
  return [...found.keys()].map((file) => ({ file, ...validateLog(file) }))
    .sort((a, b) => Number(!!b.hasProtocolMessages) - Number(!!a.hasProtocolMessages) || (b.mtimeMs || 0) - (a.mtimeMs || 0));
}
