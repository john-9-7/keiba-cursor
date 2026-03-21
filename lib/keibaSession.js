/**
 * 競馬クラスター用 Cookie の解決（リクエスト本文 → 環境変数 → サーバー保存ファイル）
 * iPhone では毎回貼り付けなくてよいようにする。
 */

const fs = require('fs');
const path = require('path');
const { normalizeCookie } = require('./normalizeCookie');

const SESSION_FILE = path.join(__dirname, '..', 'data', 'keiba-session.txt');

function readFileSessionRaw() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return '';
    const s = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    return s;
  } catch (e) {
    return '';
  }
}

/**
 * リクエストで送られた cookie が空なら、KEIBA_COOKIE 環境変数 → data/keiba-session.txt の順で使う。
 * @param {string|undefined} incoming - クライアントから送られた生の Cookie 文字列
 * @returns {string} normalizeCookie 済み、または空文字
 */
function resolveKeibaCookie(incoming) {
  const raw = typeof incoming === 'string' ? incoming.trim() : '';
  if (raw !== '') {
    return normalizeCookie(raw);
  }
  const env = (process.env.KEIBA_COOKIE || '').trim();
  if (env !== '') {
    return normalizeCookie(env);
  }
  const file = readFileSessionRaw();
  if (file !== '') {
    return normalizeCookie(file);
  }
  return '';
}

/**
 * サーバーに Cookie を保存（data/keiba-session.txt）
 * @param {string} cookieRaw
 * @returns {{ ok: boolean, error?: string }}
 */
function saveKeibaSession(cookieRaw) {
  const normalized = normalizeCookie((cookieRaw || '').trim());
  if (!normalized || !/laravel_session=/i.test(normalized)) {
    return { ok: false, error: 'laravel_session を含む Cookie を貼り付けてください。' };
  }
  try {
    const dir = path.dirname(SESSION_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SESSION_FILE, normalized, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || 'ファイルに保存できませんでした。Render では環境変数 KEIBA_COOKIE の利用を推奨します。' };
  }
}

function clearKeibaSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || '削除に失敗しました。' };
  }
}

function getKeibaSessionStatus() {
  const hasEnv = Boolean((process.env.KEIBA_COOKIE || '').trim());
  const fileRaw = readFileSessionRaw();
  const hasFile = Boolean(fileRaw);
  return {
    ok: true,
    hasEnv,
    hasFile,
    hasSaved: hasEnv || hasFile,
  };
}

module.exports = {
  resolveKeibaCookie,
  saveKeibaSession,
  clearKeibaSession,
  getKeibaSessionStatus,
  SESSION_FILE,
};
