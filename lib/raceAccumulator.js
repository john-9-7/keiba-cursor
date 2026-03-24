/**
 * 分析用レーススナップショットの蓄積（JSONL・追記のみ）
 * - data/accumulated/snapshots.jsonl … 取得時点の RPT・馬柱・判定 など
 * - data/accumulated/results.jsonl   … 後から突合する着順（任意）
 */

const fs = require('fs');
const path = require('path');
const { resolveDataRoot, isRenderEphemeralRisk } = require('./dataRoot');

const DATA_ROOT = resolveDataRoot();
const ACC_DIR = path.join(DATA_ROOT, 'accumulated');
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
 * @param {{ raceId: number, first?: number, second?: number, third?: number, finishOrder?: number[], note?: string, payouts?: Record<string, Array<{ key: string, payout: number }>> }} row
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
    payouts: row.payouts ?? null,
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
    dataRoot: DATA_ROOT,
    /** 環境変数でデータルートを明示しているか */
    usesKeibaDataDir: !!process.env.KEIBA_DATA_DIR,
    /** Render 等でコンテナ内 data に置いている＝再起動で消えやすい */
    ephemeralDataRisk: isRenderEphemeralRisk(DATA_ROOT),
  };
}

/**
 * 日付文字列を YYYYMMDD に正規化
 * @param {string} d "2026-03-15" | "20260315"
 */
function normalizeDateForCompare(d) {
  if (!d || typeof d !== 'string') return '';
  return d.trim().replace(/-/g, '').slice(0, 8);
}

/**
 * 指定日のスナップショットを取得（meetingDate でフィルタ）
 * @param {string} date YYYY-MM-DD または YYYYMMDD
 * @param {number} [maxLines=2000]
 */
function getSnapshotsByDate(date, maxLines = 2000) {
  const targetNorm = normalizeDateForCompare(date);
  if (!targetNorm) return [];
  try {
    if (!fs.existsSync(SNAPSHOTS_FILE)) return [];
    const lines = fs.readFileSync(SNAPSHOTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const slice = lines.slice(-maxLines);
    return slice
      .map((ln) => {
        try {
          return JSON.parse(ln);
        } catch {
          return null;
        }
      })
      .filter((s) => s && normalizeDateForCompare(s.meetingDate) === targetNorm);
  } catch {
    return [];
  }
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
 * 判定metaから買い目候補馬番を抽出
 * @param {Record<string, any>|null|undefined} meta
 * @returns {number[]}
 */
function extractSuggestedHorseNumbers(meta) {
  if (!meta || typeof meta !== 'object') return [];
  const set = new Set();
  for (const v of Object.values(meta)) {
    if (Array.isArray(v)) {
      for (const n of v) {
        const x = Number(n);
        if (!Number.isNaN(x) && x >= 1) set.add(x);
      }
    } else {
      const x = Number(v);
      if (!Number.isNaN(x) && x >= 1) set.add(x);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 判定metaを人が読みやすい買い目表現にする
 * @param {string|null|undefined} pattern
 * @param {Record<string, any>|null|undefined} meta
 * @returns {string}
 */
function summarizeBetFromMeta(pattern, meta) {
  if (!meta || typeof meta !== 'object') return '—';
  const entries = [];
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) {
      const arr = v.map((n) => Number(n)).filter((n) => !Number.isNaN(n) && n >= 1).sort((a, b) => a - b);
      if (arr.length > 0) entries.push(`${k}:${arr.join('・')}`);
    } else {
      const n = Number(v);
      if (!Number.isNaN(n) && n >= 1) entries.push(`${k}:${n}`);
    }
  }
  if (entries.length > 0) return entries.join(' / ');
  const nums = extractSuggestedHorseNumbers(meta);
  if (nums.length === 0) return '—';
  return `${pattern || '?'}候補:${nums.join('・')}`;
}

function pairKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y) || x < 1 || y < 1 || x === y) return null;
  return x < y ? `${x}-${y}` : `${y}-${x}`;
}

function orderedPairKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (Number.isNaN(x) || Number.isNaN(y) || x < 1 || y < 1 || x === y) return null;
  return `${x}>${y}`;
}

function tripleKey(a, b, c) {
  const arr = [Number(a), Number(b), Number(c)];
  if (arr.some((n) => Number.isNaN(n) || n < 1)) return null;
  if (new Set(arr).size !== 3) return null;
  arr.sort((p, q) => p - q);
  return `${arr[0]}-${arr[1]}-${arr[2]}`;
}

function orderedTripleKey(a, b, c) {
  const arr = [Number(a), Number(b), Number(c)];
  if (arr.some((n) => Number.isNaN(n) || n < 1)) return null;
  if (new Set(arr).size !== 3) return null;
  return `${arr[0]}>${arr[1]}>${arr[2]}`;
}

/**
 * @param {number[]} nums
 * @returns {number[]}
 */
function uniqSorted(nums) {
  return [...new Set((nums || []).map((n) => Number(n)).filter((n) => !Number.isNaN(n) && n >= 1))].sort((a, b) => a - b);
}

/**
 * 買い目を compact 表記で作る（表示用）+ 実組み合わせ集合（判定用）
 * @param {number|null} rpt
 * @param {string|null} pattern
 * @param {Record<string, any>|null} meta
 */
function buildBetPlan(rpt, pattern, meta) {
  const plan = {
    display: {
      umaren: '',
      wide: '',
      umatan: '',
      sanrenpuku: '',
      sanrentan: '',
    },
    sets: {
      umaren: new Set(),
      wide: new Set(),
      umatan: new Set(),
      sanrenpuku: new Set(),
      sanrentan: new Set(),
    },
  };
  if (!meta || typeof meta !== 'object') return plan;

  const r = Number(rpt);
  const p = String(pattern || '');
  const main = uniqSorted(meta.主力候補 || []);
  const bomb = uniqSorted(meta.爆弾候補 || []);
  const hon = uniqSorted(meta.本命 || []);
  const ren = uniqSorted(meta.連下 || []);
  const himo = uniqSorted(meta.ヒモ || []);
  const axis = meta.絶対軸 != null ? Number(meta.絶対軸) : null;
  const up = uniqSorted(meta.上位 || []);
  const bb1 = meta.BB1 != null ? Number(meta.BB1) : null;

  function addPairBox(nums, toUmatan) {
    const arr = uniqSorted(nums);
    if (arr.length < 2) return;
    for (let i = 0; i < arr.length; i += 1) {
      for (let j = i + 1; j < arr.length; j += 1) {
        const k = pairKey(arr[i], arr[j]);
        if (k) {
          plan.sets.umaren.add(k);
          plan.sets.wide.add(k);
        }
        if (toUmatan) {
          const k1 = orderedPairKey(arr[i], arr[j]);
          const k2 = orderedPairKey(arr[j], arr[i]);
          if (k1) plan.sets.umatan.add(k1);
          if (k2) plan.sets.umatan.add(k2);
        }
      }
    }
  }

  function addAnchorFlow(anchor, targets, withUmaren, withWide, withUmatan) {
    const a = Number(anchor);
    const t = uniqSorted(targets).filter((n) => n !== a);
    if (Number.isNaN(a) || a < 1 || t.length === 0) return;
    for (const x of t) {
      const k = pairKey(a, x);
      if (k && withUmaren) plan.sets.umaren.add(k);
      if (k && withWide) plan.sets.wide.add(k);
      if (withUmatan) {
        const o = orderedPairKey(a, x);
        if (o) plan.sets.umatan.add(o);
      }
    }
  }

  function addSanrenpukuAnchor(anchor, targetsA, targetsB) {
    const a = Number(anchor);
    const x1 = uniqSorted(targetsA).filter((n) => n !== a);
    const x2 = uniqSorted(targetsB).filter((n) => n !== a);
    for (const b of x1) {
      for (const c of x2) {
        const k = tripleKey(a, b, c);
        if (k) plan.sets.sanrenpuku.add(k);
      }
    }
  }

  function addSanrentanAnchor(anchor, secondTargets, thirdTargets) {
    const a = Number(anchor);
    const s = uniqSorted(secondTargets).filter((n) => n !== a);
    const t = uniqSorted(thirdTargets).filter((n) => n !== a);
    for (const b of s) {
      for (const c of t) {
        const k = orderedTripleKey(a, b, c);
        if (k) plan.sets.sanrentan.add(k);
      }
    }
  }

  if (p === 'A') {
    const all = uniqSorted([...main, ...bomb]);
    addPairBox(all, false);
    // 3連複フォーメーション: 1列目=主力, 2列目=主力+爆弾, 3列目=全候補
    const c2 = uniqSorted([...main, ...bomb]);
    const c3 = all;
    for (const a of main) {
      for (const b of c2) {
        for (const c of c3) {
          const k = tripleKey(a, b, c);
          if (k) plan.sets.sanrenpuku.add(k);
        }
      }
    }
    if (main.length && bomb.length) {
      plan.display.umaren = `${main.join('・')}-${bomb.join('.')}`;
      plan.display.wide = `${main.join('・')}-${bomb.join('.')}`;
      plan.display.sanrenpuku = `${main.join('・')}-${c2.join('.')}-${c3.join('.')}`;
    } else {
      const allDot = all.join('.');
      plan.display.umaren = allDot ? `${allDot} BOX` : '';
      plan.display.wide = allDot ? `${allDot} BOX` : '';
      plan.display.sanrenpuku = allDot ? `${allDot} BOX` : '';
    }
  } else if (p === 'B') {
    const head = uniqSorted([...hon, ...ren]);
    const hm = uniqSorted(himo);
    if (head.length > 0 && hm.length > 0) {
      for (const a of head) addAnchorFlow(a, hm, true, false, true);
      for (const a of head) {
        addSanrenpukuAnchor(a, hm, hm);
        addSanrentanAnchor(a, hm, hm);
      }
      plan.display.umaren = `${head.join('・')}-${hm.join('.')}`;
      plan.display.umatan = `${head.join('・')}-${hm.join('.')}`;
      plan.display.sanrenpuku = `${head.join('・')}-${hm.join('.')}-${hm.join('.')}`;
      plan.display.sanrentan = `${head.join('・')}-${hm.join('.')}-${hm.join('.')}`;
    }
  } else if (p === 'C') {
    if (axis != null && !Number.isNaN(axis) && axis >= 1) {
      addAnchorFlow(axis, himo, true, true, false);
      addSanrentanAnchor(axis, himo, himo);
      if (himo.length > 0) {
        plan.display.umaren = `${axis}-${himo.join('.')}`;
        plan.display.wide = `${axis}-${himo.join('.')}`;
        plan.display.sanrentan = `${axis}-${himo.join('.')}-${himo.join('.')}`;
      }
    }
  } else if (p === 'D') {
    if (r === 11 && bb1 != null && !Number.isNaN(bb1) && bb1 >= 1) {
      // RPT11は1着固定軸
      const others = uniqSorted((meta.候補 || []).concat(up).concat(himo).concat(hon).concat(ren).filter((n) => Number(n) !== bb1));
      if (others.length > 0) {
        addSanrentanAnchor(bb1, others, others);
        plan.display.sanrentan = `${bb1}-${others.join('.')}-${others.join('.')}`;
      }
    } else {
      addPairBox(up, false);
      if (up.length >= 3) {
        for (let i = 0; i < up.length; i += 1) {
          for (let j = i + 1; j < up.length; j += 1) {
            for (let k = j + 1; k < up.length; k += 1) {
              const key = tripleKey(up[i], up[j], up[k]);
              if (key) plan.sets.sanrenpuku.add(key);
            }
          }
        }
      }
      const dot = up.join('.');
      plan.display.umaren = dot ? `${dot} BOX` : '';
      plan.display.wide = dot ? `${dot} BOX` : '';
      plan.display.sanrenpuku = dot ? `${dot} BOX` : '';
    }
  }

  return plan;
}

/**
 * @param {{ first?: number|null, second?: number|null, third?: number|null }|null} result
 * @param {ReturnType<typeof buildBetPlan>} plan
 */
function evaluateHits(result, plan) {
  const out = {
    umaren: null,
    wide: null,
    umatan: null,
    sanrenpuku: null,
    sanrentan: null,
    anyHit: null,
  };
  if (!result || result.first == null || result.second == null) return out;
  const a = Number(result.first);
  const b = Number(result.second);
  const c = result.third != null ? Number(result.third) : null;
  const p = pairKey(a, b);
  const op = orderedPairKey(a, b);
  if (plan.sets.umaren.size > 0) out.umaren = !!p && plan.sets.umaren.has(p);
  if (plan.sets.wide.size > 0) out.wide = !!p && plan.sets.wide.has(p);
  if (plan.sets.umatan.size > 0) out.umatan = !!op && plan.sets.umatan.has(op);
  if (c != null && !Number.isNaN(c)) {
    const t = tripleKey(a, b, c);
    const ot = orderedTripleKey(a, b, c);
    if (plan.sets.sanrenpuku.size > 0) out.sanrenpuku = !!t && plan.sets.sanrenpuku.has(t);
    if (plan.sets.sanrentan.size > 0) out.sanrentan = !!ot && plan.sets.sanrentan.has(ot);
  }
  const vals = [out.umaren, out.wide, out.umatan, out.sanrenpuku, out.sanrentan].filter((v) => v !== null);
  out.anyHit = vals.length > 0 ? vals.some((v) => v === true) : null;
  return out;
}

/**
 * @param {{ payouts?: Record<string, Array<{ key: string, payout: number }>> }|null} result
 * @param {ReturnType<typeof buildBetPlan>} plan
 */
function evaluateReturns(result, plan) {
  const byType = {
    umaren: { stake: 0, payout: 0 },
    wide: { stake: 0, payout: 0 },
    umatan: { stake: 0, payout: 0 },
    sanrenpuku: { stake: 0, payout: 0 },
    sanrentan: { stake: 0, payout: 0 },
  };
  const hasPayouts = !!(result && result.payouts && typeof result.payouts === 'object');
  for (const type of Object.keys(byType)) {
    const set = plan.sets[type];
    if (!set || set.size === 0) continue;
    byType[type].stake = set.size * 100;
    if (!hasPayouts) continue;
    const list = Array.isArray(result.payouts[type]) ? result.payouts[type] : [];
    let sum = 0;
    for (const row of list) {
      const key = row && row.key ? String(row.key) : '';
      const payout = row ? Number(row.payout) : NaN;
      if (!key || Number.isNaN(payout) || payout < 0) continue;
      if (set.has(key)) sum += payout;
    }
    byType[type].payout = sum;
  }
  const totals = Object.values(byType).reduce(
    (acc, x) => {
      acc.stake += x.stake;
      acc.payout += x.payout;
      return acc;
    },
    { stake: 0, payout: 0 },
  );
  return {
    byType,
    totalStake: totals.stake,
    totalPayout: totals.payout,
    roiPercent: totals.stake > 0 ? Math.round((totals.payout / totals.stake) * 1000) / 10 : 0,
    hasPayouts,
  };
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
    const meta = s.judgment && s.judgment.meta ? s.judgment.meta : null;
    const suggestedHorseNumbers = extractSuggestedHorseNumbers(meta);
    const betPlan = buildBetPlan(rpt != null ? Number(rpt) : null, s.judgment && s.judgment.pattern, meta);
    const hitByType = evaluateHits(res, betPlan);
    const returnByType = evaluateReturns(res, betPlan);
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
      suggestedHorseNumbers,
      suggestedSummary: summarizeBetFromMeta(s.judgment && s.judgment.pattern, meta),
      actualBets: betPlan.display,
      hitByType,
      returnByType,
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
            payouts: res.payouts,
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
  /** @type {Record<string, { snapshots: number, withResult: number, buy: number, skip: number, buyWithResult: number, bbTopFirstWhenBuy: number, buyHitFirst: number, hitRatePercent: number, roiSamples: number, totalStake: number, totalPayout: number, roiPercent: number, byType: Record<string, { stake: number, payout: number }> }>} */
  const byRpt = {};
  let roiSamples = 0;
  let totalStake = 0;
  let totalPayout = 0;
  const totalByType = {
    umaren: { stake: 0, payout: 0 },
    wide: { stake: 0, payout: 0 },
    umatan: { stake: 0, payout: 0 },
    sanrenpuku: { stake: 0, payout: 0 },
    sanrentan: { stake: 0, payout: 0 },
  };
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
        buyHitFirst: 0,
        hitRatePercent: 0,
        roiSamples: 0,
        totalStake: 0,
        totalPayout: 0,
        roiPercent: 0,
        byType: {
          umaren: { stake: 0, payout: 0 },
          wide: { stake: 0, payout: 0 },
          umatan: { stake: 0, payout: 0 },
          sanrenpuku: { stake: 0, payout: 0 },
          sanrentan: { stake: 0, payout: 0 },
        },
      };
    }
    const b = byRpt[rptKey];
    b.snapshots++;
    if (row.verdict === '買い') b.buy++;
    else if (row.verdict === '見送り') b.skip++;

    if (row.result) {
      linkedResultCount++;
      b.withResult++;
      if (row.verdict === '買い') {
        buyWithResult++;
        b.buyWithResult++;
        if (row.hitByType && row.hitByType.anyHit === true) b.buyHitFirst++;
        if (row.bbTopIsFirst === true) {
          bbTopFirstWhenBuy++;
          b.bbTopFirstWhenBuy++;
        }
        if (row.returnByType && row.returnByType.hasPayouts) {
          roiSamples++;
          b.roiSamples++;
          totalStake += row.returnByType.totalStake;
          totalPayout += row.returnByType.totalPayout;
          b.totalStake += row.returnByType.totalStake;
          b.totalPayout += row.returnByType.totalPayout;
          for (const type of Object.keys(totalByType)) {
            const v = row.returnByType.byType[type];
            if (!v) continue;
            totalByType[type].stake += v.stake;
            totalByType[type].payout += v.payout;
            b.byType[type].stake += v.stake;
            b.byType[type].payout += v.payout;
          }
        }
      }
    }
  }

  for (const key of Object.keys(byRpt)) {
    const b = byRpt[key];
    b.hitRatePercent = b.buyWithResult > 0 ? Math.round((b.buyHitFirst / b.buyWithResult) * 1000) / 10 : 0;
    b.roiPercent = b.totalStake > 0 ? Math.round((b.totalPayout / b.totalStake) * 1000) / 10 : 0;
  }

  return {
    snapshotRows: merged.length,
    linkedResultCount,
    buyWithResult,
    bbTopFirstWhenBuy,
    roiSamples,
    totalStake,
    totalPayout,
    roiPercent: totalStake > 0 ? Math.round((totalPayout / totalStake) * 1000) / 10 : 0,
    totalByType,
    legend:
      '「条件的中」= 買い判定レースで、実際に生成した買い目（馬連/ワイド/馬単/3連複/3連単）のいずれかが的中した件数。「回収率」= 各買い目100円固定での 払戻/投資。',
    byRpt,
  };
}

module.exports = {
  appendSnapshot,
  appendResult,
  getAccumulatorStatus,
  readRecentSnapshots,
  getSnapshotsByDate,
  readAllResultsLatestByRaceId,
  getMergedRecent,
  computeStatsFromMerged,
  computeBbRanksByHorseNumber,
  invalidateSnapshotRaceIdCache,
  normalizeDateForCompare,
  ACC_DIR,
  SNAPSHOTS_FILE,
  RESULTS_FILE,
};
