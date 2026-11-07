import fs from 'node:fs';

// Item metadata and image URLs are an offline index assembled from the user's
// supplied Gorn reference archive. Image bytes are not redistributed; the UI
// resolves them lazily from the referenced CDN and caches them locally.
const sourceRows = JSON.parse(fs.readFileSync(new URL('../data/item-catalog.json', import.meta.url), 'utf8'));
// Collapse duplicate ConfigBaseId rows so search results and drop identities stay unique.
const catalog = new Map(sourceRows.map((row) => [Number(row.id), row]));
const rows = [...catalog.values()];

export function getItemInfo(id) { return catalog.get(Number(id)) ?? null; }
export function getItemName(id, language = 'ru') {
  const item = getItemInfo(id);
  if (!item) return id == null ? 'Предмет не распознан' : `Предмет #${id}`;
  if (Number(id) === 100300) return language === 'en' ? 'Flame Elementium (FE)' : 'Элементиевое пламя (FE)';
  if (language === 'en' || !item.nameRu) return item.name || `Item #${id}`;
  return item.nameRu;
}
export function getItemImageUrl(id) { return getItemInfo(id)?.iconUrl ?? null; }
export function searchItems(query, limit = 100) {
  const q = String(query || '').trim().toLocaleLowerCase('ru');
  const list = q ? rows.filter((x) => [x.nameRu, x.name, x.typeRu, x.type, String(x.id)].some((v) => String(v || '').toLocaleLowerCase('ru').includes(q))) : rows;
  return list.slice(0, Math.max(1, Math.min(500, Number(limit) || 100))).map((x) => ({
    id: Number(x.id), name: x.nameRu || x.name || `Предмет #${x.id}`, nameEn: x.name,
    type: x.typeRu || x.type || 'Предмет', iconUrl: x.iconUrl || null,
  }));
}
export function getItemCatalogSize() { return catalog.size; }
