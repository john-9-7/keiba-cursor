/**
 * 競馬クラスター「レース分析」ページのHTMLをパースし、
 * RPT・馬番・BB指数・単勝オッズを抽出する。
 * - race-analyze-next: クラス名ベース（#race-horses-table, .horse-number-col 等）
 * - race-analyze?race_id=: 列インデックスベース（td[0]=馬番, td[8]=BB指数, td[12]=単勝オッズ）
 * @see docs/SCRAPING_SPEC.md
 */

const cheerio = require('cheerio');

/**
 * 列インデックス指定でテーブルをパース（race-analyze 用）
 * td[0]=馬番(1〜18), td[8]=BB指数, td[12]=単勝オッズ
 */
function parseTableByIndex($) {
  const horses = [];
  $('table tbody tr').each((_, row) => {
    const tds = $(row).find('td');
    if (tds.length < 13) return;
    const horseNumber = parseInt((tds.eq(0).text() || '').trim().replace(/\s/g, ''), 10);
    if (Number.isNaN(horseNumber) || horseNumber < 1 || horseNumber > 18) return;
    const bbText = (tds.eq(8).text() || '').trim().replace(/\s/g, '');
    const bb = parseFloat(bbText);
    const winOddsText = (tds.eq(12).text() || '').trim().replace(/\s/g, '');
    const winOdds = parseFloat(winOddsText);
    horses.push({ horseNumber, bb: Number.isNaN(bb) ? null : bb, winOdds: Number.isNaN(winOdds) ? null : winOdds });
  });
  return horses;
}

/**
 * @param {string} html - レース分析ページのHTML
 * @returns {{ ok: boolean, rpt?: number, horses?: Array<{ horseNumber: number, bb: number, winOdds: number }>, error?: string }}
 */
function parseRacePage(html) {
  if (!html || typeof html !== 'string') {
    return { ok: false, error: 'HTMLがありません。' };
  }

  const $ = cheerio.load(html);

  // RPT: .rpt-gauge-section .rpt-value.active のテキスト（1〜13）
  let rpt = null;
  const rptEl = $('.rpt-gauge-section .rpt-value.active');
  if (rptEl.length) {
    const rptText = rptEl.first().text().replace(/\s/g, '').trim();
    const n = parseInt(rptText, 10);
    if (n >= 1 && n <= 13) rpt = n;
  }

  // 出馬表: まず race-analyze-next 形式（#race-horses-table + クラス名）
  let horses = [];
  $('#race-horses-table tbody tr').each((_, row) => {
    const $row = $(row);
    const horseNumberEl = $row.find('td.horse-number-col');
    const bbEl = $row.find('td.bb-point-col .bb-number');
    const winOddsEl = $row.find('td.win-odds-col');

    const horseNumber = parseInt(horseNumberEl.attr('data-value') || horseNumberEl.text().trim(), 10);
    const bbText = (bbEl.text() || '').trim().replace(/\s/g, '');
    const bb = parseFloat(bbText);
    const winOddsText = winOddsEl.attr('data-value') || winOddsEl.text().trim().replace(/\s/g, '');
    const winOdds = parseFloat(winOddsText);

    if (Number.isNaN(horseNumber) || horseNumber < 1) return;
    horses.push({ horseNumber, bb: Number.isNaN(bb) ? null : bb, winOdds: Number.isNaN(winOdds) ? null : winOdds });
  });

  // データが取れない場合は race-analyze 形式（td[0]/[8]/[12]）で再試行
  if (horses.length === 0) {
    horses = parseTableByIndex($);
  }

  return { ok: true, rpt: rpt ?? undefined, horses };
}

module.exports = { parseRacePage, parseTableByIndex };
