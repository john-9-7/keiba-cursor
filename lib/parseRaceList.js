/**
 * 競馬クラスター レース一覧ページ（/top/race-list）のHTMLをパースする。
 * - race-container を data-date / data-venue でフィルタ
 * - race-item から race_id（race-form-(\d+)）, RPT（rpt\d+）, 発走時刻を抽出
 * @see docs/SCRAPING_SPEC.md
 */

const cheerio = require('cheerio');

const RACE_FORM_RE = /race-form-(\d+)/;
const ALL_RACES_MARKER = 'window.allRaces = ';

/**
 * `{` から対応する `}` までを走査して JSON オブジェクト文字列を切り出す
 * @param {string} html
 * @param {number} braceStart - `{` のインデックス
 * @returns {object | null}
 */
function parseJsonObjectAtBrace(html, braceStart) {
  if (html[braceStart] !== '{') return null;
  let depth = 0;
  const start = braceStart;
  for (let i = braceStart; i < html.length; i += 1) {
    const c = html[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * HTML 内の `window.allRaces =` が複数ある。後ろの代入だけ読むと当日分の RPT が欠けるため、
 * 出現箇所すべてをパースして日付・会場ごとにマージする。
 * @param {string} html
 * @returns {Record<string, Record<string, Array<Record<string, unknown>>>> | null}
 */
function extractAllRacesMergedFromHtml(html) {
  if (!html || typeof html !== 'string') return null;
  /** @type {Record<string, Record<string, Array<Record<string, unknown>>>>} */
  const merged = {};
  let searchFrom = 0;
  let any = false;
  while (true) {
    const idx = html.indexOf(ALL_RACES_MARKER, searchFrom);
    if (idx === -1) break;
    let i = idx + ALL_RACES_MARKER.length;
    while (i < html.length && /\s/.test(html[i])) i += 1;
    const obj = parseJsonObjectAtBrace(html, i);
    if (obj && typeof obj === 'object') {
      any = true;
      for (const d of Object.keys(obj)) {
        const venues = obj[d];
        if (!venues || typeof venues !== 'object') continue;
        if (!merged[d]) merged[d] = {};
        for (const v of Object.keys(venues)) {
          const arr = venues[v];
          if (!Array.isArray(arr)) continue;
          if (!merged[d][v]) {
            merged[d][v] = arr.slice();
          } else {
            merged[d][v] = mergeRaceRowsById(merged[d][v], arr);
          }
        }
      }
    }
    searchFrom = idx + ALL_RACES_MARKER.length;
  }
  return any ? merged : null;
}

/**
 * 同じ race id の行を統合（後から来た行で rpt 等を上書き）
 * @param {Array<Record<string, unknown>>} a
 * @param {Array<Record<string, unknown>>} b
 */
function mergeRaceRowsById(a, b) {
  const byId = new Map();
  for (const row of a) {
    if (row && row.id != null) byId.set(Number(row.id), { ...row });
  }
  for (const row of b) {
    if (!row || row.id == null) continue;
    const id = Number(row.id);
    const prev = byId.get(id);
    if (!prev) byId.set(id, { ...row });
    else {
      byId.set(id, { ...prev, ...row });
    }
  }
  return Array.from(byId.values()).sort((x, y) => {
    const nx = Number(x.number) || 0;
    const ny = Number(y.number) || 0;
    return nx - ny;
  });
}

/**
 * レース一覧HTMLから、指定日付・会場のレース一覧を抽出する。
 * @param {string} html - race-list ページのHTML
 * @param {string} date - 日付 "2026-03-15" 形式
 * @param {string} venue - 会場 "中山" | "中京" | "阪神" など
 * @returns {{ ok: boolean, races?: Array<{ raceId: number, rpt?: number, startTime?: string }>, error?: string }}
 */
function parseRaceList(html, date, venue) {
  if (!html || typeof html !== 'string') {
    return { ok: false, error: 'HTMLがありません。' };
  }
  if (!date || !venue) {
    return { ok: false, error: 'date と venue を指定してください。' };
  }

  const allRacesMerged = extractAllRacesMergedFromHtml(html);
  /** @type {Map<number, { rpt?: number, startTime?: string }>} */
  const fromJson = new Map();
  if (allRacesMerged && allRacesMerged[date] && allRacesMerged[date][venue]) {
    const list = allRacesMerged[date][venue];
    if (Array.isArray(list)) {
      for (const row of list) {
        if (!row || row.id == null) continue;
        const raceId = parseInt(String(row.id), 10);
        if (Number.isNaN(raceId) || raceId < 1) continue;
        const rpt = row.rpt != null ? parseInt(String(row.rpt), 10) : NaN;
        const startTime = row.time && String(row.time).trim() ? String(row.time).trim() : undefined;
        fromJson.set(raceId, {
          rpt: !Number.isNaN(rpt) ? rpt : undefined,
          startTime,
        });
      }
    }
  }

  const $ = cheerio.load(html);
  const races = [];

  // data-date と data-venue が完全一致する race-container だけを対象にする
  $('.race-container').each((_, container) => {
    const $c = $(container);
    const d = ($c.attr('data-date') || '').trim();
    const v = ($c.attr('data-venue') || '').trim();
    if (d !== date || v !== venue) return;

    $c.find('a.race-item').each((_, item) => {
      const $a = $(item);
      const onclick = $a.attr('onclick') || '';
      const match = onclick.match(RACE_FORM_RE);
      const raceId = match ? parseInt(match[1], 10) : null;
      if (!raceId) return;

      let rpt = null;
      const classes = ($a.attr('class') || '').split(/\s+/);
      for (const cls of classes) {
        const m = cls.match(/^rpt(\d+)$/i);
        if (m) {
          rpt = parseInt(m[1], 10);
          break;
        }
      }

      let startTime = null;
      const raceInfoText = $a.find('.race-info').text() || '';
      const timeMatch = raceInfoText.match(/\d{1,2}:\d{2}/);
      if (timeMatch) startTime = timeMatch[0];

      const j = fromJson.get(raceId);
      if (j) {
        if (j.rpt != null) rpt = j.rpt;
        if (j.startTime) startTime = j.startTime;
      }

      races.push({ raceId, rpt: rpt ?? undefined, startTime: startTime || undefined });
    });
  });

  // 一覧HTMLに race-container が無い／別レイアウトのとき、マージ済み JSON だけから組み立てる
  if (races.length === 0 && allRacesMerged && allRacesMerged[date] && allRacesMerged[date][venue]) {
    const list = allRacesMerged[date][venue];
    if (Array.isArray(list) && list.length > 0) {
      for (const row of list) {
        const raceId = row.id != null ? parseInt(String(row.id), 10) : NaN;
        if (Number.isNaN(raceId) || raceId < 1) continue;
        const rpt = row.rpt != null ? parseInt(String(row.rpt), 10) : NaN;
        const startTime = row.time && String(row.time).trim() ? String(row.time).trim() : undefined;
        races.push({
          raceId,
          rpt: !Number.isNaN(rpt) ? rpt : undefined,
          startTime,
        });
      }
    }
  }

  return { ok: true, races };
}

/**
 * 日付・会場を指定せず、HTML内の全 race-container の日付・会場一覧を返す。
 * @param {string} html - race-list ページのHTML
 * @returns {{ ok: boolean, items?: Array<{ date: string, venue: string }>, error?: string }}
 */
function listDatesAndVenues(html) {
  if (!html || typeof html !== 'string') {
    return { ok: false, error: 'HTMLがありません。' };
  }
  const $ = cheerio.load(html);
  const seen = new Set();
  const items = [];
  $('.race-container').each((_, container) => {
    const $c = $(container);
    const date = ($c.attr('data-date') || '').trim();
    const venue = ($c.attr('data-venue') || '').trim();
    if (!date || !venue) return;
    const key = `${date}\t${venue}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ date, venue });
  });
  return { ok: true, items };
}

module.exports = { parseRaceList, listDatesAndVenues };
