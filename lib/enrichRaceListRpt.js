/**
 * レース一覧で RPT が取れないとき、詳細ページ（race-analyze?race_id=）と同じ HTML から RPT を補完する。
 * 一覧（race-list）と詳細（race-analyze）では埋め込みデータが異なるため、この橋渡しが必要。
 */

const { parseRacePage } = require('./parseRacePage');

function analyzeUrl(raceId) {
  return `https://web.keibacluster.com/top/race-analyze?race_id=${raceId}`;
}

/**
 * @param {number} raceId
 * @param {string} cookieStr - normalize 済み Cookie
 * @returns {Promise<number | null>}
 */
async function fetchRptFromAnalyzePage(raceId, cookieStr) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: 'https://web.keibacluster.com/top/race-analyze-next',
  };
  if (cookieStr) headers.Cookie = cookieStr;

  const res = await fetch(analyzeUrl(raceId), { method: 'GET', headers, redirect: 'follow' });
  if (!res.ok) return null;
  const html = await res.text();
  const parsed = parseRacePage(html);
  return parsed.rpt != null && parsed.rpt >= 1 && parsed.rpt <= 13 ? parsed.rpt : null;
}

/**
 * races のうち rpt が無い行だけ、詳細ページを取りに行って埋める（並列数制限）
 * @param {Array<{ raceId: number, rpt?: number, startTime?: string }>} races - インプレース更新
 * @param {string} cookieStr
 * @param {number} [concurrency=4]
 */
async function enrichMissingRptFromAnalyzePages(races, cookieStr, concurrency = 4) {
  if (!races || !races.length || !cookieStr) return;
  const queue = races.filter((r) => r && r.raceId > 0 && (r.rpt == null || r.rpt === undefined));
  if (queue.length === 0) return;

  const n = Math.min(Math.max(1, concurrency), queue.length);
  const tasks = [...queue];

  async function worker() {
    for (;;) {
      const r = tasks.shift();
      if (!r) break;
      try {
        const rpt = await fetchRptFromAnalyzePage(r.raceId, cookieStr);
        if (rpt != null) r.rpt = rpt;
      } catch (e) {
        /* 1レース失敗は握りつぶす */
      }
    }
  }

  await Promise.all(Array.from({ length: n }, () => worker()));
}

module.exports = { enrichMissingRptFromAnalyzePages, fetchRptFromAnalyzePage };
