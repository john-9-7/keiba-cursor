/**
 * レース一覧HTML（allRaces 埋め込み）から、日付×会場ごとに
 * 「現在時刻に最も近い発走」のレースを1件ずつ選ぶ。
 */

const { extractAllRacesMergedFromHtml } = require('./parseRaceList');

function canonKey(s) {
  return String(s || '')
    .trim()
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

/**
 * @param {Record<string, unknown>} row
 * @returns {number | null}
 */
function rowRaceId(row) {
  if (!row || typeof row !== 'object') return null;
  const v = row.id ?? row.race_id ?? row.raceId;
  if (v == null) return null;
  const n = parseInt(String(v), 10);
  return Number.isNaN(n) || n < 1 ? null : n;
}

function rowTime(row) {
  if (!row || row.time == null) return null;
  const t = String(row.time).trim();
  return t || null;
}

function rowRpt(row) {
  if (row.rpt == null) return null;
  const n = parseInt(String(row.rpt), 10);
  return Number.isNaN(n) ? null : n;
}

function rowRaceNumber(row) {
  if (row.number == null) return null;
  const n = parseInt(String(row.number), 10);
  return Number.isNaN(n) || n < 1 ? null : n;
}

/** JST の今日 YYYY-MM-DD */
function jstYmd(now = new Date()) {
  return new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/** 一覧JSONの日付キーを YYYY-MM-DD に寄せる（取れなければ null） */
function normalizeToYmd(key) {
  const c = String(key || '')
    .trim()
    .normalize('NFKC')
    .replace(/\s+/g, '');
  let m = c.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = c.match(/^(\d{4})[./](\d{1,2})[./](\d{1,2})/);
  if (m) {
    return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  }
  return null;
}

/**
 * merged の実キーから、使う日付ブロックを選ぶ（今日→以降の最古→直近の過去）
 * @returns {string | null} merged 上の実キー
 */
function pickDateKeyFromMerged(merged, now = new Date()) {
  const today = jstYmd(now);
  const pairs = Object.keys(merged)
    .map((raw) => ({ raw, norm: normalizeToYmd(raw) }))
    .filter((x) => x.norm);
  if (pairs.length === 0) return null;
  pairs.sort((a, b) => a.norm.localeCompare(b.norm));
  const exact = pairs.find((x) => x.norm === today);
  if (exact) return exact.raw;
  const future = pairs.find((x) => x.norm > today);
  if (future) return future.raw;
  return pairs[pairs.length - 1].raw;
}

/**
 * dateNorm: YYYY-MM-DD
 * timeStr: "10:05" など
 * @returns {number | null} UTC ms
 */
function startTimeToUtcMs(dateNorm, timeStr) {
  const dm = String(dateNorm).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return null;
  const y = parseInt(dm[1], 10);
  const mo = parseInt(dm[2], 10);
  const d = parseInt(dm[3], 10);
  const tm = String(timeStr || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!tm) return null;
  const hh = parseInt(tm[1], 10);
  const mm = parseInt(tm[2], 10);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return Date.UTC(y, mo - 1, d, hh - 9, mm, 0, 0);
}

/**
 * 同じ差なら「これから発走」側を優先
 * @param {unknown[]} rows
 * @param {string} dateNorm YYYY-MM-DD
 * @param {number} nowMs
 */
function pickNearestRowForVenue(rows, dateNorm, nowMs) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let best = null;
  let bestAbs = Infinity;
  for (const row of rows) {
    const id = rowRaceId(row);
    if (!id) continue;
    const t = rowTime(row);
    const ms = startTimeToUtcMs(dateNorm, t);
    if (ms == null) continue;
    const abs = Math.abs(ms - nowMs);
    if (abs < bestAbs) {
      bestAbs = abs;
      best = row;
    } else if (abs === bestAbs && best) {
      const bms = startTimeToUtcMs(dateNorm, rowTime(best));
      if (bms != null && ms >= nowMs && bms < nowMs) best = row;
    }
  }
  return best;
}

/**
 * @param {string} html - race-list ページHTML
 * @param {Date} [now]
 * @returns {{ date: string, dateNorm: string, picks: Array<{ venue: string, raceId: number, rpt: number | null, startTime: string | null, raceNumber: number | null, deltaMinutes: number }> }}
 */
function pickDashboardRacesFromListHtml(html, now = new Date()) {
  const merged = extractAllRacesMergedFromHtml(html);
  if (!merged || typeof merged !== 'object') {
    return { date: '', dateNorm: '', picks: [] };
  }
  const dateRaw = pickDateKeyFromMerged(merged, now);
  if (!dateRaw) {
    return { date: '', dateNorm: '', picks: [] };
  }
  const dateNorm = normalizeToYmd(dateRaw) || '';
  const day = merged[dateRaw];
  if (!day || typeof day !== 'object') {
    return { date: dateRaw, dateNorm, picks: [] };
  }
  if (!dateNorm) {
    return { date: dateRaw, dateNorm: '', picks: [] };
  }

  const nowMs = now.getTime();
  /** @type {Array<{ venue: string, raceId: number, rpt: number | null, startTime: string | null, raceNumber: number | null, deltaMinutes: number }>} */
  const picks = [];

  const venues = Object.keys(day).sort((a, b) => a.localeCompare(b, 'ja'));
  for (const venue of venues) {
    const list = day[venue];
    if (!Array.isArray(list)) continue;
    const row = pickNearestRowForVenue(list, dateNorm, nowMs);
    if (!row) continue;
    const raceId = rowRaceId(row);
    if (!raceId) continue;
    const startTime = rowTime(row);
    const ms = startTimeToUtcMs(dateNorm, startTime);
    const deltaMinutes = ms != null ? Math.round(Math.abs(ms - nowMs) / 60000) : 0;
    picks.push({
      venue,
      raceId,
      rpt: rowRpt(row),
      startTime,
      raceNumber: rowRaceNumber(row),
      deltaMinutes,
    });
  }

  return { date: dateRaw, dateNorm, picks };
}

module.exports = { pickDashboardRacesFromListHtml, jstYmd, pickDateKeyFromMerged };
