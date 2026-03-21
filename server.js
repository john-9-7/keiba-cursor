/**
 * 競馬予想ツール - サーバー
 * - 静的ファイル配信（public/）
 * - API: Cookie付きで指定URLを取得し、RPT・馬番・BB指数・オッズをパース
 */

const express = require('express');
const path = require('path');
const { parseRacePage } = require('./lib/parseRacePage');
const { normalizeCookie } = require('./lib/normalizeCookie');
const { parseRaceList, listDatesAndVenues } = require('./lib/parseRaceList');
const {
  resolveKeibaCookie,
  saveKeibaSession,
  clearKeibaSession,
  getKeibaSessionStatus,
} = require('./lib/keibaSession');
const { enrichMissingRptFromAnalyzePages } = require('./lib/enrichRaceListRpt');
const { pickDashboardRacesFromListHtml } = require('./lib/dashboardPicks');
const { judgeRace } = require('./lib/judgment');

const DASHBOARD_FETCH_CONCURRENCY = 5;

/** パース済み馬行から判定オブジェクトを生成（API用） */
function buildJudgment(rpt, horses) {
  if (!horses || horses.length === 0) return null;
  const rows = horses.map((h) => ({
    horseNumber: Number(h.horseNumber),
    bb: h.bb != null && h.bb !== '' && !Number.isNaN(Number(h.bb)) ? Number(h.bb) : null,
    winOdds:
      h.winOdds != null && h.winOdds !== '' && !Number.isNaN(Number(h.winOdds)) ? Number(h.winOdds) : null,
  }));
  const j = judgeRace(rpt, rows);
  return {
    verdict: j.verdict,
    pattern: j.pattern,
    lines: j.lines,
    recommend: j.recommend,
    meta: j.meta,
  };
}
let fetchWithBrowser;
try {
  fetchWithBrowser = require('./lib/fetchWithBrowser').fetchWithBrowser;
} catch (e) {
  console.warn('Playwright 未読み込み:', e.message);
  fetchWithBrowser = null;
}

const app = express();
const DEFAULT_PORT = Number(process.env.PORT) || 3000;
const ENABLE_AUTH = String(process.env.ENABLE_AUTH || 'false').toLowerCase() === 'true';
const AUTH_USER = process.env.AUTH_USER || '';
const AUTH_PASS = process.env.AUTH_PASS || '';

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Basic realm="keiba-tool"');
  return res.status(401).send('Authentication required');
}

function checkBasicAuth(req, res, next) {
  if (!ENABLE_AUTH) return next();
  if (req.path === '/healthz') return next();

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return unauthorized(res);

  const base64 = header.slice(6).trim();
  let decoded = '';
  try {
    decoded = Buffer.from(base64, 'base64').toString('utf8');
  } catch (e) {
    return unauthorized(res);
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return unauthorized(res);
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  if (user !== AUTH_USER || pass !== AUTH_PASS) {
    return unauthorized(res);
  }
  next();
}

if (ENABLE_AUTH && (!AUTH_USER || !AUTH_PASS)) {
  console.warn('[WARN] ENABLE_AUTH=true ですが AUTH_USER または AUTH_PASS が未設定です。');
}

// JSON body を読む
app.use(express.json({ limit: '1mb' }));
app.use(checkBasicAuth);

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});

/**
 * GET /api/keiba-session/status
 * サーバーに保存済みCookie / 環境変数 KEIBA_COOKIE があるか（値は返さない）
 */
app.get('/api/keiba-session/status', (req, res) => {
  res.json(getKeibaSessionStatus());
});

/**
 * POST /api/keiba-session
 * Body: { "cookie": "laravel_session=...; XSRF-TOKEN=..." }
 * PCで一度貼り付けて保存。以後 iPhone では Cookie 欄を空にして「保存済みを使う」でOK。
 */
app.post('/api/keiba-session', (req, res) => {
  const { cookie } = req.body || {};
  const result = saveKeibaSession(cookie);
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }
  res.json({ ok: true, message: 'サーバーに保存しました。' });
});

/**
 * DELETE /api/keiba-session
 * サーバー保存ファイルを削除（環境変数 KEIBA_COOKIE は削除できない）
 */
app.delete('/api/keiba-session', (req, res) => {
  const result = clearKeibaSession();
  if (!result.ok) {
    return res.status(500).json({ ok: false, error: result.error });
  }
  res.json({ ok: true, message: 'サーバー保存を削除しました。' });
});

// 静的ファイル（public/）— HTML はキャッシュさせず、デプロイ直後も最新画面が出るようにする
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
      }
    },
  }),
);

// トップは index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * POST /api/fetch
 * Body: { "cookie": "..." , "url": "https://..." }
 * 指定URLに Cookie を付けて取得し、HTMLを返す。
 */
app.post('/api/fetch', async (req, res) => {
  const { cookie, url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'url を指定してください。' });
  }

  // 簡易チェック: 競馬クラスター等の許可ホスト（必要なら拡張）
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) {
      return res.status(400).json({ ok: false, error: 'http または https のURLのみ指定できます。' });
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: '正しいURLを指定してください。' });
  }

  // GET で取得するには race_id 付きURLが必要（race-analyze-next のみは POST 用のため）
  if (/race-analyze[^?]*$/.test(url.replace(/\s/g, '')) && !/race_id=/.test(url)) {
    return res.status(400).json({
      ok: false,
      error: 'このURLではデータを取得できません。',
      hint: 'アドレスバーに ?race_id=数字 が含まれるURLを使ってください。出馬表を表示した状態で、レースリンクを「右クリック→新しいタブで開く」または「中ボタン（ホイール）クリック」で開くと、race_id 付きのURLが表示されます。例: https://web.keibacluster.com/top/race-analyze?race_id=361645',
    });
  }

  const cookieStr = resolveKeibaCookie(cookie);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': 'https://web.keibacluster.com/top/race-analyze-next',
  };
  if (cookieStr) {
    headers['Cookie'] = cookieStr;
  }

  try {
    if (!cookieStr) {
      return res.status(400).json({
        ok: false,
        error: '競馬クラスターの Cookie がありません。',
        hint: 'PCで一度 Cookie を貼って「サーバーに保存」するか、Render の環境変数 KEIBA_COOKIE を設定してください。',
      });
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
    });

    if (!response.ok) {
      const hint404 = response.status === 404
        ? '入力したURLが競馬クラスターで見つかりません（404）。ブラウザで出馬表を表示した状態で、アドレスバーのURLをそのままコピーしていますか？ https://web.keibacluster.com/top/race-analyze-next のようなURLにしてください。'
        : null;
      return res.status(200).json({
        ok: false,
        error: `HTTP ${response.status}`,
        status: response.status,
        hint: hint404 || undefined,
      });
    }

    const html = await response.text();
    const parsed = parseRacePage(html);
    let hint = null;
    if (!parsed.ok || !parsed.horses || parsed.horses.length === 0) {
      const hasTable = /race-horses-table|出馬表/.test(html);
      const isTopPage = /競馬クラスターWeb|β版/.test(html) && /中央競馬.*南関競馬.*地方競馬|race-btn.*中央競馬/.test(html.replace(/\s/g, '')) && !hasTable;
      const isRaceList = /race-list/.test(url) && !hasTable;
      const looksLikeLogin = /認証|パスワード|ログイン|トライアル会員/.test(html) && !hasTable;
      if (isRaceList) {
        hint = 'レース一覧ページ（race-list）が返っています。一覧でレース（例：1R）をクリックして出馬表を表示し、アドレスバーが「race-analyze-next」になっていることを確認して、そのURLを入力してください。';
      } else if (isTopPage) {
        hint = 'トップページが返っています。入力したURLが「トップ」のままになっていませんか？ ブラウザでログイン後、会場（例：中山）・レース番号を選んで出馬表が表示された状態で、アドレスバーのURLをコピーして貼り付けてください。';
      } else if (html.length < 20000 && !hasTable) {
        hint = looksLikeLogin
          ? 'ログイン画面が返っている可能性が高いです。ブラウザで競馬クラスターに再度ログインし、会場・レースを選んだあと、Cookie をコピーし直してください。'
          : '出馬表が含まれていません。会場・レースを選んだ「レース分析」ページのURLか、Cookie が正しく渡っているか確認してください。';
      }
    }
    const parsedPayload = parsed.ok ? { rpt: parsed.rpt, horses: parsed.horses } : null;
    const judgment = parsed.ok ? buildJudgment(parsed.rpt, parsed.horses) : null;
    res.json({
      ok: true,
      html,
      length: html.length,
      parsed: parsedPayload ? { ...parsedPayload, judgment } : null,
      hint: hint || undefined,
      requestedUrl: url,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err.message || '取得に失敗しました。',
    });
  }
});

const RACE_LIST_URL = 'https://web.keibacluster.com/top/race-list';

/**
 * POST /api/race-list
 * Body: { "cookie": "..." , "date"?: "2026-03-15" , "venue"?: "中山" }
 * レース一覧ページを取得し、日付・会場の一覧、または指定日付・会場のレース一覧（race_id 付き）を返す。
 */
app.post('/api/race-list', async (req, res) => {
  const { cookie, date, venue } = req.body || {};
  const cookieStr = resolveKeibaCookie(cookie);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': 'https://web.keibacluster.com/top/race-list',
  };
  if (cookieStr) headers['Cookie'] = cookieStr;

  try {
    if (!cookieStr) {
      return res.status(400).json({
        ok: false,
        error: '競馬クラスターの Cookie がありません。',
        hint: 'PCで Cookie を貼って「サーバーに保存」するか、環境変数 KEIBA_COOKIE を設定し、「保存済みの Cookie を使う」にチェックを入れてください。',
      });
    }

    const response = await fetch(RACE_LIST_URL, { method: 'GET', headers, redirect: 'follow' });
    if (!response.ok) {
      return res.status(200).json({ ok: false, error: `HTTP ${response.status}` });
    }
    const html = await response.text();
    const isTopPage = /競馬クラスターWeb|β版/.test(html) && /中央競馬.*南関競馬|race-btn/.test(html.replace(/\s/g, '')) && !/race-container/.test(html);
    if (isTopPage || html.length < 10000) {
      return res.status(200).json({
        ok: false,
        error: 'トップページが返っています。Cookie を確認してください。',
      });
    }
    if (date && venue) {
      const parsed = parseRaceList(html, date, venue);
      if (!parsed.ok) {
        return res.status(200).json({ ok: false, error: parsed.error || 'パースに失敗しました。' });
      }
      // 一覧ページの JSON/DOM だけでは RPT が空のことがある → 詳細ページと同じ HTML から補完
      await enrichMissingRptFromAnalyzePages(parsed.races, cookieStr, 4);
      return res.json({ ok: true, races: parsed.races });
    }
    const list = listDatesAndVenues(html);
    if (!list.ok) {
      return res.status(200).json({ ok: false, error: list.error || '日付・会場の抽出に失敗しました。' });
    }
    res.json({ ok: true, datesAndVenues: list.items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || '取得に失敗しました。' });
  }
});

/**
 * POST /api/dashboard
 * レース一覧HTMLを1回取得し、JST基準の対象日×全会場で「発走が現在に最も近い」レースを自動選択、
 * 各レースの出馬表・オッズ・判定をまとめて返す（更新ボタンでも同API）。
 */
app.post('/api/dashboard', async (req, res) => {
  const { cookie } = req.body || {};
  const cookieStr = resolveKeibaCookie(cookie);
  try {
    if (!cookieStr) {
      return res.status(400).json({
        ok: false,
        error: '競馬クラスターの Cookie がありません。',
        hint: 'PCで Cookie を貼って「サーバーに保存」するか、環境変数 KEIBA_COOKIE を設定してください。',
      });
    }

    const listHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: 'https://web.keibacluster.com/top/race-list',
      Cookie: cookieStr,
    };

    const response = await fetch(RACE_LIST_URL, { method: 'GET', headers: listHeaders, redirect: 'follow' });
    if (!response.ok) {
      return res.status(200).json({ ok: false, error: `レース一覧: HTTP ${response.status}` });
    }
    const html = await response.text();
    const isTopPage =
      /競馬クラスターWeb|β版/.test(html) &&
      /中央競馬.*南関競馬|race-btn/.test(html.replace(/\s/g, '')) &&
      !/race-container/.test(html);
    if (isTopPage || html.length < 10000) {
      return res.status(200).json({
        ok: false,
        error: 'トップページが返っています。Cookie を確認してください。',
      });
    }

    const { date, dateNorm, picks } = pickDashboardRacesFromListHtml(html);
    if (!picks || picks.length === 0) {
      return res.status(200).json({
        ok: false,
        error: '会場別の自動レース選択ができませんでした。',
        hint:
          '一覧ページに埋め込みデータが無い、または発走時刻が取れない可能性があります。下の「従来の手順」で日付・会場を選んでください。',
      });
    }

    const analyzeHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: 'https://web.keibacluster.com/top/race-analyze-next',
      Cookie: cookieStr,
    };

    const items = new Array(picks.length);
    let cursor = 0;

    async function dashboardWorker() {
      for (;;) {
        const idx = cursor;
        cursor += 1;
        if (idx >= picks.length) return;
        const p = picks[idx];
        const url = `https://web.keibacluster.com/top/race-analyze?race_id=${p.raceId}`;
        try {
          const r = await fetch(url, { method: 'GET', headers: analyzeHeaders, redirect: 'follow' });
          if (!r.ok) {
            items[idx] = {
              ok: false,
              venue: p.venue,
              raceId: p.raceId,
              raceNumber: p.raceNumber,
              startTime: p.startTime,
              rpt: p.rpt,
              deltaMinutes: p.deltaMinutes,
              error: `HTTP ${r.status}`,
            };
            continue;
          }
          const h = await r.text();
          const parsed = parseRacePage(h);
          const badPage =
            /競馬クラスターWeb|β版/.test(h) &&
            /race-btn/.test(h.replace(/\s/g, '')) &&
            !(parsed.horses && parsed.horses.length > 0);
          if (badPage || !parsed.horses || parsed.horses.length === 0) {
            items[idx] = {
              ok: false,
              venue: p.venue,
              raceId: p.raceId,
              raceNumber: p.raceNumber,
              startTime: p.startTime,
              rpt: p.rpt,
              deltaMinutes: p.deltaMinutes,
              error: '出馬表を取得できませんでした（トップページまたは空）。',
            };
            continue;
          }
          const judgment = buildJudgment(parsed.rpt, parsed.horses);
          items[idx] = {
            ok: true,
            venue: p.venue,
            raceId: p.raceId,
            raceNumber: p.raceNumber,
            startTime: p.startTime,
            rpt: parsed.rpt != null ? parsed.rpt : p.rpt,
            deltaMinutes: p.deltaMinutes,
            judgment,
            horses: parsed.horses,
          };
        } catch (e) {
          items[idx] = {
            ok: false,
            venue: p.venue,
            raceId: p.raceId,
            raceNumber: p.raceNumber,
            startTime: p.startTime,
            rpt: p.rpt,
            deltaMinutes: p.deltaMinutes,
            error: e.message || '取得エラー',
          };
        }
      }
    }

    const nW = Math.min(DASHBOARD_FETCH_CONCURRENCY, picks.length);
    await Promise.all(Array.from({ length: nW }, () => dashboardWorker()));

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      date,
      dateNorm,
      items,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || 'dashboard 取得に失敗しました。' });
  }
});

/**
 * POST /api/fetch-race
 * Body: { "cookie": "..." , "raceId": 361634 }
 * race_id を指定して詳細ページを取得し、パース結果を返す。URLを調べなくてよい。
 */
app.post('/api/fetch-race', async (req, res) => {
  const { cookie, raceId } = req.body || {};
  const id = parseInt(raceId, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'raceId を指定してください。' });
  }
  const url = `https://web.keibacluster.com/top/race-analyze?race_id=${id}`;
  const cookieStr = resolveKeibaCookie(cookie);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': 'https://web.keibacluster.com/top/race-analyze-next',
  };
  if (cookieStr) headers['Cookie'] = cookieStr;
  try {
    if (!cookieStr) {
      return res.status(400).json({
        ok: false,
        error: '競馬クラスターの Cookie がありません。',
        hint: 'PCで Cookie を貼って「サーバーに保存」するか、環境変数 KEIBA_COOKIE を設定してください。',
      });
    }

    const response = await fetch(url, { method: 'GET', headers, redirect: 'follow' });
    if (!response.ok) {
      return res.status(200).json({ ok: false, error: `HTTP ${response.status}` });
    }
    const html = await response.text();
    const parsed = parseRacePage(html);
    const isTopPage = /競馬クラスターWeb|β版/.test(html) && /race-btn/.test(html.replace(/\s/g, '')) && !(parsed.horses && parsed.horses.length > 0);
    if (isTopPage || !parsed.horses || parsed.horses.length === 0) {
      return res.status(200).json({
        ok: false,
        error: 'トップページが返ったか、出馬表を取得できませんでした。',
        hint: 'Cookie の有効期限を確認してください。',
      });
    }
    const judgment = buildJudgment(parsed.rpt, parsed.horses);
    res.json({
      ok: true,
      raceId: id,
      rpt: parsed.rpt,
      horses: parsed.horses,
      judgment,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || '取得に失敗しました。' });
  }
});

/**
 * POST /api/fetch-browser
 * Body: { "cookie": "..." , "url": "https://..." }
 * Playwright で実ブラウザを起動し、Cookie を付けてページを取得する。
 * Cookie が効かない場合に利用。
 */
app.post('/api/fetch-browser', async (req, res) => {
  const { cookie, url } = req.body || {};

  if (!fetchWithBrowser) {
    return res.status(503).json({ ok: false, error: 'ブラウザ取得は利用できません。npm install のあと npx playwright install chromium を実行してください。' });
  }
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'url を指定してください。' });
  }
  try {
    new URL(url);
  } catch (e) {
    return res.status(400).json({ ok: false, error: '正しいURLを指定してください。' });
  }

  if (/race-analyze[^?]*$/.test(url.replace(/\s/g, '')) && !/race_id=/.test(url)) {
    return res.status(400).json({
      ok: false,
      error: 'このURLではデータを取得できません。',
      hint: '?race_id=数字 が含まれるURLを使ってください。レースを「右クリック→新しいタブで開く」で開くと race_id 付きURLが表示されます。例: https://web.keibacluster.com/top/race-analyze?race_id=361645',
    });
  }

  const cookieStr = resolveKeibaCookie(cookie);
  try {
    if (!cookieStr) {
      return res.status(400).json({
        ok: false,
        error: '競馬クラスターの Cookie がありません。',
        hint: 'PCで Cookie を貼って「サーバーに保存」するか、環境変数 KEIBA_COOKIE を設定してください。',
      });
    }

    const { ok, html, error, status } = await fetchWithBrowser(url, cookieStr);
    if (!ok || !html) {
      const hint404 = status === 404
        ? '入力したURLが競馬クラスターで見つかりません（404）。出馬表を表示した状態でアドレスバーのURLをコピーしてください。'
        : null;
      return res.status(200).json({
        ok: false,
        error: error || '取得に失敗しました。',
        hint: hint404 || undefined,
      });
    }
    const parsed = parseRacePage(html);
    let hint = null;
    if (!parsed.ok || !parsed.horses || parsed.horses.length === 0) {
      const hasTable = /race-horses-table|出馬表/.test(html);
      const isTopPage = /競馬クラスターWeb|β版/.test(html) && /中央競馬.*南関競馬.*地方競馬|race-btn.*中央競馬/.test(html.replace(/\s/g, '')) && !hasTable;
      const isRaceList = /race-list/.test(url) && !hasTable;
      const looksLikeLogin = /認証|パスワード|ログイン|トライアル会員/.test(html) && !hasTable;
      if (isRaceList) {
        hint = 'レース一覧ページが返っています。出馬表を表示したうえで再度お試しください。';
      } else if (isTopPage) {
        hint = 'トップページが返っています。Cookie の有効期限や、出馬表を表示した状態でコピーしたか確認してください。';
      } else if (html.length < 20000 && !hasTable) {
        hint = looksLikeLogin
          ? 'ログイン画面が返っています。ブラウザで再ログインし、Cookie をコピーし直してください。'
          : '出馬表が含まれていません。URLとCookieを確認してください。';
      }
    }
    const parsedPayloadB = parsed.ok ? { rpt: parsed.rpt, horses: parsed.horses } : null;
    const judgmentB = parsed.ok ? buildJudgment(parsed.rpt, parsed.horses) : null;
    res.json({
      ok: true,
      html,
      length: html.length,
      parsed: parsedPayloadB ? { ...parsedPayloadB, judgment: judgmentB } : null,
      hint: hint || undefined,
      requestedUrl: url,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: err.message || 'ブラウザ取得に失敗しました。',
    });
  }
});

// API が常に JSON を返すように（HTML エラーページを防ぐ）
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err.message || 'サーバーエラー' });
});

// ポートが使用中なら 3001, 3002... と順に試す
function startServer(port) {
  const server = app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log('');
    console.log('========================================');
    console.log('  競馬予想ツールを起動しました');
    console.log(`  開くURL: ${url}`);
    console.log('========================================');
    console.log('');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < 3010) {
      console.warn(`ポート ${port} は使用中です。${port + 1} を試します。`);
      startServer(port + 1);
    } else {
      throw err;
    }
  });
}
startServer(DEFAULT_PORT);
