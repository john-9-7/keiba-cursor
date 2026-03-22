#!/usr/bin/env node
/**
 * netkeiba 結果ページのパーステスト
 */
const { fetchNetkeiba, parseResultPage, fetchRaceListForDate, parseRaceListForDate } = require('../lib/netkeibaResult');

async function testResult() {
  console.log('=== fetch result page 202606020607 ===');
  const fr = await fetchNetkeiba('https://race.netkeiba.com/race/result.html?race_id=202606020607');
  console.log('fetch ok:', fr.ok, 'status:', fr.status);
  if (fr.html) {
    const p = parseResultPage(fr.html);
    console.log('parsed:', JSON.stringify(p, null, 2));
  }
}

async function testList() {
  console.log('\n=== fetch race list 2026-03-15 ===');
  const r = await fetchRaceListForDate('2026-03-15');
  console.log('fetch ok:', r.ok, r.error || '');
  if (r.map) {
    const entries = [...r.map.entries()].slice(0, 15);
    console.log('map sample:', entries);
  }
}

async function main() {
  await testResult();
  await testList();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
