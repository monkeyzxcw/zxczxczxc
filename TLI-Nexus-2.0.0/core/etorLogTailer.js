import fs from 'node:fs';

// ETor-compatible read-only tailer: 500 ms polling, max 512 KiB per read,
// complete-line delivery, pending-byte carry, and file identity/rotation checks.
// Exact default line policy ported from ETor 1.0.6 tor/logFilter.js.
const BUILTIN_ALLOW_RULES = [
  { allOf: ['GameplayLog', '[ArrayLength]', '服务器数据_玩法格子索引'] },
  { allOf: ['GameplayLog', '[ArrayGetItem]'], anyOf: ['服务器数据_玩法质量', '服务器数据_玩法格子索引'] },
  { allOf: ['GameplayLog', '[ArrayGetItemIndex]', '子玩法实例ID_EventsMember_37E6F230'] },
];
const BUILTIN_EXCLUDE_TERMS = ['SoundTriggerTimestamps', 'GameplayLog', 'error:', 'Warning', 'PushMgr@RecvLogicMsg'];

function matchesBuiltinAllow(line) {
  const lower = line.toLowerCase();
  return BUILTIN_ALLOW_RULES.some((rule) =>
    rule.allOf.every((term) => lower.includes(term.toLowerCase())) &&
    (!rule.anyOf || rule.anyOf.some((term) => lower.includes(term.toLowerCase()))),
  );
}
function shouldExcludeEtorLine(line) {
  if (matchesBuiltinAllow(line)) return false;
  const lower = line.toLowerCase();
  return BUILTIN_EXCLUDE_TERMS.some((term) => lower.includes(term.toLowerCase()));
}

function identity(stats) {
  return {
    dev: Number(stats?.dev) || 0,
    ino: Number(stats?.ino) || 0,
    birthtimeMs: Number(stats?.birthtimeMs) || 0,
  };
}

function sameIdentity(a, b) {
  if (!a || !b) return false;
  if (a.dev && a.ino && b.dev && b.ino) return a.dev === b.dev && a.ino === b.ino;
  return a.birthtimeMs > 0 && b.birthtimeMs > 0 && Math.abs(a.birthtimeMs - b.birthtimeMs) < 2;
}

export class EtorLogTailer {
  constructor(file, {
    onLine = () => {}, onReset = () => {}, onError = () => {}, onStatus = () => {},
    pollIntervalMs = 500, maxReadSize = 512 * 1024, startPosition = 'end',
    excludePattern = null, shouldExcludeLine = shouldExcludeEtorLine,
  } = {}) {
    this.file = file;
    this.onLine = onLine;
    this.onReset = onReset;
    this.onError = onError;
    this.onStatus = onStatus;
    this.pollIntervalMs = Math.max(20, Number(pollIntervalMs) || 500);
    this.maxReadSize = Math.max(1024, Number(maxReadSize) || 512 * 1024);
    this.startPosition = startPosition;
    this.excludePattern = excludePattern;
    this.shouldExcludeLine = typeof shouldExcludeLine === 'function' ? shouldExcludeLine : null;
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.fileIdentity = null;
    this.timer = null;
    this.running = false;
    this.busy = false;
    this.lastReadAt = null;
    this.lastLineAt = null;
    this.lastLine = '';
    this.bytesRead = 0;
    this.linesRead = 0;
    this.filteredLines = 0;
    this.rotations = 0;
    this.error = null;
    this.size = 0;
  }

  start() {
    if (this.running) return this;
    const stats = fs.statSync(this.file);
    if (!stats.isFile()) throw new Error('Выбранный путь не является файлом');
    this.fileIdentity = identity(stats);
    this.size = stats.size;
    if (typeof this.startPosition === 'number' && Number.isFinite(this.startPosition)) {
      this.offset = Math.min(Math.max(0, Math.floor(this.startPosition)), stats.size);
    } else {
      this.offset = this.startPosition === 'start' ? 0 : stats.size;
    }
    this.pending = Buffer.alloc(0);
    this.running = true;
    this.publishStatus();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.timer.unref?.();
    // Do not read synchronously on attach; history is handled by the separate context scan.
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  poll() {
    if (!this.running || this.busy) return;
    this.busy = true;
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const stats = fs.fstatSync(fd);
      const nextIdentity = identity(stats);
      const generationChanged = !sameIdentity(this.fileIdentity, nextIdentity);
      const truncated = stats.size < this.offset;
      if (generationChanged || truncated) {
        this.fileIdentity = nextIdentity;
        this.offset = 0;
        this.pending = Buffer.alloc(0);
        this.rotations++;
        this.onReset({ reason: generationChanged ? 'file_replaced' : 'file_truncated', rotations: this.rotations });
      }
      this.size = stats.size;
      if (stats.size > this.offset) {
        const length = Math.min(stats.size - this.offset, this.maxReadSize);
        const buffer = Buffer.allocUnsafe(length);
        const bytesRead = fs.readSync(fd, buffer, 0, length, this.offset);
        if (bytesRead > 0) {
          this.offset += bytesRead;
          this.bytesRead += bytesRead;
          this.lastReadAt = Date.now();
          const combined = this.pending.length
            ? Buffer.concat([this.pending, buffer.subarray(0, bytesRead)])
            : buffer.subarray(0, bytesRead);
          const lastLf = combined.lastIndexOf(0x0a);
          if (lastLf >= 0) {
            const complete = combined.subarray(0, lastLf + 1).toString('utf8');
            this.pending = Buffer.from(combined.subarray(lastLf + 1));
            const lines = complete.split('\n');
            lines.pop();
            for (const raw of lines) {
              const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
              this.lastLine = line.slice(0, 1200);
              this.linesRead++;
              const excluded = this.shouldExcludeLine
                ? this.shouldExcludeLine(line) === true
                : (this.excludePattern ? (this.excludePattern.lastIndex = 0, this.excludePattern.test(line)) : false);
              if (excluded) {
                this.filteredLines++;
                continue;
              }
              this.lastLineAt = Date.now();
              this.onLine(line);
            }
          } else {
            this.pending = Buffer.from(combined);
          }
        }
      }
      this.error = null;
    } catch (error) {
      this.error = String(error?.message || error);
      this.onError(error);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      this.busy = false;
      this.publishStatus();
    }
  }

  snapshot() {
    return {
      offset: this.offset, size: this.size, bytesRead: this.bytesRead,
      linesRead: this.linesRead, filteredLines: this.filteredLines,
      pendingBytes: this.pending.length, rotations: this.rotations,
      lastReadAt: this.lastReadAt, lastLineAt: this.lastLineAt,
      lastLine: this.lastLine, error: this.error, running: this.running,
    };
  }

  publishStatus() { this.onStatus(this.snapshot()); }
}

export { BUILTIN_ALLOW_RULES as ETOR_BUILTIN_ALLOW_RULES, BUILTIN_EXCLUDE_TERMS as ETOR_BUILTIN_EXCLUDE_TERMS, shouldExcludeEtorLine };
