#!/usr/bin/env node
/**
 * 最新の smoke-*.json を読んで、失敗要因を短く要約表示する。
 * 使い方:
 *   npm run test:smoke:report
 * 環境変数:
 *   SMOKE_LOG_DIR=logs
 *   SMOKE_REPORT_FILE=logs/smoke-20260324-000000.json
 */

const fs = require('node:fs');
const path = require('node:path');

function pickLatestJson(logDir) {
  if (!fs.existsSync(logDir)) return null;
  const files = fs
    .readdirSync(logDir)
    .filter((f) => /^smoke-\d{8}-\d{6}\.json$/.test(f))
    .sort();
  if (files.length === 0) return null;
  return path.join(logDir, files[files.length - 1]);
}

function actionByTags(tags) {
  const s = new Set(tags || []);
  if (s.has('AUTH')) return 'Basic認証のID/パスワード、または認証有効化設定を確認';
  if (s.has('SESSION')) return '保存済みCookie/KEIBA_COOKIE/KEIBA_COOKIE_ARCHIVE の有無を確認';
  if (s.has('NETWORK')) return 'SMOKE_BASE_URL とサーバー起動状態（localhost/Render）を確認';
  if (s.has('TIMEOUT')) return 'SMOKE_TIMEOUT_MS を増やし、対象サーバーの応答時間を確認';
  if (s.has('HTTP_5XX')) return 'サーバーログを確認し、500系エラーのAPIを特定';
  if (s.has('HTTP_4XX')) return 'リクエスト先URL・認証・入力値を確認';
  return 'ログ末尾の summary と stdout/stderr tail を確認';
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const logDir = process.env.SMOKE_LOG_DIR
    ? path.resolve(projectRoot, process.env.SMOKE_LOG_DIR)
    : path.resolve(projectRoot, 'logs');
  const reportFile = process.env.SMOKE_REPORT_FILE
    ? path.resolve(projectRoot, process.env.SMOKE_REPORT_FILE)
    : pickLatestJson(logDir);

  if (!reportFile || !fs.existsSync(reportFile)) {
    console.error('❌ smoke report: 対象JSONが見つかりません。先に `npm run test:smoke:all` を実行してください。');
    process.exit(1);
  }

  const raw = fs.readFileSync(reportFile, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`❌ smoke report: JSON解析に失敗しました: ${reportFile}`);
    process.exit(1);
  }

  const results = Array.isArray(data.results) ? data.results : [];
  console.log('--- smoke report ---');
  console.log(`file: ${reportFile}`);
  console.log(`runId: ${data.runId || '-'}`);
  console.log(`success: ${!!data.success}`);
  console.log(`durationMs: ${data.durationMs ?? '-'}`);
  console.log(`modes: ${(data.modes || []).join(', ')}`);

  if (results.length === 0) {
    console.log('results: 0');
    process.exit(data.success ? 0 : 1);
  }

  for (const r of results) {
    const tags = Array.isArray(r.tags) ? r.tags : [];
    console.log(
      `- mode=${r.mode} ok=${r.ok} code=${r.code} durationMs=${r.durationMs} tags=${tags.join('|') || '-'}`
    );
    console.log(`  summary: ${r.summary || '-'}`);
    if (!r.ok) {
      console.log(`  next: ${actionByTags(tags)}`);
    }
  }

  if (data.success) {
    console.log('✅ smoke report: all green');
    process.exit(0);
  }

  console.log('❌ smoke report: failed mode あり');
  process.exit(1);
}

main();

