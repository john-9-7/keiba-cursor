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
  normalizePurpose,
} = require('./lib/keibaSession');
const { enrichMissingRptFromAnalyzePages } = require('./lib/enrichRaceListRpt');
const { pickDashboardRacesFromListHtml, isPostTimePassed } = require('./lib/dashboardPicks');
const { judgeRace } = require('./lib/judgment');
const {
  appendSnapshot,
  appendResult,
  getAccumulatorStatus,
  readRecentSnapshots,
  getSnapshotsByDate,
  readAllResultsLatestByRaceId,
  getMergedRecent,
  computeStatsFromMerged,
} = require('./lib/raceAccumulator');
/** race-analyze 取得は蓄積ロジックと独立（lib/keibaAnalyzeFetch）。5xx 時はリトライ付き */
const { fetchRaceAnalyzeHtml } = require('./lib/keibaAnalyzeFetch');
const {
  fetchRaceListForDate,
  fetchResultByRaceId,
} = require('./lib/netkeibaResult');
const { set: setRaceCache, get: getRaceCache } = require('./lib/raceCache');

/** 同時取得数。500 対策で既定は 1（直列）。環境変数 DASHBOARD_FETCH_CONCURRENCY で 1〜4 に変更可 */
const DASHBOARD_FETCH_CONCURRENCY = (() => {
  const n = parseInt(process.env.DASHBOARD_FETCH_CONCURRENCY || '1', 10);
  if (Number.isNaN(n) || n < 1) return 1;
  return Math.min(n, 4);
})();
/** レース取得間の待機（ms）。サーバー負荷軽減・500 回避 */
const DASHBOARD_FETCH_DELAY_MS = Math.min(Math.max(parseInt(process.env.DASHBOARD_FETCH_DELAY_MS || '800', 10), 200), 3000);
/** 一覧取得後、最初のレース取得前の待機（ms）。サーバーへの連打を避ける */
const DASHBOARD_INITIAL_DELAY_MS = Math.min(Math.max(parseInt(process.env.DASHBOARD_INITIAL_DELAY_MS || '1200', 10), 0), 5000);
const ACCUMULATE_FETCH_CONCURRENCY = (() => {
  const n = parseInt(process.env.ACCUMULATE_FETCH_CONCURRENCY || '3', 10);
  if (Number.isNaN(n) || n < 1) return 3;
  return Math.min(n, 8);
})();

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
 * Body: { "cookie": "...", "cookiePurpose": "live" | "archive" }
 * live=今日リアルタイム用、archive=過去・DB取り込み用
 */
app.post('/api/keiba-session', (req, res) => {
  const { cookie, cookiePurpose } = req.body || {};
  const result = saveKeibaSession(cookie, normalizePurpose(cookiePurpose));
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }
  const label = normalizePurpose(cookiePurpose) === 'archive' ? '過去・DB用' : '今日リアルタイム用';
  res.json({ ok: true, message: `サーバーに保存しました（${label}）。` });
});

/**
 * DELETE /api/keiba-session
 * Body: { "cookiePurpose": "live" | "archive" } — 該当スロットのファイルのみ削除（環境変数は削除不可）
 */
app.delete('/api/keiba-session', (req, res) => {
  const { cookiePurpose } = req.body || {};
  const result = clearKeibaSession(normalizePurpose(cookiePurpose));
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

  const cookieStr = resolveKeibaCookie(cookie, req.body?.cookiePurpose);
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

/** レース一覧HTMLが有効か（トップページ排除） */
function validateRaceListHtml(html) {
  if (!html || typeof html !== 'string') {
    return { ok: false, error: 'HTMLがありません。' };
  }
  const isTopPage =
    /競馬クラスターWeb|β版/.test(html) &&
    /中央競馬.*南関競馬|race-btn/.test(html.replace(/\s/g, '')) &&
    !/race-container/.test(html);
  if (isTopPage || html.length < 10000) {
    return { ok: false, error: 'トップページが返っています。Cookie を確認してください。' };
  }
  return { ok: true };
}

/**
 * 1会場分を蓄積（レース一覧HTMLは呼び出し元で1回取得したものを渡す）
 * @param {{ listHtml: string, cookieStr: string, date: string, venue: string, purpose: 'live'|'archive', snapshotSource?: string }} p
 */
async function runAccumulateVenueDay(p) {
  const { listHtml, cookieStr, date, venue, purpose } = p;
  const snapshotSource = p.snapshotSource || 'bulk-venue-day';

  const parsed = parseRaceList(listHtml, date, venue);
  if (!parsed.ok || !parsed.races || parsed.races.length === 0) {
    return {
      ok: false,
      meetingDate: date,
      venue,
      error: parsed.error || 'その日付・会場のレースが一覧に見つかりませんでした。',
      total: 0,
      saved: 0,
      skippedDuplicates: 0,
      failed: [],
    };
  }

  await enrichMissingRptFromAnalyzePages(parsed.races, cookieStr, 4);
  const races = parsed.races;
  const results = new Array(races.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= races.length) return;
      const row = races[i];
      const raceId = row.raceId;
      try {
        const fr = await fetchRaceAnalyzeHtml(raceId, cookieStr);
        if (!fr.ok || !fr.html) {
          results[i] = { ok: false, raceId, error: fr.error || `HTTP ${fr.status}` };
          continue;
        }
        const h = fr.html;
        const pr = parseRacePage(h);
        const badPage =
          /競馬クラスターWeb|β版/.test(h) &&
          /race-btn/.test(h.replace(/\s/g, '')) &&
          !(pr.horses && pr.horses.length > 0);
        if (badPage || !pr.horses || pr.horses.length === 0) {
          results[i] = { ok: false, raceId, error: '出馬表を取得できませんでした。' };
          continue;
        }
        const judgment = buildJudgment(pr.rpt, pr.horses);
        const rptPage = pr.rpt != null ? pr.rpt : row.rpt;
        const record = {
          source: snapshotSource,
          cookiePurpose: purpose,
          meetingDate: date,
          venue,
          raceId,
          raceIndex: i + 1,
          startTime: row.startTime || null,
          rptFromList: row.rpt != null ? row.rpt : null,
          rpt: rptPage != null ? rptPage : null,
          horses: pr.horses.map((x) => ({
            horseNumber: x.horseNumber,
            bb: x.bb,
            winOdds: x.winOdds,
          })),
          judgment,
        };
        const snapOut = appendSnapshot(record);
        if (snapOut.skipped) {
          results[i] = { ok: true, raceId, skipped: true, rpt: record.rpt };
        } else {
          results[i] = { ok: true, raceId, skipped: false, rpt: record.rpt };
        }
      } catch (e) {
        results[i] = { ok: false, raceId, error: e.message || '取得エラー' };
      }
    }
  }

  const nW = Math.min(ACCUMULATE_FETCH_CONCURRENCY, races.length);
  await Promise.all(Array.from({ length: nW }, () => worker()));

  const saved = results.filter((x) => x && x.ok && !x.skipped).length;
  const skippedDuplicates = results.filter((x) => x && x.ok && x.skipped).length;
  const failed = results.filter((x) => x && !x.ok).map((x) => ({ raceId: x.raceId, error: x.error || 'unknown' }));
  return { ok: true, meetingDate: date, venue, total: races.length, saved, skippedDuplicates, failed };
}

/**
 * POST /api/race-list
 * Body: { "cookie": "..." , "date"?: "2026-03-15" , "venue"?: "中山" }
 * レース一覧ページを取得し、日付・会場の一覧、または指定日付・会場のレース一覧（race_id 付き）を返す。
 */
app.post('/api/race-list', async (req, res) => {
  const { cookie, date, venue } = req.body || {};
  const cookieStr = resolveKeibaCookie(cookie, req.body?.cookiePurpose);

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
 * GET /api/accumulate/status
 * 蓄積ファイルの件数と保存パス（サーバー上の絶対パス）を返す。
 */
app.get('/api/accumulate/status', (req, res) => {
  try {
    res.json({ ok: true, ...getAccumulatorStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '取得に失敗しました。' });
  }
});

/**
 * GET /api/accumulate/recent?limit=50
 * snapshots.jsonl の末尾 N 件（生データ・突合なし）
 */
app.get('/api/accumulate/recent', (req, res) => {
  try {
    const raw = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
    const rows = readRecentSnapshots(raw);
    res.json({ ok: true, limit: raw, count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '取得に失敗しました。' });
  }
});

/**
 * GET /api/accumulate/merged?limit=100
 * 末尾 N 件のスナップショットに results.jsonl を race_id で突合
 */
app.get('/api/accumulate/merged', (req, res) => {
  try {
    const raw = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const rows = getMergedRecent(raw);
    res.json({ ok: true, limit: raw, count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '取得に失敗しました。' });
  }
});

/**
 * GET /api/accumulate/stats?limit=300
 * 末尾 N 件を突合したうえで RPT 別集計・簡易指標
 */
app.get('/api/accumulate/stats', (req, res) => {
  try {
    const raw = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 10), 2000);
    const merged = getMergedRecent(raw);
    const stats = computeStatsFromMerged(merged);
    res.json({ ok: true, limitUsed: raw, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '取得に失敗しました。' });
  }
});

/**
 * POST /api/accumulate/bulk-venue
 * 指定日付・会場のレース一覧（通常12R）を取得し、各レースの出馬表・判定を data/accumulated/snapshots.jsonl に追記する。
 * Body: { "cookie"?: "...", "cookiePurpose"?: "archive"|"live", "date": "2026-03-15", "venue": "中山" }
 */
app.post('/api/accumulate/bulk-venue', async (req, res) => {
  const { cookie, date, venue } = req.body || {};
  if (!date || !venue || typeof date !== 'string' || typeof venue !== 'string') {
    return res.status(400).json({ ok: false, error: 'date と venue を指定してください（例: date=2026-03-15, venue=中山）。' });
  }
  const purposeForCookie =
    req.body?.cookiePurpose === 'live' || req.body?.cookiePurpose === 'archive'
      ? req.body.cookiePurpose
      : 'archive';
  const cookieStr = resolveKeibaCookie(cookie, purposeForCookie);
  const listHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: 'https://web.keibacluster.com/top/race-list',
  };
  if (cookieStr) listHeaders.Cookie = cookieStr;

  try {
    if (!cookieStr) {
      return res.status(400).json({
        ok: false,
        error: '競馬クラスターの Cookie がありません。',
        hint: '過去開催なら analyze ページで「過去・DB用として保存」するか、cookiePurpose=archive で送信してください。',
      });
    }

    const response = await fetch(RACE_LIST_URL, { method: 'GET', headers: listHeaders, redirect: 'follow' });
    if (!response.ok) {
      return res.status(200).json({ ok: false, error: `レース一覧: HTTP ${response.status}` });
    }
    const html = await response.text();
    const v = validateRaceListHtml(html);
    if (!v.ok) {
      return res.status(200).json({ ok: false, error: v.error });
    }

    const purpose = normalizePurpose(purposeForCookie);
    const out = await runAccumulateVenueDay({
      listHtml: html,
      cookieStr,
      date,
      venue,
      purpose,
      snapshotSource: 'bulk-venue-day',
    });

    if (!out.ok) {
      return res.status(200).json({
        ok: false,
        error: out.error || 'レースが見つかりませんでした。',
        hint: '競馬クラスターでその開催を表示したうえで、日付は data-date と同じ表記、会場名も一覧と同じにしてください。',
      });
    }

    res.json({
      ok: true,
      meetingDate: out.meetingDate,
      venue: out.venue,
      total: out.total,
      saved: out.saved,
      skippedDuplicates: out.skippedDuplicates || 0,
      failed: out.failed,
      accumulator: getAccumulatorStatus(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || '一括蓄積に失敗しました。' });
  }
});

/**
 * POST /api/accumulate/bulk-all-list
 * レース一覧ページに載っている日付×会場の組み合わせをすべて順に蓄積する（全会場・各会場の全レース）。
 * Body: { "cookie"?, "cookiePurpose"?, "date"?: "2026-03-15" }
 * - date を省略 … 一覧に出ているすべての開催を対象
 * - date を指定 … その日付の会場だけ対象（その日の全コース一括向け）
 */
app.post('/api/accumulate/bulk-all-list', async (req, res) => {
  const purposeForCookie =
    req.body?.cookiePurpose === 'live' || req.body?.cookiePurpose === 'archive'
      ? req.body.cookiePurpose
      : 'archive';
  const cookieStr = resolveKeibaCookie(req.body?.cookie, purposeForCookie);
  const listHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    Referer: 'https://web.keibacluster.com/top/race-list',
  };
  if (cookieStr) listHeaders.Cookie = cookieStr;

  const dateFilter =
    req.body?.date && typeof req.body.date === 'string' && req.body.date.trim()
      ? req.body.date.trim()
      : null;

  try {
    if (!cookieStr) {
      return res.status(400).json({
        ok: false,
        error: '競馬クラスターの Cookie がありません。',
        hint: '過去・DB用 Cookie を保存するか、環境変数 KEIBA_COOKIE_ARCHIVE を設定してください。',
      });
    }

    const response = await fetch(RACE_LIST_URL, { method: 'GET', headers: listHeaders, redirect: 'follow' });
    if (!response.ok) {
      return res.status(200).json({ ok: false, error: `レース一覧: HTTP ${response.status}` });
    }
    const html = await response.text();
    const v = validateRaceListHtml(html);
    if (!v.ok) {
      return res.status(200).json({ ok: false, error: v.error });
    }

    const list = listDatesAndVenues(html);
    if (!list.ok || !list.items || list.items.length === 0) {
      return res.status(200).json({
        ok: false,
        error: list.error || '日付・会場の一覧が取得できませんでした。',
      });
    }

    const seen = new Set();
    /** @type {Array<{ date: string, venue: string }>} */
    let pairs = [];
    for (const it of list.items) {
      if (dateFilter && it.date !== dateFilter) continue;
      const key = `${it.date}\t${it.venue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ date: it.date, venue: it.venue });
    }

    if (pairs.length === 0) {
      return res.status(200).json({
        ok: false,
        error: dateFilter ? `日付「${dateFilter}」の開催が一覧にありません。` : '開催の組み合わせがありません。',
      });
    }

    const purpose = normalizePurpose(purposeForCookie);
    const startedAt = Date.now();
    /** @type {Array<Record<string, unknown>>} */
    const venues = [];
    let totalSaved = 0;
    let totalSkippedDuplicates = 0;
    let totalFailed = 0;
    let totalRaces = 0;

    for (const pair of pairs) {
      const out = await runAccumulateVenueDay({
        listHtml: html,
        cookieStr,
        date: pair.date,
        venue: pair.venue,
        purpose,
        snapshotSource: 'bulk-all-list',
      });
      const failedCount = out.failed ? out.failed.length : 0;
      const skippedDup = out.skippedDuplicates || 0;
      if (out.ok) {
        totalSaved += out.saved;
        totalSkippedDuplicates += skippedDup;
        totalFailed += failedCount;
        totalRaces += out.total;
      }
      venues.push({
        date: pair.date,
        venue: pair.venue,
        ok: out.ok,
        error: out.ok ? undefined : out.error,
        total: out.total,
        saved: out.saved,
        skippedDuplicates: skippedDup,
        failedCount,
        failedSample: out.failed && out.failed.length ? out.failed.slice(0, 5) : [],
      });
    }

    const durationMs = Date.now() - startedAt;

    res.json({
      ok: true,
      dateFilter: dateFilter || null,
      venueBlocks: pairs.length,
      totalRaces,
      totalSaved,
      totalSkippedDuplicates,
      totalFailed,
      durationMs,
      venues,
      accumulator: getAccumulatorStatus(),
      hint:
        '処理に数分〜十数分かかることがあります。Render 等で HTTP タイムアウト（30秒など）のときは、このAPIは途中で切れることがあります。Request timeout を延ばすか、date で1日分に絞るか、会場単位の「bulk-venue」を利用してください。',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || '全会場一括に失敗しました。' });
  }
});

/**
 * POST /api/accumulate/save-race
 * 1レースだけ取得して snapshots.jsonl に追記（今日のレースページからでも利用可）
 * Body: { "cookie"?, "cookiePurpose"?, "raceId": number, "meetingDate"?, "venue"?, "note"? }
 */
app.post('/api/accumulate/save-race', async (req, res) => {
  const { cookie, raceId, meetingDate, venue, note } = req.body || {};
  const id = parseInt(raceId, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'raceId を指定してください。' });
  }
  const purposeForCookie =
    req.body?.cookiePurpose === 'live' || req.body?.cookiePurpose === 'archive'
      ? req.body.cookiePurpose
      : 'archive';
  const cookieStr = resolveKeibaCookie(cookie, purposeForCookie);
  const purpose = normalizePurpose(purposeForCookie);

  try {
    if (!cookieStr) {
      return res.status(400).json({ ok: false, error: 'Cookie がありません。' });
    }
    const fr = await fetchRaceAnalyzeHtml(id, cookieStr);
    if (!fr.ok || !fr.html) {
      return res.status(200).json({ ok: false, error: fr.error || `HTTP ${fr.status}` });
    }
    const html = fr.html;
    const parsed = parseRacePage(html);
    const isTopPage =
      /競馬クラスターWeb|β版/.test(html) &&
      /race-btn/.test(html.replace(/\s/g, '')) &&
      !(parsed.horses && parsed.horses.length > 0);
    if (isTopPage || !parsed.horses || parsed.horses.length === 0) {
      return res.status(200).json({ ok: false, error: '出馬表を取得できませんでした。' });
    }
    const judgment = buildJudgment(parsed.rpt, parsed.horses);
    const record = {
      source: 'single-race',
      cookiePurpose: purpose,
      meetingDate: meetingDate && String(meetingDate).trim() ? String(meetingDate).trim() : null,
      venue: venue && String(venue).trim() ? String(venue).trim() : null,
      raceId: id,
      rpt: parsed.rpt != null ? parsed.rpt : null,
      horses: parsed.horses.map((x) => ({
        horseNumber: x.horseNumber,
        bb: x.bb,
        winOdds: x.winOdds,
      })),
      judgment,
      note: note && String(note).trim() ? String(note).trim() : null,
    };
    const snapOut = appendSnapshot(record);
    if (snapOut.skipped) {
      return res.json({
        ok: true,
        duplicate: true,
        message: '同じ race_id は既に蓄積済みのため、追記しませんでした。',
        raceId: id,
        rpt: record.rpt,
        judgment,
        accumulator: getAccumulatorStatus(),
      });
    }
    res.json({
      ok: true,
      duplicate: false,
      raceId: id,
      rpt: record.rpt,
      judgment,
      accumulator: getAccumulatorStatus(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || '保存に失敗しました。' });
  }
});

/**
 * POST /api/accumulate/result
 * レース結果を results.jsonl に追記（後から RPT・判定と突合する用）
 * Body: { "raceId": number, "first"?: number, "second"?: number, "third"?: number, "finishOrder"?: number[], "note"?: string }
 */
app.post('/api/accumulate/result', (req, res) => {
  const { raceId, first, second, third, finishOrder, note } = req.body || {};
  const id = parseInt(raceId, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'raceId を指定してください。' });
  }
  try {
    appendResult({
      raceId: id,
      first: first != null ? parseInt(first, 10) : undefined,
      second: second != null ? parseInt(second, 10) : undefined,
      third: third != null ? parseInt(third, 10) : undefined,
      finishOrder: Array.isArray(finishOrder) ? finishOrder.map((n) => parseInt(n, 10)).filter((n) => !Number.isNaN(n)) : undefined,
      note,
    });
    res.json({ ok: true, accumulator: getAccumulatorStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '記録に失敗しました。' });
  }
});

/**
 * POST /api/accumulate/fetch-results
 * netkeiba から指定日のレース結果を取得し results.jsonl に追記
 * Body: { "date": "2026-03-15" } … 対象日（YYYY-MM-DD）
 * 蓄積済みスナップショットのうち meetingDate が一致し、結果未登録のレースのみ取得
 */
const FETCH_RESULTS_CONCURRENCY = Math.min(Math.max(parseInt(process.env.FETCH_RESULTS_CONCURRENCY || '2', 10), 1), 4);
app.post('/api/accumulate/fetch-results', async (req, res) => {
  const { date } = req.body || {};
  const dateStr = String(date || '').trim();
  if (!dateStr || !/^\d{4}[-/]?\d{1,2}[-/]?\d{1,2}$/.test(dateStr.replace(/-/g, '-'))) {
    return res.status(400).json({ ok: false, error: 'date を指定してください（例: 2026-03-15）。' });
  }
  try {
    const snaps = getSnapshotsByDate(dateStr, 500);
    if (snaps.length === 0) {
      return res.json({
        ok: true,
        date: dateStr,
        message: '指定日の蓄積スナップショットがありません。',
        fetched: 0,
        skipped: 0,
        failed: 0,
        accumulator: getAccumulatorStatus(),
      });
    }
    const existing = readAllResultsLatestByRaceId();
    const listRes = await fetchRaceListForDate(dateStr);
    if (!listRes.ok || !listRes.map) {
      return res.status(502).json({
        ok: false,
        error: listRes.error || 'netkeiba のレース一覧を取得できませんでした。',
      });
    }
    const map = listRes.map;
    const toFetch = snaps.filter((s) => {
      const rid = s.raceId != null ? Number(s.raceId) : NaN;
      if (Number.isNaN(rid) || rid < 1) return false;
      if (existing.has(rid)) return false;
      const venue = (s.venue || '').trim();
      const idx = s.raceIndex != null ? Number(s.raceIndex) : NaN;
      if (!venue || Number.isNaN(idx) || idx < 1) return false;
      const key = `${venue}\t${idx}`;
      return map.has(key);
    });
    const results = { fetched: 0, skipped: snaps.length - toFetch.length, failed: 0, errors: [] };
    let cursor = 0;
    async function worker() {
      for (;;) {
        const i = cursor++;
        if (i >= toFetch.length) return;
        const s = toFetch[i];
        const rid = Number(s.raceId);
        const key = `${(s.venue || '').trim()}\t${Number(s.raceIndex)}`;
        const netkeibaId = map.get(key);
        if (!netkeibaId) {
          results.skipped += 1;
          return;
        }
        const fr = await fetchResultByRaceId(netkeibaId);
        if (!fr.ok || !fr.result) {
          results.failed += 1;
          results.errors.push({ raceId: rid, venue: s.venue, error: fr.error || '取得失敗' });
          return;
        }
        try {
          appendResult({
            raceId: rid,
            first: fr.result.first,
            second: fr.result.second,
            third: fr.result.third,
            finishOrder: fr.result.finishOrder,
            note: `netkeiba自動取得 ${netkeibaId}`,
          });
          results.fetched += 1;
        } catch (e) {
          results.failed += 1;
          results.errors.push({ raceId: rid, error: e.message });
        }
      }
    }
    const n = Math.min(FETCH_RESULTS_CONCURRENCY, toFetch.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    res.json({
      ok: true,
      date: dateStr,
      fetched: results.fetched,
      skipped: results.skipped,
      failed: results.failed,
      errors: results.errors.length > 0 ? results.errors.slice(0, 10) : undefined,
      accumulator: getAccumulatorStatus(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || '結果取得に失敗しました。' });
  }
});

/**
 * POST /api/dashboard
 * レース一覧HTMLを1回取得し、JST基準の対象日×全会場で「発走が現在に最も近い」レースを自動選択、
 * 各レースの出馬表・オッズ・判定をまとめて返す（更新ボタンでも同API）。
 */
app.post('/api/dashboard', async (req, res) => {
  const { cookie } = req.body || {};
  const cookieStr = resolveKeibaCookie(cookie, req.body?.cookiePurpose);
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
          '競馬クラスターで「レース一覧」画面を一度表示したうえで Cookie を取り直すと改善することがあります。HTMLに .race-container または allRaces データが含まれていない可能性があります。下の「従来の手順」で日付・会場を選んでください。',
      });
    }

    const items = new Array(picks.length);
    let cursor = 0;
    let fetchCount = 0;
    const nowMs = Date.now();

    if (DASHBOARD_INITIAL_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, DASHBOARD_INITIAL_DELAY_MS));
    }

    async function dashboardWorker() {
      for (;;) {
        const idx = cursor;
        cursor += 1;
        if (idx >= picks.length) return;
        const p = picks[idx];
        try {
          if (isPostTimePassed(dateNorm, p.startTime, nowMs)) {
            items[idx] = {
              ok: false,
              venue: p.venue,
              raceId: p.raceId,
              raceNumber: p.raceNumber,
              startTime: p.startTime,
              rpt: p.rpt,
              deltaMinutes: p.deltaMinutes,
              skipped: true,
              error: '発走済み',
            };
            continue;
          }
          if (fetchCount > 0 || DASHBOARD_FETCH_DELAY_MS > 0) {
            await new Promise((r) => setTimeout(r, DASHBOARD_FETCH_DELAY_MS));
          }
          fetchCount += 1;
          const fr = await fetchRaceAnalyzeHtml(p.raceId, cookieStr, {
            maxAttempts: 4,
            baseDelayMs: 1000,
            timeoutMs: 18000,
            referer: 'https://web.keibacluster.com/top/race-list',
          });
          if (!fr.ok || !fr.html) {
            items[idx] = {
              ok: false,
              venue: p.venue,
              raceId: p.raceId,
              raceNumber: p.raceNumber,
              startTime: p.startTime,
              rpt: p.rpt,
              deltaMinutes: p.deltaMinutes,
              error: fr.error || `HTTP ${fr.status}`,
            };
            continue;
          }
          const h = fr.html;
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
          let judgment;
          try {
            judgment = buildJudgment(parsed.rpt, parsed.horses);
          } catch (jErr) {
            items[idx] = {
              ok: false,
              venue: p.venue,
              raceId: p.raceId,
              raceNumber: p.raceNumber,
              startTime: p.startTime,
              rpt: p.rpt,
              deltaMinutes: p.deltaMinutes,
              error: `判定エラー: ${jErr.message || 'unknown'}`,
            };
            continue;
          }
          setRaceCache(p.raceId, parsed.rpt, parsed.horses);
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
  const cookieStr = resolveKeibaCookie(cookie, req.body?.cookiePurpose);
  try {
    if (!cookieStr) {
      return res.status(400).json({
        ok: false,
        error: '競馬クラスターの Cookie がありません。',
        hint: 'PCで Cookie を貼って「サーバーに保存」するか、環境変数 KEIBA_COOKIE を設定してください。',
      });
    }

    const fr = await fetchRaceAnalyzeHtml(id, cookieStr);
    if (!fr.ok || !fr.html) {
      return res.status(200).json({ ok: false, error: fr.error || `HTTP ${fr.status}` });
    }
    const html = fr.html;
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
    setRaceCache(id, parsed.rpt, parsed.horses);
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
 * POST /api/judge-with-odds
 * キャッシュ済みの RPT・BB に直前オッズを渡して再判定
 * Body: { "raceId": number, "oddsText": "4=3.2, 8=15.5, 1=4.1" } … 馬番=単勝オッズ、カンマ区切り
 */
app.post('/api/judge-with-odds', (req, res) => {
  const { raceId, oddsText } = req.body || {};
  const id = parseInt(raceId, 10);
  if (Number.isNaN(id) || id < 1) {
    return res.status(400).json({ ok: false, error: 'raceId を指定してください。' });
  }
  const cached = getRaceCache(id);
  if (!cached) {
    return res.status(404).json({
      ok: false,
      error: 'このレースの RPT・BB がキャッシュにありません。',
      hint: '先に「データ取得」または「レース詳細の取得」で成功させてから、直前オッズを入力してください。',
    });
  }
  const oddsMap = {};
  const text = String(oddsText || '').trim();
  if (text) {
    for (const part of text.split(/[,，、\s]+/)) {
      const m = part.match(/^(\d{1,2})\s*[=＝:]\s*([\d.]+)$/);
      if (m) {
        const num = parseInt(m[1], 10);
        const o = parseFloat(m[2]);
        if (num >= 1 && num <= 18 && !Number.isNaN(o) && o > 0) {
          oddsMap[num] = o;
        }
      }
    }
  }
  const horses = cached.horses.map((h) => ({
    horseNumber: h.horseNumber,
    bb: h.bb,
    winOdds: oddsMap[h.horseNumber] ?? null,
  }));
  try {
    const judgment = buildJudgment(cached.rpt, horses);
    res.json({
      ok: true,
      raceId: id,
      rpt: cached.rpt,
      judgment,
      horses: horses.map((h) => ({ horseNumber: h.horseNumber, bb: h.bb, winOdds: h.winOdds })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || '判定エラー' });
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

  const cookieStr = resolveKeibaCookie(cookie, req.body?.cookiePurpose);
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
