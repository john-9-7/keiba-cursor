/**
 * レース一覧HTML（allRaces 埋め込み ＋ DOM .race-container）から、日付×会場ごとに
 * 「現在時刻に最も近い発走」のレースを1件ずつ選ぶ。
 */

const cheerio = require('cheerio');
const { extractAllRacesMergedFromHtml } = require('./parseRaceList');

const RACE_FORM_RE = /race-form-(\d+)/;

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
  if (!row) return null;
  const t = row.time != null ? row.time : row.startTime;
  if (t == null) return null;
  const s = String(t).trim();
  return s || null;
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
  m = c.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日?/);
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
  const rawKeys = Object.keys(merged).filter(
    (k) => merged[k] && typeof merged[k] === 'object' && Object.keys(merged[k]).length > 0,
  );
  if (rawKeys.length === 0) return null;

  const pairs = rawKeys
    .map((raw) => ({ raw, norm: normalizeToYmd(raw) }))
    .filter((x) => x.norm);
  if (pairs.length > 0) {
    pairs.sort((a, b) => a.norm.localeCompare(b.norm));
    const exact = pairs.find((x) => x.norm === today);
    if (exact) return exact.raw;
    const future = pairs.find((x) => x.norm > today);
    if (future) return future.raw;
    return pairs[pairs.length - 1].raw;
  }

  rawKeys.sort((a, b) => a.localeCompare(b));
  const sub = rawKeys.find((k) => k.includes(today)) || rawKeys.find((k) => k >= today) || rawKeys[rawKeys.length - 1];
  return sub || null;
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

/** 同じ race id の行をマージ（後勝ち） */
function mergeVenueRows(a, b) {
  const byId = new Map();
  for (const row of a || []) {
    const id = rowRaceId(row);
    if (id) byId.set(id, { ...row });
  }
  for (const row of b || []) {
    const id = rowRaceId(row);
    if (!id) continue;
    const prev = byId.get(id);
    byId.set(id, prev ? { ...prev, ...row } : { ...row });
  }
  return [...byId.values()].sort((x, y) => (Number(x.number) || 0) - (Number(y.number) || 0));
}

/**
 * HTML の .race-container から一覧を組み立て（allRaces が無い／パース失敗時用）
 * @param {string} html
 * @returns {Record<string, Record<string, unknown[]>> | null}
 */
function buildMergedFromDom(html) {
  if (!html || typeof html !== 'string') return null;
  const $ = cheerio.load(html);
  const merged = {};
  $('.race-container').each((_, container) => {
    const $c = $(container);
    const dRaw = ($c.attr('data-date') || '').trim();
    const vRaw = ($c.attr('data-venue') || '').trim();
    if (!dRaw || !vRaw) return;
    const dk = normalizeToYmd(dRaw) || canonKey(dRaw);
    const vk = canonKey(vRaw);
    if (!merged[dk]) merged[dk] = {};
    if (!merged[dk][vk]) merged[dk][vk] = [];

    $c.find('a.race-item, .race-item a, .race-item').each((_, item) => {
      const $a = $(item);
      let raceId = null;
      const onclick = $a.attr('onclick') || '';
      const om = onclick.match(RACE_FORM_RE);
      if (om) raceId = parseInt(om[1], 10);
      if (!raceId || Number.isNaN(raceId)) {
        const href = $a.attr('href') || '';
        const hm = href.match(/race_id=(\d+)/i);
        if (hm) raceId = parseInt(hm[1], 10);
      }
      if (!raceId || Number.isNaN(raceId)) {
        const dr = $a.attr('data-race-id');
        if (dr) raceId = parseInt(String(dr), 10);
      }
      if (!raceId || Number.isNaN(raceId)) return;

      let rpt = null;
      for (const cls of ($a.attr('class') || '').split(/\s+/)) {
        const m = cls.match(/^rpt(\d+)$/i);
        if (m) {
          rpt = parseInt(m[1], 10);
          break;
        }
      }

      let startTime = null;
      const raceInfoText = $a.find('.race-info').text() || '';
      const allText = $a.text() || '';
      const timeMatch =
        raceInfoText.match(/\d{1,2}:\d{2}/) || allText.match(/\d{1,2}:\d{2}/);
      if (timeMatch) startTime = timeMatch[0];

      merged[dk][vk].push({ id: raceId, time: startTime, rpt });
    });
  });

  const hasVenue = Object.values(merged).some((day) => day && Object.keys(day).length > 0);
  return hasVenue ? merged : null;
}

function mergeJsonAndDom(jsonMerged, domMerged) {
  const j = jsonMerged && typeof jsonMerged === 'object' && Object.keys(jsonMerged).length ? jsonMerged : null;
  const d = domMerged && typeof domMerged === 'object' && Object.keys(domMerged).length ? domMerged : null;
  if (!j && !d) return null;
  if (!j) return d;
  if (!d) return j;
  const out = {};
  const dates = new Set([...Object.keys(j), ...Object.keys(d)]);
  for (const dk of dates) {
    const jDay = j[dk] || {};
    const dDay = d[dk] || {};
    out[dk] = {};
    const venues = new Set([...Object.keys(jDay), ...Object.keys(dDay)]);
    for (const vk of venues) {
      out[dk][vk] = mergeVenueRows(jDay[vk], dDay[vk]);
    }
  }
  return out;
}

/** トップレベル日付キーを YYYY-MM-DD に寄せ、同一日のブロックを統合 */
function normalizeMergedDateKeys(merged) {
  if (!merged || typeof merged !== 'object') return null;
  const out = {};
  for (const [dk, venues] of Object.entries(merged)) {
    if (!venues || typeof venues !== 'object') continue;
    const nk = normalizeToYmd(dk) || dk;
    if (!out[nk]) out[nk] = {};
    for (const [vk, rows] of Object.entries(venues)) {
      if (!Array.isArray(rows)) continue;
      if (!out[nk][vk]) out[nk][vk] = [];
      out[nk][vk] = mergeVenueRows(out[nk][vk], rows);
    }
  }
  return Object.keys(out).length ? out : null;
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
  if (best) return best;
  const withId = rows
    .filter((r) => rowRaceId(r))
    .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
  if (withId.length === 0) return null;
  return withId[Math.floor(withId.length / 2)];
}

/**
 * @param {string} html - race-list ページHTML
 * @param {Date} [now]
 * @returns {{ date: string, dateNorm: string, picks: Array<{ venue: string, raceId: number, rpt: number | null, startTime: string | null, raceNumber: number | null, deltaMinutes: number }> }}
 */
function pickDashboardRacesFromListHtml(html, now = new Date()) {
  const jsonMerged = extractAllRacesMergedFromHtml(html);
  const domMerged = buildMergedFromDom(html);
  const combined = mergeJsonAndDom(
    jsonMerged && typeof jsonMerged === 'object' ? jsonMerged : null,
    domMerged,
  );
  const merged = normalizeMergedDateKeys(combined);
  if (!merged || typeof merged !== 'object' || Object.keys(merged).length === 0) {
    return { date: '', dateNorm: '', picks: [] };
  }

  const dateRaw = pickDateKeyFromMerged(merged, now);
  if (!dateRaw) {
    return { date: '', dateNorm: '', picks: [] };
  }
  let dateNorm = normalizeToYmd(dateRaw) || '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateNorm)) {
    dateNorm = jstYmd(now);
  }

  const day = merged[dateRaw];
  if (!day || typeof day !== 'object') {
    return { date: dateRaw, dateNorm, picks: [] };
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

module.exports = {
  pickDashboardRacesFromListHtml,
  jstYmd,
  pickDateKeyFromMerged,
  buildMergedFromDom,
  normalizeMergedDateKeys,
};
