// UE log -> structured messages.
//
// VERIFIED against a real UE_game log (Nov 2026 build) and ETor v1.0.6 sources:
//  * header : "[ts][frame]<Category>: Display: [Game] ----Socket <Kind> STT----<Action>----SynId = N"
//             Kind = SendMessage|PushMessage|RecvMessage|RecvPushMsg. <Category> is NOT fixed: the current build
//             writes "TLNetGame" (ETor 1.0.6 only accepts the older "GameLog"), so we match on the message part only.
//  * body   : raw lines WITHOUT timestamps ("+a+b+c [value]"), the first one follows an empty timestamped line
//  * end    : "----Socket <Kind> End----"
//  * pipes  : each leading "|" stands for the previous line's N-th non-leaf key (same rule as ETor parseTorchlightData)
// Anything not understood is kept raw, never dropped silently.

const TS = /^\[([^\]]+)\]/;
const KINDS = 'SendMessage|PushMessage|RecvMessage|RecvPushMsg';
// ETor detects message boundaries on the raw line, not only on timestamped lines.
const HEADER = new RegExp(`\\b(${KINDS})\\s+STT-+([^-\\r\\n]+?)-+SynId\\s*=\\s*(\\d*)`, 'i');
const END = new RegExp(`\\b(${KINDS})\\s+End\\b`, 'i');
export const MAX_BODY_LINES = 5000;

/** UE timestamp -> epoch ms. ASSUMPTION: bracket timestamps are UTC (verify against your local clock). */
export function parseUeTimestamp(s) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{1,3})$/.exec(s || '');
  if (!m) return null;
  return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7].padEnd(3, '0'));
}

/** Streaming assembler. feed() arbitrary text chunks (partial lines are buffered); complete messages go to the callback. */
export class MessageAssembler {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.rest = '';
    this.cur = null;
    this.stats = { lines: 0, messages: 0, truncated: 0, skippedGameLogLines: 0, skippedErrorLines: 0 };
  }
  feed(chunk) {
    const lines = (this.rest + chunk).split('\n');
    this.rest = lines.pop();
    for (const line of lines) this.#line(line.replace(/\r$/, ''));
  }
  flush() {
    if (this.rest) { this.#line(this.rest.replace(/\r$/, '')); this.rest = ''; }
    this.#close(true);
  }
  #close(truncated) {
    if (!this.cur) return;
    this.stats.messages++;
    if (truncated) this.stats.truncated++;
    const message = { ...this.cur, truncated };
    this.cur = null;
    this.onMessage(message);
  }
  #line(line) {
    this.stats.lines++;
    const header = HEADER.exec(line);
    if (header && TS.test(line)) {
      this.#close(true); // ETor also treats a new STT as the end of an incomplete previous envelope.
      const timestamp = TS.exec(line)?.[1] || '';
      this.cur = { time: timestamp, kind: header[1], action: header[2].trim(), synId: header[3], body: [] };
      return;
    }

    // ETor recognizes End anywhere on the line; requiring a timestamp here lost valid packets.
    if (END.test(line)) {
      this.#close(false);
      return;
    }

    if (!this.cur) return;
    if (/errCode/i.test(line)) { this.stats.skippedErrorLines++; return; }

    // Match ETor's intent: GameLog envelopes are not payload. Some newer builds
    // prefix actual tree rows with another timestamp/category; retain their payload
    // after stripping the wrapper, but do not pollute the tree with unrelated logs.
    if (TS.test(line)) {
      const wrapped = /^\[[^\]]+\]\[[^\]]+\][^:]*:\s*Display:\s*\[Game\]\s*(.*)$/i.exec(line);
      if (wrapped && /^[+|]/.test(wrapped[1].trim())) {
        this.cur.body.push(wrapped[1].trim());
      } else if (/^\[[^\]]+\].*\bGameLog\b/i.test(line)) {
        this.stats.skippedGameLogLines++;
      }
      return;
    }

    if (this.cur.body.length >= MAX_BODY_LINES) { this.#close(true); return; }
    this.cur.body.push(line);
  }
}

// ---- tree parser -------------------------------------------------------------------------

/** Split on '+' at bracket depth 0 only (values may contain '+', e.g. "[+5%]"). */
function splitTop(line) {
  const out = []; let depth = 0, buf = '';
  for (const c of line) {
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    if (c === '+' && depth === 0) { out.push(buf); buf = ''; } else buf += c;
  }
  out.push(buf);
  return out;
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function put(node, k, v) {
  if (!(k in node)) { node[k] = v; return; }
  const cur = node[k];
  node[k] = Array.isArray(cur) ? [...cur, v] : [cur, v]; // plain duplicates never overwrite
}
function childOf(node, k) {
  let cur = node[k];
  if (Array.isArray(cur)) cur = cur[cur.length - 1];
  if (cur && typeof cur === 'object') return cur;
  const o = {};
  if (typeof cur === 'string') o._value = cur;
  node[k] = o;
  return o;
}

export function parseTree(lines) {
  const root = {};
  let prevAncestors = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || (line[0] !== '+' && line[0] !== '|')) continue;
    const path = []; let pipe = 0;
    for (let seg of splitTop(line)) {
      seg = seg.trim();
      while (seg.startsWith('|')) { path.push({ key: prevAncestors[pipe++] ?? '?' }); seg = seg.slice(1).trim(); }
      if (!seg) continue;
      const i = seg.indexOf('[');
      if (i > 0 && seg.endsWith(']')) path.push({ key: seg.slice(0, i).trim(), value: seg.slice(i + 1, -1) });
      else path.push({ key: seg });
    }
    let node = root; const anc = [];
    path.forEach((p, idx) => {
      const last = idx === path.length - 1;
      if (last && p.value !== undefined) put(node, p.key, p.value.trim());
      else { node = childOf(node, p.key); anc.push(p.key); }
    });
    prevAncestors = anc;
  }
  return root;
}

/** Depth-first walk yielding every plain object with its key path. */
export function* walkObjects(tree, path = []) {
  if (Array.isArray(tree)) { for (let i = 0; i < tree.length; i++) yield* walkObjects(tree[i], path); return; }
  if (!tree || typeof tree !== 'object') return;
  yield { node: tree, path };
  for (const [k, v] of Object.entries(tree)) yield* walkObjects(v, [...path, k]);
}
