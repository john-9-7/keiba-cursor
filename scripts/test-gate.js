#!/usr/bin/env node
/**
 * 開発ゲート:
 * 1) 回帰テスト
 * 2) スモーク一括
 * 3) スモークレポート
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const nodeExe = process.execPath;
const projectRoot = path.resolve(__dirname, '..');

function runScript(relPath, name) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== ${name} start ===`);
    const child = spawn(nodeExe, [path.join(projectRoot, relPath)], {
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) {
        console.log(`=== ${name} passed ===`);
        resolve();
      } else {
        reject(new Error(`${name} failed: exit code ${code}`));
      }
    });
  });
}

async function main() {
  console.log('--- test gate start ---');
  await runScript('scripts/test-regression.js', 'regression');
  await runScript('scripts/test-smoke-all.js', 'smoke-all');
  await runScript('scripts/test-smoke-report.js', 'smoke-report');
  console.log('\n✅ test gate passed');
}

main().catch((err) => {
  console.error('\n❌ test gate failed');
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});

