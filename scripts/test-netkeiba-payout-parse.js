#!/usr/bin/env node
/**
 * netkeiba 払戻パースの回帰（fixtures + 任意の保存HTML）
 */
const fs = require('fs');
const path = require('path');
const { parsePayouts, parseResultPage } = require('../lib/netkeibaResult');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function main() {
  const fixture = path.join(__dirname, '..', 'tests', 'fixtures', 'netkeiba-payout-detail-snippet.html');
  const html = fs.readFileSync(fixture, 'utf8');
  const p = parsePayouts(html);

  assert(p.tansho.length === 1 && p.tansho[0].key === '10' && p.tansho[0].payout === 660, 'tansho');
  assert(p.fukusho.length === 3, 'fukusho len');
  assert(p.fukusho[0].key === '10' && p.fukusho[0].payout === 170, 'fukusho0');
  assert(p.wakuren[0].key === '6-7' && p.wakuren[0].payout === 270, 'wakuren');
  assert(p.umaren[0].key === '10-11' && p.umaren[0].payout === 1570, 'umaren');
  assert(p.wide.length === 3, 'wide len');
  assert(p.wide[0].key === '10-11' && p.wide[0].payout === 600, 'wide0');
  assert(p.umatan[0].key === '10>11' && p.umatan[0].payout === 3510, 'umatan');
  assert(p.sanrenpuku[0].key === '10-11-12' && p.sanrenpuku[0].payout === 1320, 'sanrenpuku');
  assert(p.sanrentan[0].key === '10>11>12' && p.sanrentan[0].payout === 10190, 'sanrentan');

  const full = path.join(__dirname, '..', 'tmp-netkeiba-result.html');
  if (fs.existsSync(full)) {
    const big = fs.readFileSync(full, 'utf8');
    const pr = parseResultPage(big);
    assert(pr && pr.payouts && pr.payouts.umaren.length > 0, 'full html should parse umaren');
    console.log('tmp-netkeiba-result.html: umaren sample', pr.payouts.umaren[0]);
  }

  console.log('OK netkeiba payout parse');
}

main();
