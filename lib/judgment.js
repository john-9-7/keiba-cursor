/**
 * 判定ロジック（ユーザー指定の RPT パターン A〜D・推奨券種）
 * @typedef {{ horseNumber: number, bb: number | null, winOdds: number | null }} HorseRow
 */

function nbb(h) {
  if (h.bb == null || Number.isNaN(h.bb)) return null;
  return h.bb;
}

function nodds(h) {
  if (h.winOdds == null || Number.isNaN(h.winOdds)) return null;
  return h.winOdds;
}

/** BB 降順（有効BBのみ） */
function byBbDesc(horses) {
  return horses.filter((h) => nbb(h) != null).sort((a, b) => nbb(b) - nbb(a));
}

/** 動的断層：BB降順で隣接差が初めて >=3.0 の上側インデックス（faultAfter）。無ければ -1 */
function faultAfter(sortedDesc) {
  for (let i = 0; i < sortedDesc.length - 1; i += 1) {
    const d = nbb(sortedDesc[i]) - nbb(sortedDesc[i + 1]);
    if (d >= 3.0) return i;
  }
  return -1;
}

function fmt(nums) {
  return [...new Set(nums)].filter((x) => x >= 1).sort((a, b) => a - b).join('・');
}

/** 馬番が大きい順の上位3頭（外枠3頭） */
function outerThreeHorseNumbers(horses) {
  const nums = [...new Set(horses.map((h) => h.horseNumber).filter((n) => n >= 1))].sort((a, b) => b - a);
  return new Set(nums.slice(0, 3));
}

function isFavorite(h, field) {
  const o = nodds(h);
  if (o == null) return false;
  const oddsList = field.map(nodds).filter((x) => x != null && x > 0);
  if (oddsList.length === 0) return false;
  const minO = Math.min(...oddsList);
  return o === minO;
}

/** 推奨券種テキスト（仕様どおり固定文） */
function recommendTicketType(rpt) {
  const r = Math.floor(Number(rpt));
  if (r <= 3) {
    return '・ワイドBOX・馬連BOX（主力候補と爆弾候補） / ・3連複フォーメーション（1列目:主力、2列目:主力＋爆弾、3列目:全候補）';
  }
  if (r === 4 || r === 5) {
    return '・馬単BOXまたは1着流し（アタマ候補からヒモへ） / ・3連複・3連単フォーメーション（※単勝4.9倍以下で降格した馬は2・3着付け）';
  }
  if (r === 6) {
    return '・馬単1着固定流し（本命軸BB1位から連下・ヒモへ） / ・3連複・3連単フォーメーション（※単勝4.9倍以下で降格した馬は2・3着付け）';
  }
  if (r === 7) {
    return '・馬連・ワイド少数点流し（絶対軸からヒモへ） / ・3連単逆張りフォーメーション（絶対軸を1着固定しBB1位や他ヒモへ）';
  }
  if (r === 8 || r === 10) {
    return '・馬連・ワイド少数点流し（絶対軸からヒモへ） / ・3連単1着固定流し（絶対軸からヒモへ）';
  }
  if (r === 9) {
    return '・馬連・ワイド少数点流し（BB1位からヒモへ） / ・3連単1着固定流し（BB1位からヒモへ）';
  }
  if (r === 11) {
    return '・単勝1点買い（BB1位） / ・3連単フォーメーション（BB1位を1着固定、残り2頭を2・3着）';
  }
  if (r === 12 || r === 13) {
    return '・馬連・ワイド・3連複（断層上の上位馬のみの少数点BOX）';
  }
  return '';
}

/**
 * @param {number} rpt
 * @param {HorseRow[]} horses
 */
function judgeRace(rpt, horses) {
  const r = Math.floor(Number(rpt));
  if (!horses || horses.length === 0) {
    return { verdict: '見送り', pattern: '?', lines: ['見送り', '', '[根拠]', '出馬データがありません。'], recommend: '', meta: {} };
  }
  if (Number.isNaN(r) || r < 1 || r > 13) {
    return { verdict: '見送り', pattern: '?', lines: ['見送り', '', '[根拠]', `RPTが不正です（${rpt}）。`], recommend: '', meta: {} };
  }

  if (r <= 3) return judgeA(r, horses);
  if (r <= 6) return judgeB(r, horses);
  if (r <= 10) return judgeC(r, horses);
  return judgeD(r, horses);
}

function judgeA(rpt, horses) {
  const field = horses;
  if (field.some((h) => nbb(h) != null && nbb(h) >= 70.0)) {
    const nums = field.filter((h) => nbb(h) >= 70).map((h) => h.horseNumber);
    return {
      verdict: '見送り',
      pattern: 'A',
      lines: ['見送り', '', '[根拠]', `パターンA：BB70.0以上がいるため見送り（${fmt(nums)}）。`],
      recommend: recommendTicketType(rpt),
      meta: {},
    };
  }

  const pool = field.filter((h) => nbb(h) == null || nbb(h) > 44.9);
  const ranked = byBbDesc(pool);
  const bb1Horse = ranked[0] || null;
  const bb1Num = bb1Horse ? bb1Horse.horseNumber : null;

  let 主力 = pool.filter((h) => nbb(h) != null && nbb(h) >= 50.0 && nbb(h) <= 69.9);
  let 爆弾 = pool.filter((h) => nbb(h) != null && nbb(h) >= 45.0 && nbb(h) <= 49.9);

  if ((rpt === 1 || rpt === 2) && bb1Horse) {
    主力 = 主力.filter((h) => h.horseNumber !== bb1Num);
    if (!爆弾.some((h) => h.horseNumber === bb1Num)) {
      爆弾 = [...爆弾, bb1Horse];
    }
  }

  const 主力f = 主力.filter((h) => {
    const o = nodds(h);
    if (o == null) return false;
    if (o < 10.0) return false;
    const bb = nbb(h);
    if (bb >= 55.0) return o >= 10.0;
    if (bb >= 50.0 && bb <= 54.9) return o >= 15.0;
    return true;
  });

  const 爆弾f = 爆弾.filter((h) => {
    if (bb1Num != null && h.horseNumber === bb1Num) return true;
    const o = nodds(h);
    return o != null && o >= 30.0;
  });

  let 爆弾Trim = 爆弾f;
  if (爆弾Trim.length >= 4) {
    爆弾Trim = [...爆弾Trim].sort((a, b) => nbb(a) - nbb(b));
    while (爆弾Trim.length > 3) {
      const lowest = 爆弾Trim[0];
      if (bb1Num != null && lowest.horseNumber === bb1Num) {
        const idx = 爆弾Trim.findIndex((x) => x.horseNumber !== bb1Num);
        if (idx < 0) break;
        爆弾Trim.splice(idx, 1);
      } else {
        爆弾Trim.shift();
      }
    }
  }

  const mainNums = 主力f.map((h) => h.horseNumber);
  const bombNums = 爆弾Trim.map((h) => h.horseNumber);

  if (mainNums.length === 0 && bombNums.length === 0) {
    return {
      verdict: '見送り',
      pattern: 'A',
      lines: ['見送り', '', '[根拠]', 'パターンA：オッズ足切り・絞り込みの結果、候補が残りませんでした。'],
      recommend: recommendTicketType(rpt),
      meta: {},
    };
  }

  const lines = ['買い', '', '[買い目]', '', `・主力候補：${fmt(mainNums) || '—'}`, `・爆弾候補：${fmt(bombNums) || '—'}`, `推奨券種：${recommendTicketType(rpt)}`];
  return {
    verdict: '買い',
    pattern: 'A',
    lines,
    recommend: recommendTicketType(rpt),
    meta: { 主力候補: mainNums, 爆弾候補: bombNums },
  };
}

function judgeB(rpt, horses) {
  const field = horses;
  if (field.some((h) => nbb(h) != null && nbb(h) >= 70.0)) {
    const nums = field.filter((h) => nbb(h) >= 70).map((h) => h.horseNumber);
    return {
      verdict: '見送り',
      pattern: 'B',
      lines: ['見送り', '', '[根拠]', `パターンB：BB70.0以上がいるため見送り（${fmt(nums)}）。`],
      recommend: recommendTicketType(rpt),
      meta: {},
    };
  }

  const sorted = byBbDesc(field);
  const fa = faultAfter(sorted);
  const upperN = new Set();
  const lowerN = new Set();
  if (fa < 0) sorted.forEach((h) => upperN.add(h.horseNumber));
  else {
    sorted.slice(0, fa + 1).forEach((h) => upperN.add(h.horseNumber));
    sorted.slice(fa + 1).forEach((h) => lowerN.add(h.horseNumber));
  }

  let アタマ = field.filter((h) => upperN.has(h.horseNumber) && nbb(h) != null);
  let ヒモ = field.filter((h) => lowerN.has(h.horseNumber) && nbb(h) != null && nbb(h) >= 50.0);

  const bb1Upper = byBbDesc(アタマ)[0] || null;
  const outer3 = outerThreeHorseNumbers(field);

  const moved = [];
  アタマ = アタマ.filter((h) => {
    const o = nodds(h);
    if (o == null) return true;
    const th = outer3.has(h.horseNumber) ? 5.9 : 4.9;
    if (rpt === 6 && bb1Upper && h.horseNumber === bb1Upper.horseNumber) return true;
    if (o <= th) {
      moved.push(h);
      return false;
    }
    return true;
  });
  ヒモ = [...ヒモ, ...moved];

  const renLow = (h) => (outer3.has(h.horseNumber) ? 6.0 : 5.0);
  /** @type {HorseRow[]} */
  let 本命 = [];
  /** @type {HorseRow[]} */
  let 連下 = [];

  if (rpt === 4 || rpt === 5) {
    アタマ.forEach((h) => {
      const o = nodds(h);
      if (o == null) return;
      if (o >= 10.0) 本命.push(h);
      else if (o >= renLow(h) && o <= 9.9) 連下.push(h);
    });
  } else {
    const rest = アタマ.filter((h) => !bb1Upper || h.horseNumber !== bb1Upper.horseNumber);
    if (bb1Upper) 本命.push(bb1Upper);
    rest.forEach((h) => {
      const o = nodds(h);
      if (o == null) return;
      if (o >= 10.0) 本命.push(h);
      else if (o >= renLow(h) && o <= 9.9) 連下.push(h);
    });
  }

  const honNums = [...new Set(本命.map((h) => h.horseNumber))];
  const renNums = [...new Set(連下.map((h) => h.horseNumber))];
  const himoNums = [...new Set(ヒモ.map((h) => h.horseNumber))];

  if (honNums.length === 0 && renNums.length === 0 && himoNums.length === 0) {
    return {
      verdict: '見送り',
      pattern: 'B',
      lines: ['見送り', '', '[根拠]', 'パターンB：条件後に候補が残りませんでした。'],
      recommend: recommendTicketType(rpt),
      meta: {},
    };
  }

  const labelHon = rpt === 6 ? '・本命軸（断層上BB1位）' : '・本命';
  const lines = [
    '買い',
    '',
    '[買い目]',
    '',
    `${labelHon}：${fmt(honNums) || '—'}`,
    `・連下：${fmt(renNums) || '—'}`,
    `・ヒモ：${fmt(himoNums) || '—'}`,
    `推奨券種：${recommendTicketType(rpt)}`,
  ];

  return {
    verdict: '買い',
    pattern: 'B',
    lines,
    recommend: recommendTicketType(rpt),
    meta: { 本命: honNums, 連下: renNums, ヒモ: himoNums },
  };
}

function judgeC(rpt, horses) {
  const field = horses;
  const high60 = field.filter((h) => nbb(h) != null && nbb(h) >= 60.0);
  if (high60.length === 0) {
    return {
      verdict: '見送り',
      pattern: 'C',
      lines: ['見送り', '', '[根拠]', 'パターンC：BB60.0以上が0頭のため見送り。'],
      recommend: recommendTicketType(rpt),
      meta: {},
    };
  }

  const pool = field.filter((h) => nbb(h) == null || nbb(h) > 49.9);
  const ranked = byBbDesc(pool);
  const bb1 = ranked[0];
  const bb2 = ranked[1];
  const bb3 = ranked[2];

  if (rpt === 10 && bb1) {
    if (!isFavorite(bb1, field)) {
      return {
        verdict: '見送り',
        pattern: 'C',
        lines: ['見送り', '', '[根拠]', 'パターンC・RPT10：BB1位が単勝1番人気でないため見送り。'],
        recommend: recommendTicketType(rpt),
        meta: {},
      };
    }
  }

  let 絶対軸 = null;
  if (rpt === 7) {
    let axis = bb2 || null;
    if (axis && nodds(axis) != null && nodds(axis) < 4.0) axis = bb3 || axis;
    絶対軸 = axis;
  } else if (rpt === 9) {
    絶対軸 = bb1 || null;
  } else if (rpt === 8 || rpt === 10) {
    const sixties = pool.filter((h) => nbb(h) != null && nbb(h) >= 60.0);
    const okOdds = sixties.filter((h) => nodds(h) != null && nodds(h) >= 3.0);
    if (okOdds.length > 0) {
      okOdds.sort((a, b) => (nodds(b) || 0) - (nodds(a) || 0));
      絶対軸 = okOdds[0];
    } else {
      絶対軸 = [...sixties].sort((a, b) => nbb(b) - nbb(a))[0] || null;
    }
  }

  if (!絶対軸) {
    return {
      verdict: '見送り',
      pattern: 'C',
      lines: ['見送り', '', '[根拠]', 'パターンC：絶対軸を決められませんでした。'],
      recommend: recommendTicketType(rpt),
      meta: {},
    };
  }

  let ヒモ;
  if (rpt === 7) {
    ヒモ = pool.filter((h) => h.horseNumber !== 絶対軸.horseNumber);
  } else {
    ヒモ = pool.filter((h) => h.horseNumber !== 絶対軸.horseNumber && nbb(h) != null && nbb(h) >= 50.0 && nbb(h) <= 59.9);
  }

  ヒモ = ヒモ.filter((h) => {
    const o = nodds(h);
    if (o == null) return false;
    if (o <= 9.9) return false;
    if (nbb(h) >= 55.0 && o < 10.0) return false;
    return o >= 15.0 && o <= 30.0;
  });

  const axisNum = 絶対軸.horseNumber;
  const himoNums = [...new Set(ヒモ.map((h) => h.horseNumber))];

  if (himoNums.length === 0 && rpt !== 9) {
    return {
      verdict: '見送り',
      pattern: 'C',
      lines: ['見送り', '', '[根拠]', 'パターンC：ヒモ候補（条件・15〜30倍帯）が残りませんでした。'],
      recommend: recommendTicketType(rpt),
      meta: {},
    };
  }

  const lines = ['買い', '', '[買い目]', '', `・絶対軸：${axisNum}番`, `・ヒモ候補：${fmt(himoNums) || '—'}`, `推奨券種：${recommendTicketType(rpt)}`];
  return {
    verdict: '買い',
    pattern: 'C',
    lines,
    recommend: recommendTicketType(rpt),
    meta: { 絶対軸: axisNum, ヒモ: himoNums },
  };
}

function judgeD(rpt, horses) {
  const field = horses;
  const sorted = byBbDesc(field);
  const fa = faultAfter(sorted);
  const upperN = new Set();
  if (fa < 0) sorted.forEach((h) => upperN.add(h.horseNumber));
  else sorted.slice(0, fa + 1).forEach((h) => upperN.add(h.horseNumber));

  const above = field.filter((h) => upperN.has(h.horseNumber) && nbb(h) != null);

  if (rpt === 11) {
    const bb1 = byBbDesc(above)[0];
    if (!bb1) {
      return { verdict: '見送り', pattern: 'D', lines: ['見送り', '', '[根拠]', 'パターンD・RPT11：断層上にBB1位がありません。'], recommend: recommendTicketType(rpt), meta: {} };
    }
    const bb = nbb(bb1);
    const o = nodds(bb1);
    if (o == null) {
      return { verdict: '見送り', pattern: 'D', lines: ['見送り', '', '[根拠]', 'パターンD・RPT11：BB1位のオッズがありません。'], recommend: recommendTicketType(rpt), meta: {} };
    }
    if (bb >= 70.0 && o < 2.0) {
      return { verdict: '見送り', pattern: 'D', lines: ['見送り', '', '[根拠]', `パターンD・RPT11：BB1位（${bb1.horseNumber}番）が単勝2.0倍未満。`], recommend: recommendTicketType(rpt), meta: {} };
    }
    if (bb >= 65.0 && bb < 70.0 && o < 3.0) {
      return { verdict: '見送り', pattern: 'D', lines: ['見送り', '', '[根拠]', `パターンD・RPT11：BB1位が単勝3.0倍未満。`], recommend: recommendTicketType(rpt), meta: {} };
    }
    if (bb >= 60.0 && bb < 65.0 && o < 4.0) {
      return { verdict: '見送り', pattern: 'D', lines: ['見送り', '', '[根拠]', `パターンD・RPT11：BB1位が単勝4.0倍未満。`], recommend: recommendTicketType(rpt), meta: {} };
    }
    if (bb < 60.0) {
      return { verdict: '見送り', pattern: 'D', lines: ['見送り', '', '[根拠]', 'パターンD・RPT11：断層上のBB1位がBB60.0未満。'], recommend: recommendTicketType(rpt), meta: {} };
    }

    const lines = ['買い', '', '[買い目]', '', `・1着固定軸（BB1位）：${bb1.horseNumber}番`, `推奨券種：${recommendTicketType(rpt)}`];
    return { verdict: '買い', pattern: 'D', lines, recommend: recommendTicketType(rpt), meta: { BB1: bb1.horseNumber } };
  }

  const top3 = byBbDesc(above).slice(0, 3);
  if (top3.length === 0) {
    return { verdict: '見送り', pattern: 'D', lines: ['見送り', '', '[根拠]', 'パターンD・RPT12・13：断層上の馬が不足。'], recommend: recommendTicketType(rpt), meta: {} };
  }
  const oddsList = top3.map(nodds).filter((x) => x != null);
  if (oddsList.length === top3.length && oddsList.every((o) => o <= 3.5)) {
    return {
      verdict: '見送り',
      pattern: 'D',
      lines: ['見送り', '', '[根拠]', 'パターンD・RPT12・13：上位3頭の単勝がすべて3.5倍以下のため見送り。'],
      recommend: recommendTicketType(rpt),
      meta: {},
    };
  }

  const nums = top3.map((h) => h.horseNumber);
  const lines = ['買い', '', '[買い目]', '', `・断層上上位（BB1〜3位相当）：${fmt(nums)}`, `推奨券種：${recommendTicketType(rpt)}`];
  return { verdict: '買い', pattern: 'D', lines, recommend: recommendTicketType(rpt), meta: { 上位: nums } };
}

module.exports = { judgeRace, recommendTicketType, byBbDesc, faultAfter, outerThreeHorseNumbers };
