/**
 * Cookie と URL の検証スクリプト
 * scripts/verify-input.txt の1行目=URL、2行目以降=Cookie として取得を試し、結果を表示する。
 * 使い方: 1) verify-input.txt に URL と Cookie を書く  2) node scripts/verify-fetch.js
 */

const fs = require('fs');
const path = require('path');
const { normalizeCookie } = require('../lib/normalizeCookie');
const { parseRacePage } = require('../lib/parseRacePage');

const inputPath = path.join(__dirname, 'verify-input.txt');

async function run() {
  let content;
  try {
    content = fs.readFileSync(inputPath, 'utf8');
  } catch (e) {
    console.error('verify-input.txt を開けません。scripts/verify-input.txt の1行目にURL、2行目以降にCookieを書いてください。');
    process.exit(1);
  }

  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    console.error('verify-input.txt に URL（1行目）と Cookie（2行目以降）を書いてください。');
    process.exit(1);
  }

  const url = lines[0];
  const cookieRaw = lines.slice(1).join('\n');
  const cookie = normalizeCookie(cookieRaw);

  console.log('--- 検証開始 ---');
  console.log('URL:', url);
  console.log('Cookie 長さ:', cookie.length, '文字');
  console.log('Cookie 先頭:', cookie.slice(0, 50) + '...');
  if (!cookie.includes('laravel_session=')) {
    console.log('⚠ 補完後も laravel_session= が含まれていません。');
  }
  if (cookie.includes('laravel_session=') && !cookie.includes('XSRF-TOKEN=')) {
    console.log('ℹ XSRF-TOKEN は含まれていません（laravel_session のみ送信）。');
  }
  console.log('');

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': 'https://web.keibacluster.com/top/race-analyze-next',
  };
  if (cookie) headers['Cookie'] = cookie;

  try {
    const res = await fetch(url, { method: 'GET', headers, redirect: 'follow' });
    console.log('HTTP ステータス:', res.status, res.statusText);
    const html = await res.text();
    console.log('HTML 文字数:', html.length);

    const isTopPage = /競馬クラスターWeb|β版/.test(html) && /中央競馬.*南関競馬|race-btn/.test(html.replace(/\s/g, '')) && !/race-horses-table|出馬表/.test(html);
    const hasTable = /race-horses-table|出馬表/.test(html);

    if (res.status !== 200) {
      console.log('');
      console.log('❌ 結果: HTTP エラー');
      return;
    }
    if (isTopPage || (html.length < 20000 && !hasTable)) {
      console.log('');
      console.log('❌ 結果: トップページ（またはログイン要求ページ）が返っています。');
      console.log('   → Cookie の有効期限、または「出馬表を表示したタブ」でコピーし直してください。');
      return;
    }
    if (hasTable) {
      const parsed = parseRacePage(html);
      if (parsed.ok && parsed.horses && parsed.horses.length > 0) {
        console.log('');
        console.log('✅ 結果: 出馬表を取得できました。');
        console.log('   RPT:', parsed.rpt ?? '—');
        console.log('   頭数:', parsed.horses.length);
        console.log('   先頭3頭:', parsed.horses.slice(0, 3).map((h) => `馬${h.horseNumber} BB${h.bb} オッズ${h.winOdds}`).join(', '));
      } else {
        console.log('');
        console.log('⚠ 結果: 出馬表らしきHTMLはありますが、パースで馬データを取り出せませんでした。');
      }
      return;
    }
    console.log('');
    console.log('⚠ 結果: トップでも出馬表でもないページが返りました。');
  } catch (err) {
    console.error('エラー:', err.message);
    process.exit(1);
  }
}

run();
