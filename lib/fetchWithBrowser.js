/**
 * Playwright で実ブラウザからページを取得する。
 * Cookie をコンテキストに設定してからアクセスするため、サイトが「ブラウザ以外」を弾く場合でも取得できる。
 */

const { chromium } = require('playwright');

/**
 * Cookie 文字列 "name1=value1; name2=value2" をパースし、
 * { name, value, domain, path } の配列にする。
 */
function parseCookieString(cookieStr, domain) {
  if (!cookieStr || !domain) return [];
  const domainClean = domain.replace(/^\./, '');
  return cookieStr
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const eq = s.indexOf('=');
      if (eq <= 0) return null;
      const name = s.slice(0, eq).trim();
      const value = s.slice(eq + 1).trim();
      return { name, value, domain: domainClean, path: '/' };
    })
    .filter(Boolean);
}

/**
 * @param {string} url - 取得するURL
 * @param {string} cookieStr - Cookie ヘッダーと同じ形式の文字列
 * @returns {Promise<{ ok: boolean, html?: string, error?: string }>}
 */
async function fetchWithBrowser(url, cookieStr) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const u = new URL(url);
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });

    const cookies = parseCookieString(cookieStr || '', u.hostname);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }

    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    if (!response || !response.ok()) {
      const status = response ? response.status() : 0;
      return { ok: false, error: `HTTP ${status}`, status };
    }
    const html = await page.content();
    await browser.close();
    return { ok: true, html };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: err.message || 'ブラウザ取得に失敗しました。' };
  }
}

module.exports = { fetchWithBrowser, parseCookieString };
