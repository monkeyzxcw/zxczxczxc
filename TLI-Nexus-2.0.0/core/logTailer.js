import fs from 'node:fs';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

// Fingerprint of the first 256 bytes; empty until the file has that many (so growth of a tiny file is not mistaken for replacement).
const headHash = (fd, size) => {
  const n = 256; if (size < n) return '';
  const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, 0);
  return crypto.createHash('sha1').update(b).digest('hex');
};

/**
 * Read-only tail of a growing file. Never writes to or locks the game's log (opens with 'r').
 *  - start: 'end' (live, default) | 'begin' (import whole file) | {offset, headHash} (resume)
 *  - detects truncation / replacement (size shrinks or head changes) and restarts from 0
 *  - decodes UTF-8 across chunk boundaries
 * onChunk(text) is called with new text; checkpoint() returns state to persist.
 */
export class LogTailer {
  constructor(file, { onChunk, onReset = () => {}, onError = () => {}, intervalMs = 500, chunkBytes = 1 << 20, start = 'end' } = {}) {
    Object.assign(this, { file, onChunk, onReset, onError, intervalMs, chunkBytes });
    this.offset = 0; this.hash = ''; this.timer = null; this.decoder = new StringDecoder('utf8'); this.startSpec = start; this.initialised = false; this.busy = false;
  }
  checkpoint() { return { offset: this.offset, headHash: this.hash }; }
  start() { this.poll(); this.timer = setInterval(() => this.poll(), this.intervalMs); return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
  poll() {
    if (this.busy) return; this.busy = true;
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
      const size = fs.fstatSync(fd).size;
      const h = headHash(fd, size);
      if (!this.initialised) {
        this.initialised = true;
        const s = this.startSpec;
        if (s === 'begin') this.offset = 0;
        else if (s && typeof s === 'object') this.offset = (s.headHash === h || !s.headHash) && s.offset <= size ? s.offset : 0;
        else this.offset = size;
        this.hash = h;
      } else if (size < this.offset || (this.hash && h && h !== this.hash)) {
        this.offset = 0; this.hash = h; this.decoder = new StringDecoder('utf8'); this.onChunk('\n'); this.onReset(); // file rotated or truncated
      } else if (!this.hash && h) this.hash = h;
      while (this.offset < size) {
        const len = Math.min(this.chunkBytes, size - this.offset);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, this.offset);
        if (n <= 0) break;
        this.offset += n;
        const text = this.decoder.write(buf.subarray(0, n));
        if (text) this.onChunk(text);
      }
    } catch (e) { if (e.code !== 'ENOENT') this.onError(e); }
    finally { if (fd !== undefined) fs.closeSync(fd); this.busy = false; }
  }
}
