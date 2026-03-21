/**
 * 競馬クラスター レース一覧ページ（/top/race-list）のHTMLをパースする。
 * - race-container を data-date / data-venue でフィルタ
 * - race-item から race_id（race-form-(\d+)）, RPT（rpt\d+）, 発走時刻を抽出
 * @see docs/SCRAPING_SPEC.md
 */

const cheerio = require('cheerio');

const RACE_FORM_RE = /race-form-(\d+)/;

/** 日付・会場キーの表記ゆれ（全角半角・空白）を寄せる */
function canonKey(s) {
  return String(s || '')
    .trim()
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

const ALL_RACES_MARKERS = [
  'window.allRaces = ',
  'window.allRaces=',
  'window.allRaces =',
  'allRaces = ',
  'allRaces=',
  'allRaces =',
];

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

/**
 * @param {Record<string, unknown>} row
 */
function rowRpt(row) {
  if (row.rpt == null) return null;
  const n = parseInt(String(row.rpt), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * @param {Record<string, unknown>} row
 */
function rowTime(row) {
  if (!row.time) return undefined;
  const t = String(row.time).trim();
  return t || undefined;
}

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
  let any = false;

  for (const marker of ALL_RACES_MARKERS) {
    let searchFrom = 0;
    while (true) {
      const idx = html.indexOf(marker, searchFrom);
      if (idx === -1) break;
      let i = idx + marker.length;
      while (i < html.length && /\s/.test(html[i])) i += 1;
      const obj = parseJsonObjectAtBrace(html, i);
      if (obj && typeof obj === 'object') {
        any = true;
        for (const d of Object.keys(obj)) {
          const dc = canonKey(d);
          if (!dc) continue;
          const venues = obj[d];
          if (!venues || typeof venues !== 'object') continue;
          if (!merged[dc]) merged[dc] = {};
          for (const v of Object.keys(venues)) {
            const vc = canonKey(v);
            if (!vc) continue;
            const arr = venues[v];
            if (!Array.isArray(arr)) continue;
            if (!merged[dc][vc]) {
              merged[dc][vc] = arr.slice();
            } else {
              merged[dc][vc] = mergeRaceRowsById(merged[dc][vc], arr);
            }
          }
        }
      }
      searchFrom = idx + marker.length;
    }
  }
  return any ? merged : null;
}

/**
 * 指定日の JSON 内の全会場をまとめ、race_id → { rpt, startTime }（会場名がズレても id で補完）
 * @param {Record<string, Record<string, Array<Record<string, unknown>>>> | null} merged
 * @param {string} date - data-date と同じ想定
 */
/**
 * オブジェクト全体のパースに失敗した／欠けるとき、HTML断片から id に対応する rpt を拾う
 * @param {string} html
 * @param {number} raceId
 * @returns {number | null}
 */
function scrapeRptNearIdInHtml(html, raceId) {
  if (!html || !raceId) return null;
  const idRe = new RegExp(`"id"\\s*:\\s*${raceId}\\b`);
  const idMatch = idRe.exec(html);
  if (!idMatch) return null;
  const idx = idMatch.index;
  const slice = html.slice(Math.max(0, idx - 350), Math.min(html.length, idx + 450));
  const m = slice.match(/"rpt"\s*:\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function buildMetaByRaceIdForDate(merged, date) {
  /** @type {Map<number, { rpt?: number, startTime?: string }>} */
  const map = new Map();
  if (!merged) return map;
  const dc = canonKey(date);
  const dateObj = merged[dc];
  if (!dateObj || typeof dateObj !== 'object') return map;

  for (const vk of Object.keys(dateObj)) {
    const list = dateObj[vk];
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      const id = rowRaceId(row);
      if (!id) continue;
      const rpt = rowRpt(row);
      const startTime = rowTime(row);
      const prev = map.get(id);
      map.set(id, {
        rpt: rpt != null ? rpt : prev?.rpt,
        startTime: startTime || prev?.startTime,
      });
    }
  }
  return map;
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
  const dc = canonKey(date);
  const vc = canonKey(venue);

  /** 会場一致の行（正規化キー） */
  /** @type {Map<number, { rpt?: number, startTime?: string }>} */
  const fromJsonVenue = new Map();
  if (allRacesMerged && allRacesMerged[dc] && allRacesMerged[dc][vc]) {
    const list = allRacesMerged[dc][vc];
    if (Array.isArray(list)) {
      for (const row of list) {
        const raceId = rowRaceId(row);
        if (!raceId) continue;
        const rpt = rowRpt(row);
        const startTime = rowTime(row);
        fromJsonVenue.set(raceId, {
          rpt: rpt != null ? rpt : undefined,
          startTime,
        });
      }
    }
  }

  /** その日の全会場まとめ（会場名ズレ・欠落フォールバック） */
  const fromJsonByDay = buildMetaByRaceIdForDate(allRacesMerged, date);

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

      const j = fromJsonVenue.get(raceId) || fromJsonByDay.get(raceId);
      if (j) {
        if (j.rpt != null) rpt = j.rpt;
        if (j.startTime) startTime = j.startTime;
      }
      if (rpt == null) {
        const scraped = scrapeRptNearIdInHtml(html, raceId);
        if (scraped != null) rpt = scraped;
      }

      races.push({ raceId, rpt: rpt ?? undefined, startTime: startTime || undefined });
    });
  });

  // 一覧HTMLに race-container が無い／別レイアウトのとき、マージ済み JSON だけから組み立てる
  if (races.length === 0 && allRacesMerged && allRacesMerged[dc] && allRacesMerged[dc][vc]) {
    const list = allRacesMerged[dc][vc];
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

module.exports = { parseRaceList, listDatesAndVenues, extractAllRacesMergedFromHtml };
