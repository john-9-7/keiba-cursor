#!/usr/bin/env node
/**
 * live / archive の2モードでスモークテストを連続実行する。
 * 既存 scripts/test-smoke.js を子プロセス実行する薄いラッパー。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const smokeScript = path.resolve(__dirname, 'test-smoke.js');
const nodeExe = process.execPath;

function nowStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function writeBoth(stream, text, file) {
  stream.write(text);
  file.write(text);
}

function classifyError(text) {
  const s = String(text || '').toLowerCase();
  const tags = [];
  if (/401|403|unauthorized|forbidden|basic auth|認証/.test(s)) tags.push('AUTH');
  if (/timeout|timed out|etimedout|aborterror/.test(s)) tags.push('TIMEOUT');
  if (/econnrefused|enotfound|fetch failed|network|socket|dns/.test(s)) tags.push('NETWORK');
  if (/http\s*5\d\d| 5\d\d\b/.test(s)) tags.push('HTTP_5XX');
  if (/http\s*4\d\d| 4\d\d\b/.test(s)) tags.push('HTTP_4XX');
  if (/cookie|session/.test(s)) tags.push('SESSION');
  if (tags.length === 0) tags.push('UNKNOWN');
  return tags;
}

function runMode(mode, file) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SMOKE_COOKIE_PURPOSE: mode };
    writeBoth(process.stdout, `\n=== smoke (${mode}) start ===\n`, file);
    let outBuf = '';
    let errBuf = '';
    const startedAt = Date.now();
    const child = spawn(nodeExe, [smokeScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      outBuf += text;
      writeBoth(process.stdout, text, file);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      errBuf += text;
      writeBoth(process.stderr, text, file);
    });

    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0) {
        writeBoth(process.stdout, `=== smoke (${mode}) passed ===\n`, file);
        resolve({
          mode,
          ok: true,
          code,
          durationMs: Date.now() - startedAt,
          summary: 'passed',
          tags: ['OK'],
          outTail: outBuf.slice(-1200),
          errTail: errBuf.slice(-1200),
        });
      } else {
        const merged = `${outBuf}\n${errBuf}`;
        let summary = `exit code ${code}`;
        const lines = merged
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const failedLine = lines.find((l) => /❌/.test(l) || /failed/i.test(l));
        const typeLine = lines.find((l) => /(TypeError|Error:|HTTP\s*\d{3}|ECONNREFUSED|ETIMEDOUT|401|403|429|500)/i.test(l));
        if (failedLine) summary = failedLine;
        if (typeLine && typeLine !== failedLine) summary = `${summary} / ${typeLine}`;
        const tags = classifyError(`${summary}\n${merged}`);
        reject({
          mode,
          ok: false,
          code,
          durationMs: Date.now() - startedAt,
          summary,
          tags,
          outTail: outBuf.slice(-2000),
          errTail: errBuf.slice(-2000),
        });
      }
    });
  });
}

async function main() {
  const modesRaw = (process.env.SMOKE_ALL_MODES || 'live,archive').trim();
  const modes = modesRaw
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x === 'live' || x === 'archive');

  if (modes.length === 0) {
    throw new Error('SMOKE_ALL_MODES が不正です。例: live,archive');
  }

  const projectRoot = path.resolve(__dirname, '..');
  const logDir = process.env.SMOKE_LOG_DIR
    ? path.resolve(projectRoot, process.env.SMOKE_LOG_DIR)
    : path.resolve(projectRoot, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const runId = `smoke-${nowStamp()}`;
  const logPath = path.join(logDir, `${runId}.log`);
  const jsonPath = path.join(logDir, `${runId}.json`);
  const logFile = fs.createWriteStream(logPath, { flags: 'a' });
  const modeResults = [];
  const runStartedAt = Date.now();
  try {
    writeBoth(process.stdout, '--- smoke all start ---\n', logFile);
    writeBoth(process.stdout, `modes: ${modes.join(', ')}\n`, logFile);
    writeBoth(process.stdout, `log: ${logPath}\n`, logFile);
    writeBoth(process.stdout, `json: ${jsonPath}\n`, logFile);

    for (const mode of modes) {
      try {
        const result = await runMode(mode, logFile);
        modeResults.push(result);
      } catch (result) {
        modeResults.push(result);
        break;
      }
    }

    writeBoth(process.stdout, '\n--- smoke summary ---\n', logFile);
    for (const r of modeResults) {
      const line = `mode=${r.mode} ok=${r.ok} code=${r.code} durationMs=${r.durationMs} tags=${(r.tags || []).join('|')} summary=${r.summary}\n`;
      writeBoth(process.stdout, line, logFile);
      if (!r.ok) {
        writeBoth(process.stdout, `[${r.mode}] stdout tail:\n${r.outTail || '(none)'}\n`, logFile);
        writeBoth(process.stdout, `[${r.mode}] stderr tail:\n${r.errTail || '(none)'}\n`, logFile);
      }
    }

    const hasFailed = modeResults.some((r) => !r.ok);
    const payload = {
      runId,
      startedAt: new Date(runStartedAt).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - runStartedAt,
      modes,
      success: !hasFailed,
      results: modeResults.map((r) => ({
        mode: r.mode,
        ok: r.ok,
        code: r.code,
        durationMs: r.durationMs,
        tags: r.tags,
        summary: r.summary,
      })),
    };
    fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');

    if (hasFailed) {
      throw new Error('one or more smoke modes failed');
    }
    writeBoth(process.stdout, '\n✅ smoke all passed\n', logFile);
  } finally {
    logFile.end();
  }
}

main().catch((err) => {
  console.error('\n❌ smoke all failed');
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});

