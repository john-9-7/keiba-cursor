/**
 * 分析用レーススナップショットの蓄積（JSONL・追記のみ）
 * - data/accumulated/snapshots.jsonl … 取得時点の RPT・馬柱・判定 など
 * - data/accumulated/results.jsonl   … 後から突合する着順（任意）
 */

const fs = require('fs');
const path = require('path');

const ACC_DIR = path.join(__dirname, '..', 'data', 'accumulated');
const SNAPSHOTS_FILE = path.join(ACC_DIR, 'snapshots.jsonl');
const RESULTS_FILE = path.join(ACC_DIR, 'results.jsonl');

function ensureDir() {
  if (!fs.existsSync(ACC_DIR)) {
    fs.mkdirSync(ACC_DIR, { recursive: true });
  }
}

/**
 * @param {object} record
 */
function appendSnapshot(record) {
  ensureDir();
  const line = JSON.stringify({
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    ...record,
  });
  fs.appendFileSync(SNAPSHOTS_FILE, `${line}\n`, 'utf8');
  return { ok: true, file: SNAPSHOTS_FILE };
}

/**
 * 着順など結果を別ファイルに追記（race_id で後から突合）
 * @param {{ raceId: number, first?: number, second?: number, third?: number, finishOrder?: number[], note?: string }} row
 */
function appendResult(row) {
  ensureDir();
  const line = JSON.stringify({
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    raceId: row.raceId,
    first: row.first ?? null,
    second: row.second ?? null,
    third: row.third ?? null,
    finishOrder: row.finishOrder ?? null,
    note: row.note ?? null,
  });
  fs.appendFileSync(RESULTS_FILE, `${line}\n`, 'utf8');
  return { ok: true, file: RESULTS_FILE };
}

function countLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 0;
    const s = fs.readFileSync(filePath, 'utf8');
    if (!s.trim()) return 0;
    return s.trim().split('\n').length;
  } catch {
    return 0;
  }
}

function getAccumulatorStatus() {
  ensureDir();
  return {
    snapshotsCount: countLines(SNAPSHOTS_FILE),
    resultsCount: countLines(RESULTS_FILE),
    snapshotsPath: SNAPSHOTS_FILE,
    resultsPath: RESULTS_FILE,
    dir: ACC_DIR,
  };
}

/**
 * 末尾 N 行をパース（簡易ビュー用）
 * @param {number} [maxLines=30]
 */
function readRecentSnapshots(maxLines = 30) {
  try {
    if (!fs.existsSync(SNAPSHOTS_FILE)) return [];
    const lines = fs.readFileSync(SNAPSHOTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const slice = lines.slice(-maxLines);
    return slice.map((ln) => {
      try {
        return JSON.parse(ln);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  appendSnapshot,
  appendResult,
  getAccumulatorStatus,
  readRecentSnapshots,
  ACC_DIR,
  SNAPSHOTS_FILE,
  RESULTS_FILE,
};
