#!/usr/bin/env node
/**
 * 回帰テスト（ネットワーク不要）
 * - race-list の allRaces 多重ブロックをマージできること
 * - 一覧HTMLから race_id / RPT / 発走時刻を補完できること
 * - ダッシュボード選定で当日の会場ごと1件を選べること
 * - 発走済み判定が正しく動くこと
 */
const assert = require('node:assert/strict');
const { parseRaceList, extractAllRacesMergedFromHtml } = require('../lib/parseRaceList');
const { pickDashboardRacesFromListHtml, isPostTimePassed } = require('../lib/dashboardPicks');

function testAllRacesMergeAndParseRaceList() {
  const html = `
<!doctype html><html><body>
<script>
window.allRaces = {
  "2026-03-24": {
    "中山": [
      {"id": 361945, "rpt": 6, "time": "12:30", "number": 7},
      {"id": 361946, "rpt": 5, "time": "13:05", "number": 8}
    ]
  }
};
</script>
<script>
window.allRaces = {
  "2026-03-25": {
    "阪神": [
      {"id": 500001, "rpt": 4, "time": "11:10", "number": 1}
    ]
  }
};
</script>
<div class="race-container" data-date="2026-03-24" data-venue="中山">
  <a class="race-item" onclick="race-form-361945"><span class="race-info">12:30</span></a>
  <a class="race-item" onclick="race-form-361946"><span class="race-info">13:05</span></a>
</div>
</body></html>`;

  const merged = extractAllRacesMergedFromHtml(html);
  assert.ok(merged, 'allRaces の抽出結果が null です');
  assert.ok(merged['2026-03-24'], '先頭ブロックの日付が消えています');
  assert.ok(merged['2026-03-25'], '後続ブロックの日付が消えています');

  const parsed = parseRaceList(html, '2026-03-24', '中山');
  assert.equal(parsed.ok, true, 'parseRaceList が失敗しました');
  assert.equal(parsed.races.length, 2, '中山のレース数が期待値と違います');
  assert.deepEqual(
    parsed.races.map((r) => [r.raceId, r.rpt, r.startTime]),
    [
      [361945, 6, '12:30'],
      [361946, 5, '13:05'],
    ],
    'race_id / RPT / 発走時刻の補完が崩れています',
  );
}

function testDashboardPickAndPostTime() {
  const html = `
<!doctype html><html><body>
<script>
window.allRaces = {
  "2026-03-24": {
    "中山": [
      {"id": 700001, "rpt": 5, "time": "11:40", "number": 4},
      {"id": 700002, "rpt": 8, "time": "12:10", "number": 5}
    ],
    "阪神": [
      {"id": 800001, "rpt": 3, "time": "12:00", "number": 6}
    ]
  }
};
</script>
</body></html>`;

  const now = new Date('2026-03-24T12:00:00+09:00');
  const out = pickDashboardRacesFromListHtml(html, now);

  assert.equal(out.dateNorm, '2026-03-24', '対象日が期待値と違います');
  assert.equal(out.picks.length, 2, '会場ごとの自動選択数が期待値と違います');

  const nakayama = out.picks.find((p) => p.venue === '中山');
  const hanshin = out.picks.find((p) => p.venue === '阪神');
  assert.ok(nakayama, '中山のpickがありません');
  assert.ok(hanshin, '阪神のpickがありません');
  assert.equal(nakayama.raceId, 700002, '中山の近傍時刻選定が崩れています');
  assert.equal(hanshin.raceId, 800001, '阪神のpickが崩れています');

  const before = Date.parse('2026-03-24T11:59:00+09:00');
  const after = Date.parse('2026-03-24T12:01:00+09:00');
  assert.equal(isPostTimePassed('2026-03-24', '12:00', before), false, '発走前が passed 扱いです');
  assert.equal(isPostTimePassed('2026-03-24', '12:00', after), true, '発走後が未発走扱いです');
}

function run() {
  const tests = [
    ['allRaces マージ + 一覧パース', testAllRacesMergeAndParseRaceList],
    ['ダッシュボード選定 + 発走判定', testDashboardPickAndPostTime],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
      passed += 1;
      console.log(`✅ ${name}`);
    } catch (e) {
      console.error(`❌ ${name}`);
      console.error(e.stack || e.message || String(e));
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n完了: ${passed}/${tests.length} テスト成功`);
}

run();
