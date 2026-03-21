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
 * race-list HTML 内の window.allRaces = {...} を取り出してパースする（RPT・id が確実）
 * @param {string} html
 * @returns {Record<string, Record<string, Array<{ id?: number, rpt?: number, time?: string }>>> | null}
 */
function extractAllRacesFromHtml(html) {
  if (!html || typeof html !== 'string') return null;
  const idx = html.lastIndexOf(ALL_RACES_MARKER);
  if (idx === -1) return null;
  let i = idx + ALL_RACES_MARKER.length;
  while (i < html.length && /\s/.test(html[i])) i += 1;
  if (html[i] !== '{') return null;
  let depth = 0;
  const start = i;
  for (; i < html.length; i += 1) {
    const c = html[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        const jsonStr = html.slice(start, i + 1);
        try {
          return JSON.parse(jsonStr);
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
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

  const allRaces = extractAllRacesFromHtml(html);
  if (allRaces && allRaces[date] && allRaces[date][venue]) {
    const list = allRaces[date][venue];
    if (Array.isArray(list) && list.length > 0) {
      const races = list.map((row) => {
        const raceId = row.id != null ? parseInt(String(row.id), 10) : NaN;
        const rpt = row.rpt != null ? parseInt(String(row.rpt), 10) : null;
        const startTime = row.time && String(row.time).trim() ? String(row.time).trim() : undefined;
        return {
          raceId: Number.isNaN(raceId) ? 0 : raceId,
          rpt: rpt != null && !Number.isNaN(rpt) ? rpt : undefined,
          startTime,
        };
      }).filter((r) => r.raceId > 0);
      if (races.length > 0) {
        return { ok: true, races };
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

      races.push({ raceId, rpt: rpt ?? undefined, startTime: startTime || undefined });
    });
  });

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
