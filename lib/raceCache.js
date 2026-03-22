/**
 * RPT・BB指数のキャッシュ（オッズは変動するため保持しない）
 * - race_id 単位で保存、当日（JST）中のみ有効
 * - 翌日 0 時（JST）で自動失効
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'race-cache.json');

/** @type {Map<number, { rpt: number|null, horses: Array<{ horseNumber: number, bb: number|null }>, date: string }>} */
let cache = new Map();

/** JST の今日 YYYY-MM-DD */
function jstYmd(now = new Date()) {
  return new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

function ensureDir() {
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadFromFile() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return;
    const today = jstYmd();
    for (const [k, v] of Object.entries(data)) {
      const rid = parseInt(k, 10);
      if (Number.isNaN(rid) || rid < 1 || !v || v.date !== today) continue;
      cache.set(rid, {
        rpt: v.rpt,
        horses: Array.isArray(v.horses) ? v.horses : [],
        date: v.date,
      });
    }
  } catch {
    /* ignore */
  }
}

function saveToFile() {
  try {
    ensureDir();
    const today = jstYmd();
    const obj = {};
    for (const [k, v] of cache) {
      if (v && v.date === today) obj[String(k)] = v;
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 0), 'utf8');
  } catch {
    /* ignore */
  }
}

function pruneStale() {
  const today = jstYmd();
  for (const [k, v] of cache) {
    if (!v || v.date !== today) cache.delete(k);
  }
}

/**
 * キャッシュに保存（取得成功時のみ呼ぶ）
 * @param {number} raceId
 * @param {number|null} rpt
 * @param {Array<{ horseNumber: number, bb?: number|null }>} horses
 */
function set(raceId, rpt, horses) {
  if (!raceId || Number.isNaN(Number(raceId))) return;
  const rid = Number(raceId);
  const list = (horses || []).map((h) => ({
    horseNumber: Number(h.horseNumber),
    bb: h.bb != null && !Number.isNaN(Number(h.bb)) ? Number(h.bb) : null,
  }));
  cache.set(rid, { rpt: rpt != null ? Number(rpt) : null, horses: list, date: jstYmd() });
  saveToFile();
}

/**
 * キャッシュから取得（当日分のみ）
 * @param {number} raceId
 * @returns {{ rpt: number|null, horses: Array<{ horseNumber: number, bb: number|null }> } | null}
 */
function get(raceId) {
  const rid = Number(raceId);
  if (Number.isNaN(rid) || rid < 1) return null;
  pruneStale();
  const entry = cache.get(rid);
  if (!entry || entry.date !== jstYmd()) return null;
  return { rpt: entry.rpt, horses: entry.horses || [] };
}

loadFromFile();

module.exports = { set, get, jstYmd, CACHE_FILE };
