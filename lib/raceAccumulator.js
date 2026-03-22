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

/** @type {Set<number>|null} プロセス内キャッシュ（重複チェック用）。ファイルを手編集した場合は不整合の可能性あり */
let snapshotRaceIdCache = null;

function ensureDir() {
  if (!fs.existsSync(ACC_DIR)) {
    fs.mkdirSync(ACC_DIR, { recursive: true });
  }
}

/**
 * snapshots.jsonl から race_id 集合を構築（キャッシュ）
 */
function loadSnapshotRaceIdsFromDisk() {
  const s = new Set();
  try {
    if (!fs.existsSync(SNAPSHOTS_FILE)) return s;
    const lines = fs.readFileSync(SNAPSHOTS_FILE, 'utf8').split('\n').filter(Boolean);
    for (const ln of lines) {
      try {
        const o = JSON.parse(ln);
        if (o.raceId != null && !Number.isNaN(Number(o.raceId))) {
          const rid = Number(o.raceId);
          if (rid >= 1) s.add(rid);
        }
      } catch {
        /* skip line */
      }
    }
  } catch {
    /* skip */
  }
  return s;
}

function getSnapshotRaceIdSet() {
  if (!snapshotRaceIdCache) {
    snapshotRaceIdCache = loadSnapshotRaceIdsFromDisk();
  }
  return snapshotRaceIdCache;
}

/** テスト・手動で jsonl を直した後に呼ぶ用（通常は不要） */
function invalidateSnapshotRaceIdCache() {
  snapshotRaceIdCache = null;
}

/**
 * @param {object} record
 * @returns {{ ok: true, file?: string, skipped?: boolean, duplicateRaceId?: number }}
 */
function appendSnapshot(record) {
  ensureDir();
  const rid = record.raceId != null ? Number(record.raceId) : NaN;
  if (!Number.isNaN(rid) && rid >= 1) {
    const set = getSnapshotRaceIdSet();
    if (set.has(rid)) {
      return { ok: true, skipped: true, duplicateRaceId: rid };
    }
  }

  const line = JSON.stringify({
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    ...record,
  });
  fs.appendFileSync(SNAPSHOTS_FILE, `${line}\n`, 'utf8');
  if (!Number.isNaN(rid) && rid >= 1) {
    getSnapshotRaceIdSet().add(rid);
  }
  return { ok: true, file: SNAPSHOTS_FILE, skipped: false };
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

/**
 * results.jsonl 全行を読み、raceId ごとに最新（recordedAt 最大）1件だけ残す
 * @returns {Map<number, object>}
 */
function readAllResultsLatestByRaceId() {
  const map = new Map();
  try {
    if (!fs.existsSync(RESULTS_FILE)) return map;
    const lines = fs.readFileSync(RESULTS_FILE, 'utf8').split('\n').filter(Boolean);
    for (const ln of lines) {
      try {
        const row = JSON.parse(ln);
        const id = row.raceId;
        if (id == null || Number.isNaN(Number(id))) continue;
        const rid = Number(id);
        const prev = map.get(rid);
        const t = row.recordedAt || '';
        if (!prev || String(t) >= String(prev.recordedAt || '')) {
          map.set(rid, row);
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return map;
}

/**
 * @param {Array<{ bb?: number|null, horseNumber?: number }>|undefined} horses
 * @returns {number|null}
 */
function topBbHorseNumber(horses) {
  if (!horses || !horses.length) return null;
  let best = null;
  let bestBb = -Infinity;
  for (const h of horses) {
    const bb = h.bb;
    if (bb == null || Number.isNaN(Number(bb))) continue;
    const n = Number(bb);
    if (n > bestBb) {
      bestBb = n;
      best = h.horseNumber != null ? Number(h.horseNumber) : null;
    }
  }
  return best != null && !Number.isNaN(best) ? best : null;
}

/**
 * 蓄積時点のBB指数で競技順位（同値は同順位、次は飛ぶ）を馬番ごとに返す
 * @param {Array<{ bb?: number|null, horseNumber?: number }>|undefined} horses
 * @returns {Map<number, number>}
 */
function computeBbRanksByHorseNumber(horses) {
  const map = new Map();
  if (!horses || !horses.length) return map;
  const sorted = horses.filter((h) => h.horseNumber != null && !Number.isNaN(Number(h.horseNumber)));
  sorted.sort((a, b) => {
    const ha = Number(a.horseNumber);
    const hb = Number(b.horseNumber);
    const ba = a.bb;
    const bb = b.bb;
    if (ba == null && bb == null) return ha - hb;
    if (ba == null) return 1;
    if (bb == null) return -1;
    const na = Number(ba);
    const nb = Number(bb);
    if (nb !== na) return nb - na;
    return ha - hb;
  });
  let rank = 1;
  for (let i = 0; i < sorted.length; i += 1) {
    if (i > 0) {
      const pb = sorted[i - 1].bb;
      const cb = sorted[i].bb;
      const same =
        (pb === cb) ||
        (pb == null && cb == null) ||
        (pb != null && cb != null && Number(pb) === Number(cb));
      if (!same) rank = i + 1;
    }
    map.set(Number(sorted[i].horseNumber), rank);
  }
  return map;
}

/**
 * @param {Map<number, number>} rankMap
 * @param {number|null|undefined} horseNum
 * @returns {number|null}
 */
function bbRankForHorse(rankMap, horseNum) {
  if (horseNum == null || Number.isNaN(Number(horseNum))) return null;
  const n = Number(horseNum);
  if (!rankMap.has(n)) return null;
  return rankMap.get(n);
}

/**
 * スナップショット末尾 N 件に、results を race_id で突合した行
 * @param {number} [maxSnapshots=100]
 */
function getMergedRecent(maxSnapshots = 100) {
  const snaps = readRecentSnapshots(maxSnapshots);
  const resultMap = readAllResultsLatestByRaceId();
  return snaps.map((s) => {
    const rid = s.raceId != null ? Number(s.raceId) : null;
    const res = rid != null ? resultMap.get(rid) : null;
    const rpt = s.rpt != null ? s.rpt : s.rptFromList;
    const verdict = s.judgment && s.judgment.verdict;
    const topBb = topBbHorseNumber(s.horses);
    const bbRanks = computeBbRanksByHorseNumber(s.horses);
    let bbTopIsFirst = null;
    if (res && res.first != null && topBb != null) {
      bbTopIsFirst = Number(res.first) === Number(topBb);
    }
    const firstBbRank = res && res.first != null ? bbRankForHorse(bbRanks, res.first) : null;
    const secondBbRank = res && res.second != null ? bbRankForHorse(bbRanks, res.second) : null;
    const thirdBbRank = res && res.third != null ? bbRankForHorse(bbRanks, res.third) : null;
    return {
      savedAt: s.savedAt,
      meetingDate: s.meetingDate,
      venue: s.venue,
      raceId: rid,
      raceIndex: s.raceIndex,
      rpt: rpt != null ? Number(rpt) : null,
      pattern: s.judgment && s.judgment.pattern,
      verdict,
      recommend: s.judgment && s.judgment.recommend,
      topBbHorse: topBb,
      firstBbRank,
      secondBbRank,
      thirdBbRank,
      result: res
        ? {
            recordedAt: res.recordedAt,
            first: res.first,
            second: res.second,
            third: res.third,
            finishOrder: res.finishOrder,
            note: res.note,
          }
        : null,
      bbTopIsFirst: res ? bbTopIsFirst : null,
    };
  });
}

/**
 * @param {ReturnType<typeof getMergedRecent>} merged
 */
function computeStatsFromMerged(merged) {
  let linkedResultCount = 0;
  let buyWithResult = 0;
  let bbTopFirstWhenBuy = 0;
  /** @type {Record<string, { snapshots: number, withResult: number, buy: number, skip: number, buyWithResult: number, bbTopFirstWhenBuy: number }>} */
  const byRpt = {};
  /** 1着馬のBB順位 → 件数（結果入力済み・順位が取れたレースのみ） */
  const firstPlaceBbRankHistogram = {};
  const secondPlaceBbRankHistogram = {};
  const thirdPlaceBbRankHistogram = {};

  function bump(hist, rank) {
    if (rank == null) return;
    const k = String(rank);
    hist[k] = (hist[k] || 0) + 1;
  }

  for (const row of merged) {
    const rptKey = row.rpt != null && !Number.isNaN(row.rpt) ? String(row.rpt) : '不明';
    if (!byRpt[rptKey]) {
      byRpt[rptKey] = {
        snapshots: 0,
        withResult: 0,
        buy: 0,
        skip: 0,
        buyWithResult: 0,
        bbTopFirstWhenBuy: 0,
      };
    }
    const b = byRpt[rptKey];
    b.snapshots++;
    if (row.verdict === '買い') b.buy++;
    else if (row.verdict === '見送り') b.skip++;

    if (row.result) {
      linkedResultCount++;
      b.withResult++;
      bump(firstPlaceBbRankHistogram, row.firstBbRank);
      bump(secondPlaceBbRankHistogram, row.secondBbRank);
      bump(thirdPlaceBbRankHistogram, row.thirdBbRank);
      if (row.verdict === '買い') {
        buyWithResult++;
        b.buyWithResult++;
        if (row.bbTopIsFirst === true) {
          bbTopFirstWhenBuy++;
          b.bbTopFirstWhenBuy++;
        }
      }
    }
  }

  return {
    snapshotRows: merged.length,
    linkedResultCount,
    buyWithResult,
    bbTopFirstWhenBuy,
    firstPlaceBbRankHistogram,
    secondPlaceBbRankHistogram,
    thirdPlaceBbRankHistogram,
    legend:
      '「BB最高が1着」= 蓄積時点でBB指数が最も高かった馬番が、実際の1着と一致（買い判定かつ結果入力済みのみ）。「BB順位」= そのレースの出馬表内でのBB競技順位（同点は同順位）。',
    byRpt,
  };
}

module.exports = {
  appendSnapshot,
  appendResult,
  getAccumulatorStatus,
  readRecentSnapshots,
  readAllResultsLatestByRaceId,
  getMergedRecent,
  computeStatsFromMerged,
  computeBbRanksByHorseNumber,
  invalidateSnapshotRaceIdCache,
  ACC_DIR,
  SNAPSHOTS_FILE,
  RESULTS_FILE,
};
