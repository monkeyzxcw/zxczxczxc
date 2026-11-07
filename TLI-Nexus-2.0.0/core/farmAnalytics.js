export function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values, fraction) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const pos = Math.max(0, Math.min(1, Number(fraction) || 0)) * (sorted.length - 1);
  const low = Math.floor(pos), high = Math.ceil(pos);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
}

export function sessionProfit(session = {}) {
  return (Number(session.lootValueFe) || 0) - (Number(session.costsFe) || 0);
}

export function sessionRate(session = {}) {
  const seconds = Number(session.durationSec);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return sessionProfit(session) / (seconds / 3600);
}

function summarizeGroup(name, rows) {
  const rates = rows.map(sessionRate).filter((value) => value !== null && Number.isFinite(value));
  const profits = rows.map(sessionProfit);
  if (!rates.length) return null;
  const mean = rates.reduce((sum, value) => sum + value, 0) / rates.length;
  const variance = rates.reduce((sum, value) => sum + (value - mean) ** 2, 0) / rates.length;
  const deviation = Math.sqrt(variance);
  const cv = Math.abs(mean) > 0.000001 ? deviation / Math.abs(mean) * 100 : null;
  const rateMedian = median(rates);
  const medianAbsoluteDeviation = median(rates.map((value) => Math.abs(value - rateMedian)));
  const count = rates.length;
  const profitable = profits.filter((value) => value > 0).length;
  const variability = count < 3 ? 'Мало данных' : cv === null ? 'Не рассчитывается' : cv < 20 ? 'Стабильно' : cv < 50 ? 'Средняя вариативность' : 'Нестабильно';
  return {
    name, sessions: count,
    medianFePerHour: rateMedian, meanFePerHour: mean,
    p25FePerHour: percentile(rates, 0.25), p75FePerHour: percentile(rates, 0.75),
    standardDeviation: deviation, medianAbsoluteDeviation, coefficientOfVariation: cv, variability,
    profitableSessions: profitable, profitablePercent: count ? profitable / count * 100 : null,
    bestFePerHour: Math.max(...rates), worstFePerHour: Math.min(...rates),
    medianNetFe: median(profits), totalNetFe: profits.reduce((sum, value) => sum + value, 0), rates,
  };
}

/** Robust summaries; a strategy is ranked only after at least 3 valid sessions. */
export function analyzeFarmingSessions(sessions = [], { profileId = null, strategy = null, since = null } = {}) {
  const source = Array.isArray(sessions) ? sessions : [];
  const filtered = source.filter((row) => {
    if (profileId && row.profileId !== profileId) return false;
    if (strategy && String(row.strategy || row.area || 'Без названия') !== strategy) return false;
    if (since && Number(row.startedAt || 0) < since) return false;
    return true;
  });
  const valid = filtered.filter((row) => sessionRate(row) !== null && !(row.source === 'live' && !row.endedAt));
  const overall = summarizeGroup('Все сессии', valid);
  const groups = new Map();
  for (const row of valid) {
    const name = String(row.strategy || row.area || 'Без названия').trim() || 'Без названия';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  const strategies = [...groups.entries()].map(([name, rows]) => summarizeGroup(name, rows)).filter(Boolean)
    .sort((a, b) => b.medianFePerHour - a.medianFePerHour);
  const ranked = strategies.filter((row) => row.sessions >= 3);
  const topStrategy = ranked[0] || null;
  return {
    sessionCount: valid.length,
    totalSeconds: valid.reduce((sum, row) => sum + Number(row.durationSec), 0),
    totalNetFe: valid.reduce((sum, row) => sum + sessionProfit(row), 0),
    overall, strategies, topStrategy,
    recentRates: valid.slice().sort((a, b) => Number(a.startedAt || 0) - Number(b.startedAt || 0)).slice(-30).map((row) => ({
      startedAt: Number(row.startedAt) || null, name: String(row.strategy || row.area || 'Без названия'),
      profileId: row.profileId || null, netFe: sessionProfit(row), fePerHour: sessionRate(row),
    })),
    note: 'Сравнение по медиане FE/ч, P25–P75, MAD и доле прибыльных сессий. Уверенный рейтинг стратегии появляется минимум после 3 завершённых сессий; это история собственных результатов, не прогноз гарантированного дохода.',
  };
}
