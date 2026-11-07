const DEFAULT_BASE_URL = 'http://127.0.0.1:8765';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

const ALLOWED_KEYS = new Set([
  'slots', 'slates', 'prisms', 'condition_state', 'gear', 'character',
  'memory_effects', 'spirit_effects', 'main_skill', 'skills', 'invalid_slots',
  'custom_mods', 'attached_supports', 'characterLevel', 'trait_effects',
  'trait_id', 'trait_slot_levels', 'advanced_trait_selections',
  'licorice_prepared_skill', 'elixir_ingredients', 'uptime_mode',
  'target_config', 'enemy_config',
]);

function getBaseUrl() {
  const raw = process.env.TLI_BUILDER_URL || DEFAULT_BASE_URL;
  const url = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'http:' || !loopback || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('TLIBuilder должен быть доступен только через локальный HTTP loopback-адрес.');
  }
  return url.origin;
}

async function requestJson(path, options = {}) {
  const url = getBaseUrl() + path;
  const response = await fetch(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.slice(0, 1200);
    try {
      const parsed = JSON.parse(text);
      detail = parsed.detail?.message || parsed.detail || parsed.message || detail;
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch {}
    throw new Error(`TLIBuilder вернул HTTP ${response.status}: ${detail}`);
  }
  try { return text ? JSON.parse(text) : null; }
  catch { throw new Error('TLIBuilder вернул некорректный JSON.'); }
}

export async function getTliBuilderStatus() {
  try {
    const conditions = await requestJson('/api/conditions');
    return {
      connected: true,
      endpoint: getBaseUrl(),
      conditionsAvailable: Boolean(conditions && typeof conditions === 'object'),
      conditionCategories: conditions && typeof conditions === 'object' ? Object.keys(conditions).length : 0,
      engineEndpoint: '/api/engine/stats',
      message: 'Локальный движок TLIBuilder доступен.',
    };
  } catch (error) {
    return {
      connected: false,
      endpoint: (() => { try { return getBaseUrl(); } catch { return DEFAULT_BASE_URL; } })(),
      conditionsAvailable: false,
      conditionCategories: 0,
      engineEndpoint: '/api/engine/stats',
      message: String(error?.message || error).slice(0, 500),
    };
  }
}

export async function calculateWithTliBuilder(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Ожидается объект билда для TLIBuilder.');
  }
  const payload = {};
  for (const [key, value] of Object.entries(input)) {
    if (ALLOWED_KEYS.has(key)) payload[key] = value;
  }
  if (!Array.isArray(payload.slots)) {
    throw new Error('Для расчёта необходимы slots — выбранные деревья и активные узлы.');
  }
  if (payload.slots.length > 12) throw new Error('Слишком много слотов дерева.');
  if (Array.isArray(payload.gear) && payload.gear.length > 40) throw new Error('Слишком много предметов в билде.');
  if (Array.isArray(payload.skills) && payload.skills.length > 40) throw new Error('Слишком много навыков в билде.');
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    throw new Error('Данные билда превышают лимит 2 МБ.');
  }
  return requestJson('/api/engine/stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}
