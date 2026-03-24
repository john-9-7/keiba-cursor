/**
 * 競馬クラスター用 Cookie の解決（リクエスト本文 → 環境変数 → サーバー保存ファイル）
 * - live: 今日のリアルタイム追跡用（KEIBA_COOKIE / keiba-session-live.txt / 旧 keiba-session.txt）
 * - archive: 過去開催・DB取り込み用（KEIBA_COOKIE_ARCHIVE / keiba-session-archive.txt）
 */

const fs = require('fs');
const path = require('path');
const { normalizeCookie } = require('./normalizeCookie');
const { resolveDataRoot } = require('./dataRoot');

const DATA_DIR = resolveDataRoot();
const LIVE_FILE = path.join(DATA_DIR, 'keiba-session-live.txt');
const ARCHIVE_FILE = path.join(DATA_DIR, 'keiba-session-archive.txt');
/** 互換: 以前の単一ファイル。live 未作成時はここから読む */
const LEGACY_FILE = path.join(DATA_DIR, 'keiba-session.txt');

function readFileTrim(p) {
  try {
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

/** @returns {'live' | 'archive'} */
function normalizePurpose(p) {
  return p === 'archive' ? 'archive' : 'live';
}

function readLiveRaw() {
  const live = readFileTrim(LIVE_FILE);
  if (live) return live;
  return readFileTrim(LEGACY_FILE);
}

function readArchiveRaw() {
  return readFileTrim(ARCHIVE_FILE);
}

/**
 * リクエストで送られた cookie が空なら、用途に応じた環境変数 → ファイルの順で使う。
 * @param {string|undefined} incoming - クライアントから送られた生の Cookie 文字列
 * @param {'live'|'archive'} [purpose='live']
 * @returns {string} normalizeCookie 済み、または空文字
 */
function resolveKeibaCookie(incoming, purpose = 'live') {
  const raw = typeof incoming === 'string' ? incoming.trim() : '';
  if (raw !== '') {
    return normalizeCookie(raw);
  }
  const p = normalizePurpose(purpose);
  if (p === 'archive') {
    const envA = (process.env.KEIBA_COOKIE_ARCHIVE || '').trim();
    if (envA !== '') return normalizeCookie(envA);
    const fileA = readArchiveRaw();
    if (fileA !== '') return normalizeCookie(fileA);
    return '';
  }
  const env = (process.env.KEIBA_COOKIE || '').trim();
  if (env !== '') return normalizeCookie(env);
  const fileL = readLiveRaw();
  if (fileL !== '') return normalizeCookie(fileL);
  return '';
}

/**
 * @param {string} cookieRaw
 * @param {'live'|'archive'} [purpose='live']
 * @returns {{ ok: boolean, error?: string }}
 */
function saveKeibaSession(cookieRaw, purpose = 'live') {
  const normalized = normalizeCookie((cookieRaw || '').trim());
  if (!normalized || !/laravel_session=/i.test(normalized)) {
    return { ok: false, error: 'laravel_session を含む Cookie を貼り付けてください。' };
  }
  const p = normalizePurpose(purpose);
  const target = p === 'archive' ? ARCHIVE_FILE : LIVE_FILE;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(target, normalized, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'ファイルに保存できませんでした。Render では環境変数の利用を推奨します。' };
  }
}

/**
 * @param {'live'|'archive'} purpose
 */
function clearKeibaSession(purpose) {
  const p = normalizePurpose(purpose);
  try {
    if (p === 'archive') {
      if (fs.existsSync(ARCHIVE_FILE)) fs.unlinkSync(ARCHIVE_FILE);
    } else {
      if (fs.existsSync(LIVE_FILE)) fs.unlinkSync(LIVE_FILE);
      if (fs.existsSync(LEGACY_FILE)) fs.unlinkSync(LEGACY_FILE);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || '削除に失敗しました。' };
  }
}

function getKeibaSessionStatus() {
  const hasEnv = Boolean((process.env.KEIBA_COOKIE || '').trim());
  const hasEnvArchive = Boolean((process.env.KEIBA_COOKIE_ARCHIVE || '').trim());
  const fileLive = readLiveRaw();
  const fileArchive = readArchiveRaw();
  const hasFileLive = Boolean(fileLive);
  const hasFileArchive = Boolean(fileArchive);
  const hasSavedLive = hasEnv || hasFileLive;
  const hasSavedArchive = hasEnvArchive || hasFileArchive;
  return {
    ok: true,
    hasEnv,
    hasEnvArchive,
    hasFileLive,
    hasFileArchive,
    /** 互換: 旧フィールド（いずれかのファイル or いずれかの env） */
    hasFile: hasFileLive || hasFileArchive,
    hasSavedLive,
    hasSavedArchive,
    hasSaved: hasSavedLive || hasSavedArchive,
  };
}

module.exports = {
  resolveKeibaCookie,
  saveKeibaSession,
  clearKeibaSession,
  getKeibaSessionStatus,
  normalizePurpose,
  /** @deprecated 互換: 旧単一セッションファイルパス */
  SESSION_FILE: LEGACY_FILE,
  LIVE_SESSION_FILE: LIVE_FILE,
  ARCHIVE_SESSION_FILE: ARCHIVE_FILE,
};
