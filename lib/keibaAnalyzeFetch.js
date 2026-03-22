/**
 * 競馬クラスター race-analyze ページ取得（ダッシュボード・蓄積・単発取得の共通）
 * - ヘッダを1か所に集約（他機能変更でダッシュボードが壊れにくい）
 * - 5xx / 429 時は指数バックオフ＋ジッターで再試行
 * - ブラウザ寄りのヘッダ・リクエストタイムアウトで 500 を減らす
 */

const RACE_ANALYZE_BASE = 'https://web.keibacluster.com/top/race-analyze';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * @param {string} cookieStr
 * @param {string} [referer='https://web.keibacluster.com/top/race-analyze-next']
 */
function buildAnalyzeHeaders(cookieStr, referer = 'https://web.keibacluster.com/top/race-analyze-next') {
  return {
    'User-Agent': DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    Referer: referer,
    Cookie: cookieStr || '',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
  };
}

function isRetryableStatus(status) {
  return status === 500 || status === 502 || status === 503 || status === 504 || status === 429;
}

/** 0〜max のランダム整数（ジッター用） */
function randomInt(max) {
  return Math.floor(Math.random() * (max + 1));
}

/**
 * race-analyze?race_id= の HTML を取得
 * @param {number} raceId
 * @param {string} cookieStr
 * @param {{ maxAttempts?: number, baseDelayMs?: number, referer?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, html: string | null, error?: string }>}
 */
async function fetchRaceAnalyzeHtml(raceId, cookieStr, opts = {}) {
  const maxAttempts = Math.min(Math.max(opts.maxAttempts ?? 4, 1), 6);
  const baseDelayMs = Math.min(Math.max(opts.baseDelayMs ?? 800, 200), 5000);
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 15000, 5000), 60000);
  const referer = opts.referer;
  const url = `${RACE_ANALYZE_BASE}?race_id=${raceId}`;
  const headers = buildAnalyzeHeaders(cookieStr, referer);

  let lastStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      lastStatus = r.status;
      if (r.ok) {
        const html = await r.text();
        return { ok: true, status: r.status, html };
      }
      if (!isRetryableStatus(r.status) || attempt === maxAttempts) {
        return { ok: false, status: r.status, html: null, error: `HTTP ${r.status}` };
      }
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        if (attempt === maxAttempts) return { ok: false, status: 0, html: null, error: 'タイムアウト' };
      } else if (attempt === maxAttempts) {
        return { ok: false, status: 0, html: null, error: e.message || 'fetch error' };
      }
    }
    const exponential = baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = randomInt(400);
    const wait = Math.min(exponential + jitter, 8000);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return { ok: false, status: lastStatus, html: null, error: `HTTP ${lastStatus}` };
}

module.exports = {
  fetchRaceAnalyzeHtml,
  buildAnalyzeHeaders,
  RACE_ANALYZE_BASE,
};
