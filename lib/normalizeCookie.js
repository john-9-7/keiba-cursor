/**
 * ユーザーが「値だけ」を貼り付けた場合に、Cookie ヘッダ用の文字列に補完する。
 * 正しい形式: laravel_session=値; XSRF-TOKEN=値
 */

/**
 * @param {string} raw - ユーザーが貼り付けた文字列（値のみ or すでに laravel_session=... の形）
 * @returns {string} Cookie ヘッダにそのまま渡せる文字列
 */
function normalizeCookie(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';

  // すでに laravel_session= を含む場合はそのまま（必要なら XSRF-TOKEN を補う）
  if (s.includes('laravel_session=')) {
    if (s.includes('XSRF-TOKEN=')) return s;
    // 1行だけの可能性: laravel_session=xxx のみ → そのまま返す
    return s;
  }

  // 値だけが貼られている場合
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    // 2行以上: 1行目=laravel_session, 2行目=XSRF-TOKEN
    return `laravel_session=${lines[0]}; XSRF-TOKEN=${lines[1]}`;
  }
  if (lines.length === 1) {
    const one = lines[0];
    // 1行で "値1;値2" の形（セミコロンで区切られた2つの値）の場合
    if (one.includes(';') && !one.startsWith('laravel_session=') && !one.startsWith('XSRF-TOKEN=')) {
      const parts = one.split(';').map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        return `laravel_session=${parts[0]}; XSRF-TOKEN=${parts[1]}`;
      }
    }
    // 1行のみ → laravel_session の値とみなす
    return `laravel_session=${one}`;
  }
  return s;
}

module.exports = { normalizeCookie };
