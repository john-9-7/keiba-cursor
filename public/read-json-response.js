/**
 * fetch が届かなかったときのメッセージ（初心者向け）
 * @param {Error} e
 * @returns {string}
 */
function formatFetchErrorDetail(e) {
  var m = e && e.message ? String(e.message) : '不明なエラー';
  if (
    m === 'Failed to fetch' ||
    /NetworkError|Failed to fetch|Load failed|Network request failed|fetch failed/i.test(m)
  ) {
    return (
      m +
      '\n\n【よくある原因】\n' +
      '1. PCで npm start をしてサーバーが動いているか\n' +
      '2. ブラウザのアドレスが http://localhost:3000 か（npm start 画面の「開くURL」と同じ番号か。3001 などの場合もあります）\n' +
      '3. HTMLをダブルクリックで開いていないか（ファイル:/// ではAPIに届きません）\n' +
      '4. ウイルス対策ソフトが Node.js をブロックしていないか'
    );
  }
  return m;
}

/**
 * fetch の Response を安全に JSON 化（HTML エラーページ・タイムアウト画面対策）
 * @param {Response} res
 * @returns {Promise<any>}
 */
async function readJsonResponse(res) {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      'サーバーから空の応答です（HTTP ' + res.status + '）。URL・サーバー起動を確認してください。',
    );
  }
  if (trimmed.charAt(0) === '<' || /<!DOCTYPE/i.test(trimmed)) {
    let hint = '';
    if (res.status === 401) hint = ' Basic認証（ID/パスワード）を確認してください。';
    else if (res.status === 404) hint = ' URLが間違っているか、APIがありません。';
    else if (res.status === 502 || res.status === 504) {
      hint =
        ' ホスティングのタイムアウトやプロキシエラーの可能性があります。日付を1日に絞る・ローカルで実行、などを試してください。';
    } else if (res.status >= 500) hint = ' サーバー側エラーの可能性があります。';
    throw new Error(
      'サーバーがJSONではなくHTMLを返しました（HTTP ' + res.status + '）。' + hint,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('JSONの解析に失敗しました（HTTP ' + res.status + '）。');
  }
}
