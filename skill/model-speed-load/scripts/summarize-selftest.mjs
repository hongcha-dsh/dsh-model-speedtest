#!/usr/bin/env node
// model-speed-load · 显式 run 汇总器离线自测
// 只用 Node 内置模块；不联网、不调用模型、不读取真实会话或 DSH_HOME。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

import {
  SummarizeError,
  bootstrapMedianLogRatios,
  describe,
  loadRuns,
  median,
  normalizePlugins,
  parseArgs,
  runSummary,
} from './summarize.mjs';

const KEEP = process.argv.slice(2).includes('--keep');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'model-speed-summary-selftest-'));
const FIXED_NOW = new Date('2026-11-10T12:00:00+08:00');
const tests = [];
let workspaceCounter = 0;

function test(name, body) {
  tests.push({ name: name, body: body });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function workspace(name) {
  workspaceCounter += 1;
  const dir = path.join(ROOT, String(workspaceCounter).padStart(2, '0') + '-' + name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRun(runId, elapsedSeconds, pluginEnabled) {
  const toolNames = pluginEnabled ? ['read', 'target-tool'] : ['read'];
  const plugins = [{ id: 'other', version: '2.0.0' }];
  if (pluginEnabled) plugins.push({ id: 'target', version: '1.0.0' });
  return {
    resultSchemaVersion: 1,
    metricVersion: 'v3-request-wall',
    taskTemplateHash: 'a'.repeat(64),
    taskVersion: 'dev-short-v1',
    acceptanceCommand: 'node --test --test-isolation=none',
    runId: runId,
    outcome: 'passed',
    elapsedMs: elapsedSeconds * 1000,
    outOfScopeChanges: [],
    environmentFlags: [],
    environment: {
      start: { taskVersion: 'dev-short-v1' },
      finish: { taskVersion: 'dev-short-v1' },
      changedFields: [],
      attributionInvalidFields: [],
    },
    env: {
      provider: 'provider-a',
      model: 'model-a',
      channelAlias: 'channel-a',
      baseUrlHost: 'api.example.com',
      keyAlias: 'default-key',
      keyFingerprint: 'fingerprint-a',
      agentPreset: 'standard',
      reasoning: { effort: 'high' },
      plugins: plugins,
      dshVersion: '1.2.3',
      fingerprint: {
        provider: 'provider-a',
        model: 'model-a',
        agentPreset: 'standard',
        toolNames: toolNames,
        toolCount: toolNames.length,
        toolNamesHash: pluginEnabled ? 'bbbbbbbb' : 'aaaaaaaa',
      },
    },
    metrics: {
      requestWallSeconds: elapsedSeconds / 2,
      toolMs: 1000,
      outputTokens: 100,
      devRequestCount: 2,
      toolCount: 1,
      speedTps: 20,
      firstRequestCache: { state: 'hit', cacheReadTokens: 10 },
      summaryCache: { state: 'miss', cacheReadTokens: 0 },
    },
  };
}

function writeRuns(ws, runs) {
  for (const run of runs) {
    const runDir = path.join(ws, '.speedtest', run.runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(run, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'report.md'), 'original-report-canary\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'marker.json'), JSON.stringify({ runId: run.runId, markerTime: 1 }) + '\n', 'utf8');
  }
}

function hashTree(dir) {
  const result = {};
  function visit(current, prefix) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) {
        result[relative] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
      }
    }
  }
  if (fs.existsSync(dir)) visit(dir, '');
  return result;
}

function hashOriginalRuns(ws, runs) {
  const hashes = {};
  for (const run of runs) hashes[run.runId] = hashTree(path.join(ws, '.speedtest', run.runId));
  return hashes;
}

function assertOriginalRunsUnchanged(ws, runs, before) {
  assert.deepEqual(hashOriginalRuns(ws, runs), before, '原始 run 的任何文件都不应变化');
}

function execute(ws, runs, target, options) {
  writeRuns(ws, runs);
  const before = hashOriginalRuns(ws, runs);
  const result = runSummary(Object.assign({
    workspace: ws,
    target: target || 'plugin:target',
    runs: runs.map(function (run) { return run.runId; }),
    now: FIXED_NOW,
    bootstrapIterations: 500,
  }, options || {}));
  assertOriginalRunsUnchanged(ws, runs, before);
  const saved = JSON.parse(fs.readFileSync(result.paths.comparisonJson, 'utf8'));
  assert.equal(saved.comparisonId, result.comparison.comparisonId);
  assert.equal(fs.readFileSync(result.paths.comparisonMarkdown, 'utf8'), result.report);
  return result;
}

function assertErrorCode(body, code) {
  assert.throws(body, function (err) {
    return err instanceof SummarizeError && err.code === code;
  }, '应抛出 ' + code);
}

function alternatingRuns(pairCount, ratios) {
  const runs = [];
  for (let pair = 0; pair < pairCount; pair += 1) {
    const ratio = ratios ? ratios[pair] : 0.5;
    const a = makeRun('pair' + pair + '-a', 50, false);
    const b = makeRun('pair' + pair + '-b', 50 / ratio, true);
    if (pair % 2 === 0) runs.push(a, b);
    else runs.push(b, a);
  }
  return runs;
}

test('CLI 保序解析与中位数/极差/MAD', function () {
  const args = parseArgs([
    '--workspace', 'D:/work', '--target=plugin:target',
    '--run', 'r2', '--run=r1', '--run', 'r3',
  ]);
  assert.equal(args.workspace, 'D:/work');
  assert.equal(args.target, 'plugin:target');
  assert.deepEqual(args.runs, ['r2', 'r1', 'r3']);
  assertErrorCode(function () { parseArgs(['--workspace']); }, 'BAD-ARGS');
  assertErrorCode(function () { parseArgs(['--unknown', 'x']); }, 'BAD-ARGS');
  assert.equal(median([3, 1, 2]), 2);
  assert.deepEqual(describe([1, 2, 100]), { n: 3, median: 2, min: 1, max: 100, range: 99, mad: 1 });
  assert.deepEqual(describe([1, 3]), { n: 2, median: 2, min: 1, max: 3, range: 2, mad: 1 });
  assert.deepEqual(describe([]), { n: 0, median: null, min: null, max: null, range: null, mad: null });
  assert.equal(normalizePlugins('unknown'), null);
  assert.equal(normalizePlugins('target,other'), null);
});

test('单对 AB：A/B 比值、单对观察且无区间，原 run 不变', function () {
  const ws = workspace('single-pair');
  const result = execute(ws, [makeRun('a-1', 50, false), makeRun('b-1', 100, true)]);
  assert.equal(result.comparison.paired.validPairCount, 1);
  assert.equal(result.comparison.pairs[0].order, 'AB');
  assert.equal(result.comparison.pairs[0].ratioAOverB, 0.5);
  assert.equal(result.comparison.sampleSufficiency.level, 'insufficient');
  assert.equal(result.comparison.conclusion.code, 'single-pair-observation');
  assert.equal(result.comparison.bootstrap, null);
  assert.equal(result.comparison.attribution.status, 'eligible', '目标插件直接带来的工具差异应允许');
  assert.match(result.report, /单对观察，不能据此判定稳定差异/);
  assert.match(result.report, /少于六对完整有效样本，不输出 bootstrap 区间/);
});

test('两对 BA/AB 保序：仍样本不足，配对比值始终 A/B', function () {
  const ws = workspace('two-pairs');
  const a1 = makeRun('a-1', 40, false);
  const b1 = makeRun('b-1', 80, true);
  const b2 = makeRun('b-2', 100, true);
  const a2 = makeRun('a-2', 50, false);
  const result = execute(ws, [a1, b1, b2, a2]);
  assert.equal(result.comparison.paired.validPairCount, 2);
  assert.deepEqual(result.comparison.paired.alternation.sequence, ['AB', 'BA']);
  assert.equal(result.comparison.paired.alternation.alternating, true);
  assert.deepEqual(result.comparison.pairs.map(function (pair) { return pair.ratioAOverB; }), [0.5, 0.5]);
  assert.equal(result.comparison.sampleSufficiency.level, 'insufficient');
  assert.equal(result.comparison.bootstrap, null);
  assert.match(result.report, /两对样本不足/);
});

test('三对：初步描述、方向不一致且不输出 bootstrap', function () {
  const ws = workspace('three-pairs');
  const runs = alternatingRuns(3, [0.5, 2 / 3, 1.1]);
  const result = execute(ws, runs);
  assert.equal(result.comparison.paired.validPairCount, 3);
  assert.equal(result.comparison.sampleSufficiency.level, 'preliminary');
  assert.equal(result.comparison.paired.directions.consistent, false);
  assert.equal(result.comparison.conclusion.code, 'direction-inconsistent');
  assert.equal(result.comparison.bootstrap, null);
  assert.match(result.report, /不同轮次方向不一致/);
});

test('六对：确定性探索性 bootstrap 95% 区间，不宣称普遍显著', function () {
  const ws = workspace('six-pairs');
  const result = execute(ws, alternatingRuns(6));
  const interval = result.comparison.bootstrap;
  assert.equal(result.comparison.paired.validPairCount, 6);
  assert.equal(result.comparison.sampleSufficiency.level, 'interval-estimate');
  assert.ok(interval && interval.exploratory);
  assert.equal(interval.iterations, 500);
  assert.equal(interval.crossesZero, false);
  assert.ok(interval.upper < 0);
  assert.equal(result.comparison.conclusion.code, 'experiment-supports-a');
  assert.match(result.report, /探索性 bootstrap/);
  assert.match(result.report, /不宣称普遍显著性/);
  const again = bootstrapMedianLogRatios([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], { iterations: 50, seedText: 'fixed' });
  assert.deepEqual(again, bootstrapMedianLogRatios([0.5, 0.5, 0.5, 0.5, 0.5, 0.5], { iterations: 50, seedText: 'fixed' }));
});

test('失败排除与奇数未配对：保留清单，不进入成功/配对速度统计', function () {
  const ws = workspace('failure-unpaired');
  const failed = makeRun('b-failed', 5, true);
  failed.outcome = 'failed';
  const runs = [makeRun('a-1', 50, false), failed, makeRun('a-2', 40, false)];
  const result = execute(ws, runs);
  assert.equal(result.comparison.paired.validPairCount, 0);
  assert.equal(result.comparison.groups.A.successCount, 2);
  assert.equal(result.comparison.groups.A.statistics.elapsedSeconds.n, 2);
  assert.equal(result.comparison.groups.B.failureCount, 1);
  assert.equal(result.comparison.groups.B.statistics.elapsedSeconds.n, 0);
  assert.equal(result.comparison.pairs[0].valid, false);
  assert.ok(result.comparison.pairs[0].reasons.includes('unsuccessful-run'));
  assert.ok(result.comparison.pairs[1].reasons.includes('missing-adjacent-run'));
  assert.equal(result.comparison.runs[2].includedInSuccessStats, true);
  assert.equal(result.comparison.runs[2].includedInPairStats, false);
});

test('同组相邻与目标身份未知：不产生误导性配对', function () {
  const ws = workspace('same-and-unknown');
  const unknown = makeRun('b-unknown', 100, true);
  unknown.env.plugins = 'unknown';
  const result = execute(ws, [makeRun('a-1', 50, false), makeRun('a-2', 55, false), unknown, makeRun('b-1', 90, true)]);
  assert.equal(result.comparison.pairs[0].valid, false);
  assert.ok(result.comparison.pairs[0].reasons.includes('same-target-group'));
  assert.equal(result.comparison.pairs[1].valid, false);
  assert.equal(result.comparison.runs[2].group, 'unknown');
  assert.equal(result.comparison.attribution.status, 'insufficient-data');
  assert.equal(result.comparison.conclusion.code, 'no-valid-pair');
});

test('环境控制字段缺失：保留 A/B 描述统计但归因数据不足', function () {
  const ws = workspace('unknown-control');
  const b = makeRun('b-1', 100, true);
  b.env.model = 'unknown';
  const result = execute(ws, [makeRun('a-1', 50, false), b]);
  assert.equal(result.comparison.paired.validPairCount, 1);
  assert.equal(result.comparison.groups.A.statistics.elapsedSeconds.n, 1);
  assert.equal(result.comparison.groups.B.statistics.elapsedSeconds.n, 1);
  assert.equal(result.comparison.attribution.status, 'insufficient-data');
  assert.ok(result.comparison.attribution.missingControls.includes('model'));
  assert.match(result.comparison.conclusion.text, /归因数据不足/);
});

test('非目标插件版本一侧已知一侧未知：状态可分组，但归因不足', function () {
  const ws = workspace('partial-plugin-version');
  const a = makeRun('a-1', 50, false);
  const b = makeRun('b-1', 100, true);
  a.env.plugins = [{ id: 'other', version: '2.0.0' }];
  b.env.plugins = [{ id: 'other', version: 'unknown' }, { id: 'target', version: '1.0.0' }];
  const result = execute(ws, [a, b]);
  assert.equal(result.comparison.paired.validPairCount, 1);
  assert.equal(result.comparison.attribution.status, 'insufficient-data');
  assert.ok(result.comparison.attribution.missingControls.includes('nonTargetPlugins'));
  assert.equal(result.comparison.attribution.pluginVersionPartial[0].pluginId, 'other');

  const ws2 = workspace('different-plugin-version');
  const differentA = makeRun('a-1', 50, false);
  const differentB = makeRun('b-1', 100, true);
  differentA.env.plugins = [{ id: 'other', version: '2.0.0' }];
  differentB.env.plugins = [{ id: 'other', version: '3.0.0' }, { id: 'target', version: '1.0.0' }];
  const different = execute(ws2, [differentA, differentB]);
  assert.equal(different.comparison.attribution.status, 'mixed-environment');
  assert.ok(different.comparison.attribution.unexplainedDifferences.includes('nonTargetPlugins'));
});

test('真实配置形态：共享未知次要字段和插件版本只警告，三对仍可初步描述', function () {
  const ws = workspace('shared-unknown-real-shape');
  const runs = alternatingRuns(3);
  for (const run of runs) {
    run.env.baseUrlHost = 'unknown';
    run.env.reasoning = 'unknown';
    run.env.plugins = run.env.plugins.map(function (plugin) {
      return { id: plugin.id, version: 'unknown' };
    });
  }
  const result = execute(ws, runs);
  assert.equal(result.comparison.paired.validPairCount, 3);
  assert.equal(result.comparison.attribution.status, 'eligible');
  assert.equal(result.comparison.attribution.attributionEligible, true);
  assert.ok(result.comparison.attribution.sharedUnknownControls.includes('baseUrlHost'));
  assert.ok(result.comparison.attribution.sharedUnknownControls.includes('reasoning'));
  assert.ok(result.comparison.attribution.pluginVersionUnknown.some(function (item) {
    return item.field === 'nonTargetPlugins' && item.pluginId === 'other';
  }));
  assert.equal(result.comparison.sampleSufficiency.level, 'preliminary');
  assert.equal(result.comparison.conclusion.code, 'preliminary-a');
  assert.match(result.report, /结论以这些字段未变化为前提/);
  assert.match(result.report, /结论以这些插件版本未变化为前提/);
});

test('多因素变化：混合环境只能描述，三对也不作单因素归因', function () {
  const ws = workspace('mixed-environment');
  const runs = alternatingRuns(3);
  for (const run of runs) {
    if (run.env.plugins.some(function (plugin) { return plugin.id === 'target'; })) run.env.model = 'model-b';
  }
  const result = execute(ws, runs);
  assert.equal(result.comparison.paired.validPairCount, 3);
  assert.equal(result.comparison.attribution.status, 'mixed-environment');
  assert.ok(result.comparison.attribution.unexplainedDifferences.includes('model'));
  assert.equal(result.comparison.conclusion.code, 'mixed-environment');
  assert.match(result.report, /不能把差异归因于单一目标因素/);
});

test('environmentFlags 与分字段冲突：分别导致归因不足或无效', function () {
  const ws1 = workspace('environment-changed');
  const changed = makeRun('b-changed', 100, true);
  changed.environmentFlags = ['environment-changed'];
  changed.environment.changedFields = ['plugins'];
  const result1 = execute(ws1, [makeRun('a-1', 50, false), changed]);
  assert.equal(result1.comparison.attribution.status, 'insufficient-data');
  assert.deepEqual(result1.comparison.attribution.environmentChangedRunIds, ['b-changed']);

  const ws2 = workspace('attribution-invalid');
  const invalid = makeRun('b-invalid', 100, true);
  invalid.environmentFlags = ['attribution-invalid'];
  invalid.environment.attributionInvalidFields = ['model'];
  const result2 = execute(ws2, [makeRun('a-1', 50, false), invalid]);
  assert.equal(result2.comparison.attribution.status, 'attribution-invalid');
  assert.deepEqual(result2.comparison.attribution.attributionInvalidRunIds, ['b-invalid']);

  const ws3 = workspace('metadata-missing');
  const missing = makeRun('b-missing', 100, true);
  delete missing.environmentFlags;
  const result3 = execute(ws3, [makeRun('a-1', 50, false), missing]);
  assert.equal(result3.comparison.attribution.status, 'insufficient-data');
  assert.match(result3.comparison.attribution.reasons.join('\n'), /环境有效性字段缺失/);
});

test('channel 与 preset 使用各自目标规则，允许项不会误判混合环境', function () {
  const ws1 = workspace('channel');
  const a = makeRun('channel-a', 50, false);
  const b = makeRun('channel-b', 100, false);
  b.env.channelAlias = 'channel-b';
  b.env.baseUrlHost = 'https://user:pass@b.example.com/path?token=secret-value';
  b.env.keyAlias = 'other-key';
  b.env.keyFingerprint = 'fingerprint-b';
  const channel = execute(ws1, [a, b], 'channel');
  assert.equal(channel.comparison.groups.A.targetValue, 'channel-a');
  assert.equal(channel.comparison.groups.B.targetValue, 'channel-b');
  assert.equal(channel.comparison.attribution.status, 'eligible');
  assert.equal(channel.comparison.runs[1].environment.baseURLHost, 'b.example.com');
  assert.ok(!JSON.stringify(channel.comparison).includes('secret-value'));

  const ws2 = workspace('preset');
  const p1 = makeRun('preset-a', 50, false);
  const p2 = makeRun('preset-b', 100, false);
  p2.env.agentPreset = 'fast';
  p2.env.reasoning = { effort: 'low' };
  p2.env.fingerprint.toolNames = ['read', 'preset-tool'];
  p2.env.fingerprint.toolCount = 2;
  const preset = execute(ws2, [p1, p2], 'preset');
  assert.equal(preset.comparison.groups.A.targetValue, 'standard');
  assert.equal(preset.comparison.groups.B.targetValue, 'fast');
  assert.equal(preset.comparison.attribution.status, 'eligible');
});

test('channel 仅 Key 指纹不同也能分成 A/B，报告不泄露指纹', function () {
  const ws = workspace('channel-key-only');
  const a = makeRun('key-a', 50, false);
  const b = makeRun('key-b', 100, false);
  const fingerprintA = 'sha256:' + 'a'.repeat(64);
  const fingerprintB = 'sha256:' + 'b'.repeat(64);
  for (const run of [a, b]) {
    run.env.channelAlias = 'same-channel';
    run.env.baseUrlHost = 'same.example.com';
    run.env.keyAlias = 'unknown';
  }
  a.env.keyFingerprint = fingerprintA;
  b.env.keyFingerprint = fingerprintB;
  const result = execute(ws, [a, b], 'channel');
  assert.equal(result.comparison.paired.validPairCount, 1);
  assert.equal(result.comparison.groups.A.runIds[0], 'key-a');
  assert.equal(result.comparison.groups.B.runIds[0], 'key-b');
  assert.equal(result.comparison.groups.A.targetValue, 'same-channel');
  assert.equal(result.comparison.groups.B.targetValue, 'same-channel');
  assert.equal(result.comparison.attribution.status, 'eligible');
  assert.ok(!result.report.includes(fingerprintA));
  assert.ok(!result.report.includes(fingerprintB));
  assert.ok(!JSON.stringify(result.comparison.target).includes(fingerprintA));
  assert.ok(!JSON.stringify(result.comparison.target).includes(fingerprintB));
});

test('环境脱敏：不复制 URL 凭据、查询参数、Key 或插件配置', function () {
  const ws = workspace('redaction');
  const a = makeRun('a-secret', 50, false);
  const b = makeRun('b-secret', 100, true);
  for (const run of [a, b]) {
    run.env.baseUrlHost = 'https://user:pass@example.com/path?api_key=sk-supersecret';
    run.env.keyAlias = 'sk-supersecret';
    run.env.keyFingerprint = null;
    run.env.reasoning = { effort: 'high', apiKey: 'sk-supersecret' };
    run.env.plugins = run.env.plugins.map(function (plugin) {
      return Object.assign({}, plugin, { config: { token: 'secret-value' } });
    });
  }
  const result = execute(ws, [a, b]);
  const serialized = JSON.stringify(result.comparison) + '\n' + result.report;
  assert.ok(!serialized.includes('supersecret'));
  assert.ok(!serialized.includes('secret-value'));
  assert.ok(!serialized.includes('user:pass'));
  assert.ok(!serialized.includes('api_key='));
  assert.equal(result.comparison.runs[0].environment.baseURLHost, 'example.com');
  assert.equal(result.comparison.runs[0].environment.keyAlias, null, '疑似原文 Key 不应被猜成有效别名');
  assert.equal(result.comparison.attribution.status, 'eligible');
  assert.ok(result.comparison.attribution.sharedUnknownControls.includes('keyIdentity'));
});

test('版本、任务哈希、任务版本和验收命令不一致均在写文件前拒绝', function () {
  const cases = [
    { name: 'schema-missing', mutate: function (run) { delete run.resultSchemaVersion; }, code: 'RESULT-SCHEMA-UNSUPPORTED' },
    { name: 'metric-old', mutate: function (run) { run.metricVersion = 'v2'; }, code: 'METRIC-VERSION-UNSUPPORTED' },
    { name: 'task-hash', mutate: function (run) { run.taskTemplateHash = 'b'.repeat(64); }, code: 'RUN-COMPATIBILITY' },
    { name: 'task-version', mutate: function (run) { run.taskVersion = 'other-task'; }, code: 'RUN-COMPATIBILITY' },
    { name: 'acceptance', mutate: function (run) { run.acceptanceCommand = 'node --test'; }, code: 'RUN-COMPATIBILITY' },
    { name: 'hash-missing', mutate: function (run) { delete run.taskTemplateHash; }, code: 'TASK-FIELD-MISSING' },
    { name: 'hash-invalid', mutate: function (run) { run.taskTemplateHash = 'not-a-sha256'; }, code: 'TASK-HASH-INVALID' },
  ];
  for (const item of cases) {
    const ws = workspace(item.name);
    const runs = [makeRun('a-1', 50, false), makeRun('b-1', 100, true)];
    item.mutate(runs[1]);
    writeRuns(ws, runs);
    const before = hashOriginalRuns(ws, runs);
    assertErrorCode(function () {
      runSummary({ workspace: ws, target: 'plugin:target', runs: ['a-1', 'b-1'] });
    }, item.code);
    assertOriginalRunsUnchanged(ws, runs, before);
    assert.equal(fs.existsSync(path.join(ws, '.speedtest', 'comparisons')), false, item.name + ' 不应留下汇总目录');
  }
});

test('重复 run、缺失文件、坏 JSON 与三个渠道取值均明确拒绝', function () {
  const ws = workspace('bad-inputs');
  const runs = [makeRun('a-1', 50, false), makeRun('b-1', 100, true)];
  writeRuns(ws, runs);
  assertErrorCode(function () { loadRuns(ws, ['a-1', 'a-1']); }, 'DUPLICATE-RUN');
  assertErrorCode(function () { loadRuns(ws, ['a-1', 'not-found']); }, 'RUN-NOT-FOUND');
  const badDir = path.join(ws, '.speedtest', 'bad-json');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'result.json'), '{bad', 'utf8');
  assertErrorCode(function () { loadRuns(ws, ['a-1', 'bad-json']); }, 'RUN-JSON-INVALID');

  const c = makeRun('channel-c', 80, false);
  runs[0].env.channelAlias = 'channel-a';
  runs[1].env.channelAlias = 'channel-b';
  c.env.channelAlias = 'channel-c';
  writeRuns(ws, runs.concat([c]));
  assertErrorCode(function () { loadRuns(ws, ['a-1']); }, 'RUN-LIST-REQUIRED');
  assertErrorCode(function () {
    runSummary({ workspace: ws, target: 'channel', runs: ['a-1', 'b-1', 'channel-c'] });
  }, 'GROUP-COUNT');
});

test('显式 result.json 路径可用，路径/runId 混用仍保持给定顺序', function () {
  const ws = workspace('explicit-paths');
  const runs = [makeRun('a-1', 50, false), makeRun('b-1', 100, true)];
  writeRuns(ws, runs);
  const bPath = path.join(ws, '.speedtest', 'b-1', 'result.json');
  const result = runSummary({
    workspace: ws,
    target: 'plugin:target',
    runs: [bPath, 'a-1'],
    now: FIXED_NOW,
  });
  assert.deepEqual(result.comparison.runs.map(function (run) { return run.runId; }), ['b-1', 'a-1']);
  assert.equal(result.comparison.pairs[0].order, 'BA');
  assert.equal(result.comparison.pairs[0].ratioAOverB, 0.5);
});

test('并发污染与单项指标缺失：只排除相应判断，不估算补齐', function () {
  const ws1 = workspace('concurrency');
  const polluted = makeRun('b-polluted', 20, true);
  polluted.concurrentPollution = true;
  const concurrent = execute(ws1, [makeRun('a-1', 50, false), polluted]);
  assert.equal(concurrent.comparison.groups.B.successCount, 1);
  assert.equal(concurrent.comparison.groups.B.statistics.elapsedSeconds.n, 0);
  assert.equal(concurrent.comparison.paired.validPairCount, 0);
  assert.ok(concurrent.comparison.pairs[0].reasons.includes('concurrent-pollution'));

  const ws2 = workspace('metric-missing');
  const incomplete = makeRun('b-incomplete', 100, true);
  incomplete.metrics.requestWallSeconds = null;
  const result = execute(ws2, [makeRun('a-1', 50, false), incomplete]);
  assert.equal(result.comparison.paired.validPairCount, 1, '完成耗时仍可按有效口径配对');
  assert.equal(result.comparison.groups.B.statistics.elapsedSeconds.n, 1);
  assert.equal(result.comparison.groups.B.statistics.requestWallSeconds.n, 0);
  assert.equal(result.comparison.runs[1].elapsedSeconds, 100);
});

test('输出失败：清理临时汇总、不修改任何原 run', function () {
  const ws = workspace('write-failure');
  const runs = [makeRun('a-1', 50, false), makeRun('b-1', 100, true)];
  writeRuns(ws, runs);
  const before = hashOriginalRuns(ws, runs);
  // comparisons 是普通文件，mkdir 必然失败；无需依赖平台权限位。
  fs.writeFileSync(path.join(ws, '.speedtest', 'comparisons'), 'not-a-directory', 'utf8');
  assertErrorCode(function () {
    runSummary({ workspace: ws, target: 'plugin:target', runs: ['a-1', 'b-1'] });
  }, 'WRITE-FAILED');
  assertOriginalRunsUnchanged(ws, runs, before);
  assert.equal(fs.statSync(path.join(ws, '.speedtest', 'comparisons')).isFile(), true);
});

let failed = 0;
try {
  for (const item of tests) {
    try {
      item.body();
      console.log('ok - ' + item.name);
    } catch (err) {
      failed += 1;
      console.error('not ok - ' + item.name);
      console.error(err && err.stack ? err.stack : String(err));
    }
  }
  if (failed > 0) throw new Error(failed + ' / ' + tests.length + ' 项汇总自测失败');
  console.log('summarize selftest: OK (' + tests.length + ' tests)');
  console.log('临时目录：' + ROOT + (KEEP ? '（--keep 保留）' : '（已清理）'));
} finally {
  if (!KEEP && path.dirname(path.resolve(ROOT)) === path.resolve(os.tmpdir())
    && path.basename(ROOT).startsWith('model-speed-summary-selftest-')) {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
}
