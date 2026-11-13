#!/usr/bin/env node
// model-speed-load · repeat.mjs 离线自检（不联网、不调用模型、不发模型请求）
//
// 跑法：node --test scripts/repeat-selftest.mjs

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runRepeat } from './repeat.mjs';

const HASH = 'a'.repeat(64);

function makeRun(overrides) {
  const base = {
    resultSchemaVersion: 1,
    metricVersion: 'v3-request-wall',
    taskTemplateHash: HASH,
    taskVersion: 'dev-short-v1',
    acceptanceCommand: 'node --test --test-isolation=none',
    runId: 'run-1',
    outcome: 'passed',
    elapsedMs: 96000,
    failureReason: null,
    outOfScopeChanges: [],
    environmentFlags: [],
    environment: { start: {}, finish: {}, changedFields: [], attributionInvalidFields: [] },
    metrics: {
      elapsedSeconds: 96,
      speedTps: 12.5,
      requestWallSeconds: 80,
      toolMs: 18000,
      outputTokens: 1000,
      devRequestCount: 5,
      toolCount: 10,
    },
    env: {
      provider: 'provider-a',
      model: 'model-a',
      agentPreset: 'standard',
      plugins: [],
      reasoning: null,
      dshVersion: '0.2.2-rc.1',
      fingerprint: { toolNames: ['read', 'write', 'pwsh'], toolCount: 3, toolNamesHash: 'hash-a' },
    },
    dataQuality: {},
  };
  return Object.assign(base, overrides || {});
}

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repeat-selftest-'));
}

function writeRun(workspace, run) {
  const dir = path.join(workspace, '.speedtest', run.runId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'result.json');
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + '\n', 'utf8');
  return file;
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('3 个通过轮次：计数、中位数、MAD、产物正确', async () => {
  const workspace = makeWorkspace();
  const files = [
    writeRun(workspace, makeRun({ runId: 'run-1', elapsedMs: 90000, metrics: { ...makeRun().metrics, speedTps: 12 } })),
    writeRun(workspace, makeRun({ runId: 'run-2', elapsedMs: 96000, metrics: { ...makeRun().metrics, speedTps: 13 } })),
    writeRun(workspace, makeRun({ runId: 'run-3', elapsedMs: 102000, metrics: { ...makeRun().metrics, speedTps: 14 } })),
  ];
  const before = files.map(hashFile);
  const result = await runRepeat({ workspace, runs: files, outDir: workspace });
  assert.equal(result.ok, true);
  assert.equal(result.repeat.batch.total, 3);
  assert.equal(result.repeat.batch.passed, 3);
  assert.equal(result.repeat.environment.consistent, true);
  assert.equal(result.repeat.stats.metrics.elapsedSeconds.n, 3);
  assert.equal(result.repeat.stats.metrics.elapsedSeconds.median, 96);
  assert.equal(result.repeat.stats.metrics.elapsedSeconds.mad, 6);
  assert.equal(result.repeat.stats.metrics.speedTps.median, 13);
  assert.equal(fs.existsSync(result.jsonPath), true);
  assert.equal(fs.existsSync(result.mdPath), true);
  assert.match(result.markdown, /模型测速批次汇总/);
  assert.deepEqual(files.map(hashFile), before, '原始 result.json 不得被修改');
});

test('失败轮次不计入速度统计，但计数和逐轮表保留', async () => {
  const workspace = makeWorkspace();
  const files = [
    writeRun(workspace, makeRun({ runId: 'run-1' })),
    writeRun(workspace, makeRun({ runId: 'run-2', elapsedMs: 90000 })),
    writeRun(workspace, makeRun({
      runId: 'run-3',
      outcome: 'failed',
      failureReason: 'tests-not-passed',
      elapsedMs: 70000,
    })),
  ];
  const result = await runRepeat({ workspace, runs: files, outDir: workspace });
  assert.equal(result.ok, true);
  assert.equal(result.repeat.batch.passed, 2);
  assert.equal(result.repeat.batch.failed, 1);
  assert.equal(result.repeat.stats.eligible, 2);
  assert.equal(result.repeat.stats.metrics.elapsedSeconds.n, 2);
  assert.match(result.markdown, /失败/);
});

test('环境不一致：拒绝合并中位数并标出字段', async () => {
  const workspace = makeWorkspace();
  const files = [
    writeRun(workspace, makeRun({ runId: 'run-1' })),
    writeRun(workspace, makeRun({
      runId: 'run-2',
      env: { ...makeRun().env, model: 'model-b' },
    })),
  ];
  const result = await runRepeat({ workspace, runs: files, outDir: workspace });
  assert.equal(result.ok, true);
  assert.equal(result.repeat.environment.consistent, false);
  assert.ok(result.repeat.environment.blockingFields.includes('model'));
  assert.equal(result.repeat.stats.metrics, null);
  assert.equal(result.repeat.stats.reason, 'environment-mismatch');
  assert.match(result.markdown, /环境不一致/);
});

test('单轮：写报告但不计算中位数', async () => {
  const workspace = makeWorkspace();
  const file = writeRun(workspace, makeRun({ runId: 'run-1' }));
  const result = await runRepeat({ workspace, runs: [file], outDir: workspace });
  assert.equal(result.ok, true);
  assert.equal(result.repeat.batch.total, 1);
  assert.equal(result.repeat.stats.metrics, null);
  assert.equal(result.repeat.stats.reason, 'insufficient-successful-runs');
  assert.match(result.markdown, /样本不足/);
});

test('版本不符：拒绝并返回错误码', async () => {
  const workspace = makeWorkspace();
  const file = writeRun(workspace, makeRun({ runId: 'run-1', resultSchemaVersion: 2 }));
  const result = await runRepeat({ workspace, runs: [file], outDir: workspace });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RESULT-SCHEMA-UNSUPPORTED');
});

test('任务哈希不一致：拒绝混合', async () => {
  const workspace = makeWorkspace();
  const files = [
    writeRun(workspace, makeRun({ runId: 'run-1' })),
    writeRun(workspace, makeRun({ runId: 'run-2', taskTemplateHash: 'b'.repeat(64) })),
  ];
  const result = await runRepeat({ workspace, runs: files, outDir: workspace });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RUN-COMPATIBILITY');
});

test('无报告轮次：计数与报告追加', async () => {
  const workspace = makeWorkspace();
  const files = [
    writeRun(workspace, makeRun({ runId: 'run-1' })),
    writeRun(workspace, makeRun({ runId: 'run-2', elapsedMs: 90000 })),
  ];
  const result = await runRepeat({
    workspace,
    runs: files,
    outDir: workspace,
    rounds: [{ index: 3, status: 'no-report', error: '没有找到 result.json' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.repeat.batch.total, 3);
  assert.equal(result.repeat.batch.noReport, 1);
  assert.match(result.markdown, /无报告/);
});

test('共同未知字段：警告但可继续', async () => {
  const workspace = makeWorkspace();
  const envA = { ...makeRun().env, dshVersion: null };
  const envB = { ...makeRun().env, dshVersion: null };
  const files = [
    writeRun(workspace, makeRun({ runId: 'run-1', env: envA })),
    writeRun(workspace, makeRun({ runId: 'run-2', env: envB })),
  ];
  const result = await runRepeat({ workspace, runs: files, outDir: workspace });
  assert.equal(result.ok, true);
  assert.equal(result.repeat.environment.consistent, true);
  assert.ok(result.repeat.environment.warnings.some(function (warning) {
    return warning.indexOf('dshVersion') >= 0;
  }));
});

test('重复 runId：拒绝', async () => {
  const workspace = makeWorkspace();
  const files = [
    writeRun(workspace, makeRun({ runId: 'run-1' })),
    writeRun(workspace, makeRun({ runId: 'run-1', elapsedMs: 90000 })),
  ];
  const result = await runRepeat({ workspace, runs: files, outDir: workspace });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DUPLICATE-RUN');
});
