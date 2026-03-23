/**
 * netkeiba からレース結果（着順・馬番）を取得する
 * - レース一覧ページから (日付, 会場, R) → race_id を抽出
 * - 結果ページから 1〜3着馬番・全着順をパース
 * - 取得元: race.netkeiba.com（利用規約要確認）
 */

const cheerio = require('cheerio');

/** 会場名 → netkeiba競馬場コード（2桁） */
const VENUE_NAME_TO_CODE = {
  札幌: '01',
  函館: '02',
  福島: '03',
  新潟: '04',
  東京: '05',
  中山: '06',
  中京: '07',
  京都: '08',
  阪神: '09',
  小倉: '10',
};

/** 競馬場コード → 会場名 */
const CODE_TO_VENUE_NAME = Object.fromEntries(
  Object.entries(VENUE_NAME_TO_CODE).map(([k, v]) => [v, k])
);

const RACE_ID_RE = /race_id=(\d{10,14})/g;
const RACE_ID_PATH_RE = /\/race\/(\d{10,14})(?:\/|$|\?)/g;
const RACE_LIST_URL = 'https://race.netkeiba.com/top/race_list.html';
const DB_SUM_URL = 'https://db.netkeiba.com/race/sum'; // /{venue_code}/{date}/
const RESULT_URL_BASE = 'https://race.netkeiba.com/race/result.html';

/**
 * netkeiba race_id をデコード
 * 形式: YYYY(4) + PP(2)競馬場 + NN(2)回 + DD(2)日 + RR(2)レース
 * @param {string} raceId
 * @returns {{ venueCode: string, venueName: string, raceNum: number } | null}
 */
function decodeNetkeibaRaceId(raceId) {
  if (!raceId || raceId.length < 12) return null;
  const venueCode = raceId.slice(4, 6);
  const venueName = CODE_TO_VENUE_NAME[venueCode] || null;
  const raceNum = parseInt(raceId.slice(10, 12), 10);
  if (!venueName || Number.isNaN(raceNum) || raceNum < 1 || raceNum > 15) return null;
  return { venueCode, venueName, raceNum };
}

/**
 * HTML から race_id を抽出（race_id= と /race/123456789012/ の両方）
 * @param {string} html
 * @returns {string[]}
 */
function extractRaceIdsFromHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const seen = new Set();
  let m;
  RACE_ID_RE.lastIndex = 0;
  while ((m = RACE_ID_RE.exec(html)) !== null) {
    if (m[1].length >= 10) seen.add(m[1]);
  }
  RACE_ID_PATH_RE.lastIndex = 0;
  while ((m = RACE_ID_PATH_RE.exec(html)) !== null) {
    if (m[1].length >= 10) seen.add(m[1]);
  }
  return [...seen];
}

/**
 * レース一覧ページのHTMLから (会場名, R番) → race_id の Map を構築
 * @param {string} html
 * @param {string} date YYYY-MM-DD（検証用、必須ではない）
 * @returns {Map<string, string>} key = `${venueName}\t${raceNum}`
 */
function parseRaceListForDate(html, date) {
  const map = new Map();
  const ids = extractRaceIdsFromHtml(html);
  for (const raceId of ids) {
    const decoded = decodeNetkeibaRaceId(raceId);
    if (!decoded) continue;
    const key = `${decoded.venueName}\t${decoded.raceNum}`;
    if (!map.has(key)) map.set(key, raceId);
  }
  return map;
}

/**
 * 結果ページのHTMLから着順（馬番）を抽出
 * @param {string} html
 * @returns {{ first?: number, second?: number, third?: number, finishOrder?: number[] } | null}
 */
function parseResultPage(html) {
  if (!html || typeof html !== 'string') return null;
  const $ = cheerio.load(html);

  // 着順テーブル: 一般的に table.RaceTable01 や結果テーブル
  const tables = $('table.RaceTable01, table[class*="Result"], table.Result_Table');
  let $table = tables.first();
  if ($table.length === 0) {
    $table = $('table').filter((_, el) => {
      const text = $(el).text();
      return /着順|馬番/.test(text) && /枠/.test(text);
    }).first();
  }
  if ($table.length === 0) return null;

  const headerRow = $table.find('thead tr, tr:first-child').first();
  const headerCells = headerRow.find('th, td');
  let umaColIdx = -1;
  headerCells.each((i, el) => {
    const t = $(el).text().trim();
    if (/馬番/.test(t) || (t === '馬番')) umaColIdx = i;
  });

  if (umaColIdx < 0) {
    // 馬番列が無い場合、2列目（枠の次）を試す
    headerCells.each((i, el) => {
      const t = $(el).text().trim();
      if (/枠/.test(t) && umaColIdx < 0) umaColIdx = i + 1;
    });
  }

  const finishOrder = [];
  $table.find('tbody tr, tr').each((_, row) => {
    const $row = $(row);
    const cells = $row.find('td');
    if (cells.length < 2) return;
    const uma = umaColIdx >= 0
      ? parseInt($(cells[umaColIdx]).text().trim(), 10)
      : parseInt($(cells[2]).text().trim(), 10);
    if (!Number.isNaN(uma) && uma >= 1 && uma <= 18) {
      finishOrder.push(uma);
    }
  });

  if (finishOrder.length === 0) return null;

  return {
    first: finishOrder[0],
    second: finishOrder[1],
    third: finishOrder[2],
    finishOrder,
    payouts: parsePayouts(html),
  };
}

/**
 * 払戻テーブルを解析して券種別に返す
 * 返却形式:
 * {
 *   umaren: [{ key: "1-2", payout: 560 }],
 *   wide: [{ key: "1-2", payout: 230 }],
 *   umatan: [{ key: "1>2", payout: 980 }],
 *   sanrenpuku: [{ key: "1-2-3", payout: 1240 }],
 *   sanrentan: [{ key: "1>2>3", payout: 10230 }],
 * }
 * @param {string} html
 */
function parsePayouts(html) {
  const out = { umaren: [], wide: [], umatan: [], sanrenpuku: [], sanrentan: [] };
  if (!html || typeof html !== 'string') return out;
  const $ = cheerio.load(html);
  const table = $('table.PayBack_Table, table.PayBack').first();
  if (!table.length) return out;

  function normNums(text) {
    return String(text || '')
      .replace(/[^\d\-→＞>\s]/g, ' ')
      .trim();
  }
  function toYen(text) {
    const m = String(text || '').replace(/[^\d]/g, '');
    const n = parseInt(m, 10);
    return Number.isNaN(n) ? null : n;
  }
  function pairAsc(a, b) {
    const x = Number(a);
    const y = Number(b);
    if (Number.isNaN(x) || Number.isNaN(y) || x < 1 || y < 1 || x === y) return null;
    return x < y ? `${x}-${y}` : `${y}-${x}`;
  }
  function pairOrd(a, b) {
    const x = Number(a);
    const y = Number(b);
    if (Number.isNaN(x) || Number.isNaN(y) || x < 1 || y < 1 || x === y) return null;
    return `${x}>${y}`;
  }
  function triAsc(a, b, c) {
    const arr = [Number(a), Number(b), Number(c)];
    if (arr.some((n) => Number.isNaN(n) || n < 1) || new Set(arr).size !== 3) return null;
    arr.sort((p, q) => p - q);
    return `${arr[0]}-${arr[1]}-${arr[2]}`;
  }
  function triOrd(a, b, c) {
    const arr = [Number(a), Number(b), Number(c)];
    if (arr.some((n) => Number.isNaN(n) || n < 1) || new Set(arr).size !== 3) return null;
    return `${arr[0]}>${arr[1]}>${arr[2]}`;
  }
  function parseCombos(raw) {
    const t = normNums(raw).replace(/[＞→]/g, '>');
    const pair = t.match(/(\d+)\s*[-]\s*(\d+)/);
    if (pair) return { nums: [pair[1], pair[2]], ordered: false, triple: false };
    const ordPair = t.match(/(\d+)\s*>\s*(\d+)/);
    if (ordPair) return { nums: [ordPair[1], ordPair[2]], ordered: true, triple: false };
    const tri = t.match(/(\d+)\s*[-]\s*(\d+)\s*[-]\s*(\d+)/);
    if (tri) return { nums: [tri[1], tri[2], tri[3]], ordered: false, triple: true };
    const ordTri = t.match(/(\d+)\s*>\s*(\d+)\s*>\s*(\d+)/);
    if (ordTri) return { nums: [ordTri[1], ordTri[2], ordTri[3]], ordered: true, triple: true };
    return null;
  }

  table.find('tr').each((_, tr) => {
    const $tr = $(tr);
    const cells = $tr.find('th,td');
    if (cells.length < 3) return;
    const type = $(cells[0]).text().trim();
    const comboText = $(cells[1]).text().trim();
    const payout = toYen($(cells[2]).text().trim());
    if (!payout || !comboText) return;
    const parsed = parseCombos(comboText);
    if (!parsed) return;

    let key = null;
    if (/馬連/.test(type)) key = pairAsc(parsed.nums[0], parsed.nums[1]);
    else if (/ワイド/.test(type)) key = pairAsc(parsed.nums[0], parsed.nums[1]);
    else if (/馬単/.test(type)) key = pairOrd(parsed.nums[0], parsed.nums[1]);
    else if (/3連複/.test(type)) key = triAsc(parsed.nums[0], parsed.nums[1], parsed.nums[2]);
    else if (/3連単/.test(type)) key = triOrd(parsed.nums[0], parsed.nums[1], parsed.nums[2]);
    if (!key) return;

    if (/馬連/.test(type)) out.umaren.push({ key, payout });
    else if (/ワイド/.test(type)) out.wide.push({ key, payout });
    else if (/馬単/.test(type)) out.umatan.push({ key, payout });
    else if (/3連複/.test(type)) out.sanrenpuku.push({ key, payout });
    else if (/3連単/.test(type)) out.sanrentan.push({ key, payout });
  });

  return out;
}

/**
 * netkeiba へ HTTP 取得（リトライ・遅延付き）
 * @param {string} url
 * @param {{ maxAttempts?: number, delayMs?: number }} [opts]
 */
async function fetchNetkeiba(url, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const delayMs = opts.delayMs ?? 800;
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    Referer: 'https://db.netkeiba.com/',
  };

  for (let a = 1; a <= maxAttempts; a += 1) {
    try {
      await new Promise((r) => setTimeout(r, delayMs * a));
      const r = await fetch(url, { method: 'GET', headers, redirect: 'follow' });
      if (!r.ok) {
        if (a === maxAttempts) return { ok: false, status: r.status, html: null };
        continue;
      }
      const html = await r.text();
      return { ok: true, status: r.status, html };
    } catch (e) {
      if (a === maxAttempts) return { ok: false, status: 0, html: null, error: e.message };
    }
  }
  return { ok: false, status: 0, html: null };
}

/**
 * db.netkeiba.com の会場別サムページを取得（race_id が HTML に含まれる）
 * @param {string} venueCode 06=中山, 07=中京, 09=阪神 など
 * @param {string} dateNorm YYYYMMDD
 */
async function fetchDbSumPage(venueCode, dateNorm) {
  const url = `${DB_SUM_URL}/${venueCode}/${dateNorm}/`;
  const fr = await fetchNetkeiba(url, { delayMs: 600 });
  return fr;
}

/**
 * 指定日のレース一覧を取得し (会場名, R) → race_id を返す
 * db.netkeiba.com/race/sum/{code}/{date}/ を JRA 会場分取得
 * @param {string} date YYYY-MM-DD
 * @param {string[]} [venueNames] 対象会場（省略時は 中山・中京・阪神・東京・京都）
 * @returns {Promise<{ ok: boolean, map?: Map<string, string>, error?: string }>}
 */
async function fetchRaceListForDate(date, venueNames = ['中山', '中京', '阪神', '東京', '京都']) {
  const norm = String(date).trim().replace(/-/g, '');
  if (norm.length < 8) return { ok: false, error: '日付を YYYY-MM-DD で指定してください。' };
  const map = new Map();
  const codes = venueNames
    .map((v) => VENUE_NAME_TO_CODE[v])
    .filter(Boolean);
  if (codes.length === 0) return { ok: false, error: '対象会場がありません。' };
  for (const code of codes) {
    const fr = await fetchDbSumPage(code, norm);
    if (!fr.ok) continue;
    const sub = parseRaceListForDate(fr.html, date);
    for (const [k, v] of sub) map.set(k, v);
  }
  return { ok: true, map };
}

/**
 * 指定 race_id の結果ページを取得して着順をパース
 * @param {string} netkeibaRaceId
 * @returns {Promise<{ ok: boolean, result?: { first?: number, second?: number, third?: number, finishOrder?: number[] }, error?: string }>}
 */
async function fetchResultByRaceId(netkeibaRaceId) {
  const url = `${RESULT_URL_BASE}?race_id=${netkeibaRaceId}`;
  const fr = await fetchNetkeiba(url, { delayMs: 600 });
  if (!fr.ok) return { ok: false, error: `HTTP ${fr.status || fr.error}` };
  const parsed = parseResultPage(fr.html);
  if (!parsed) return { ok: false, error: '着順テーブルを取得できませんでした。' };
  return { ok: true, result: parsed };
}

module.exports = {
  VENUE_NAME_TO_CODE,
  CODE_TO_VENUE_NAME,
  parseRaceListForDate,
  parseResultPage,
  fetchNetkeiba,
  fetchRaceListForDate,
  fetchResultByRaceId,
  decodeNetkeibaRaceId,
};
