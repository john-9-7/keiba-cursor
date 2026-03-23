#!/usr/bin/env node
/**
 * デプロイ後スモークテスト
 * - /api/keiba-session/status
 * - /api/dashboard
 *
 * 使い方:
 *   npm run test:smoke
 *
 * 環境変数（必要に応じて）:
 *   SMOKE_BASE_URL=https://keiba-cursor.onrender.com
 *   SMOKE_AUTH_USER=xxxx
 *   SMOKE_AUTH_PASS=xxxx
 *   SMOKE_COOKIE=laravel_session=...; XSRF-TOKEN=...
 *   SMOKE_COOKIE_PURPOSE=live|archive (既定: live)
 *   SMOKE_TIMEOUT_MS=20000 (既定: 20000)
 */

const DEFAULT_TIMEOUT_MS = 20000;

function required(name, value) {
  if (!value) {
    throw new Error(`環境変数 ${name} が未設定です。`);
  }
  return value;
}

function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const user = process.env.SMOKE_AUTH_USER;
  const pass = process.env.SMOKE_AUTH_PASS;
  if (user || pass) {
    const token = Buffer.from(`${required('SMOKE_AUTH_USER', user)}:${required('SMOKE_AUTH_PASS', pass)}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  return headers;
}

async function fetchJson(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`${url} がJSONを返しませんでした（status=${res.status}, 先頭120文字=${text.slice(0, 120)}）`);
    }
    return { res, json };
  } finally {
    clearTimeout(id);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function summarizeDashboard(data) {
  const items = Array.isArray(data.items) ? data.items : [];
  const okCount = items.filter((x) => x && x.ok).length;
  const skippedCount = items.filter((x) => x && x.skipped).length;
  const ngCount = items.length - okCount - skippedCount;
  return { total: items.length, okCount, skippedCount, ngCount };
}

async function main() {
  const baseUrl = (process.env.SMOKE_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const timeoutMs = parseInt(process.env.SMOKE_TIMEOUT_MS || '', 10) || DEFAULT_TIMEOUT_MS;
  const cookiePurpose = process.env.SMOKE_COOKIE_PURPOSE === 'archive' ? 'archive' : 'live';
  const cookie = (process.env.SMOKE_COOKIE || '').trim();
  const headers = buildHeaders();

  console.log('--- smoke test start ---');
  console.log(`baseUrl: ${baseUrl}`);
  console.log(`cookiePurpose: ${cookiePurpose}`);
  console.log(`cookieProvided: ${cookie ? 'yes' : 'no (saved session/env expected)'}`);

  // 1) セッション状態確認
  const statusUrl = `${baseUrl}/api/keiba-session/status`;
  const statusPack = await fetchJson(
    statusUrl,
    { method: 'GET', headers },
    timeoutMs,
  );
  assert(statusPack.res.ok, `/api/keiba-session/status が失敗: HTTP ${statusPack.res.status}`);
  assert(statusPack.json && statusPack.json.ok, '/api/keiba-session/status の ok が false');

  const hasLive = !!statusPack.json.hasSavedLive;
  const hasArchive = !!statusPack.json.hasSavedArchive;
  console.log(`session: live=${hasLive} archive=${hasArchive}`);

  if (!cookie) {
    if (cookiePurpose === 'live') {
      assert(hasLive, 'live 用の保存済みCookieがありません。SMOKE_COOKIE を渡すか、サーバー保存/KEIBA_COOKIEを設定してください。');
    } else {
      assert(hasArchive, 'archive 用の保存済みCookieがありません。SMOKE_COOKIE を渡すか、サーバー保存/KEIBA_COOKIE_ARCHIVEを設定してください。');
    }
  }

  // 2) ダッシュボード疎通確認
  const dashboardUrl = `${baseUrl}/api/dashboard`;
  const dashboardPack = await fetchJson(
    dashboardUrl,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        cookie,
        cookiePurpose,
      }),
    },
    timeoutMs,
  );
  assert(dashboardPack.res.ok, `/api/dashboard が失敗: HTTP ${dashboardPack.res.status}`);
  assert(dashboardPack.json && dashboardPack.json.ok, `/api/dashboard がエラー: ${dashboardPack.json?.error || 'unknown'}`);
  assert(Array.isArray(dashboardPack.json.items), '/api/dashboard の items が配列ではありません');

  const s = summarizeDashboard(dashboardPack.json);
  console.log(`dashboard items: total=${s.total} ok=${s.okCount} skipped=${s.skippedCount} ng=${s.ngCount}`);
  console.log('✅ smoke test passed');
}

main().catch((err) => {
  console.error('❌ smoke test failed');
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});

