/**
 * 蓄積・セッション・キャッシュなど「消えてほしくないデータ」のルート。
 * - KEIBA_DATA_DIR … 最優先（任意：手元PCや自前サーバーの保存先を明示）
 * - Render で /var/keiba-data が存在 … 永続マウントがある場合のみ（Free プランでは通常なし）
 * - それ以外 … リポジトリ内 data/
 */

const fs = require('fs');
const path = require('path');

const PROJECT_DATA = path.join(__dirname, '..', 'data');
/** Render の render.yaml / 手動追加ディスクで使うマウントパス（Disallowed 一覧に無いスタンドアロン） */
const RENDER_DEFAULT_MOUNT = '/var/keiba-data';

function resolveDataRoot() {
  if (process.env.KEIBA_DATA_DIR) {
    return path.resolve(process.env.KEIBA_DATA_DIR);
  }
  if (String(process.env.RENDER || '').toLowerCase() === 'true') {
    try {
      if (fs.existsSync(RENDER_DEFAULT_MOUNT)) {
        return RENDER_DEFAULT_MOUNT;
      }
    } catch {
      /* ignore */
    }
  }
  return PROJECT_DATA;
}

/** Render 上でプロジェクト内 data に逃がしている＝エフェメラルで消えやすい */
function isRenderEphemeralRisk(dataRoot) {
  return (
    String(process.env.RENDER || '').toLowerCase() === 'true' &&
    path.resolve(dataRoot) === path.resolve(PROJECT_DATA)
  );
}

module.exports = {
  resolveDataRoot,
  isRenderEphemeralRisk,
  PROJECT_DATA,
  RENDER_DEFAULT_MOUNT,
};
