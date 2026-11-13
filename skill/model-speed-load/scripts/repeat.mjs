#!/usr/bin/env node
// model-speed-load · 同环境重复批次汇总器（batch-v1）
//
// 只读 result.json；不联网、不调用模型、不修改原始 run。
// 用法：
//   node scripts/repeat.mjs --workspace <批次目录> \
//     --run <result.json 绝对路径> [--run <result.json> ...] [--out <输出目录>]
//
// 与 summarize.mjs 的区别：summarize 做 A/B 配对；repeat 做同环境 N 轮描述统计，
// 只统计 outcome=passed 且未被并发污染的轮次，环境不一致时拒绝合并中位数。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESULT_SCHEMA_VERSION,
  METRIC_VERSION,
  SummarizeError,
  loadRuns,
  validateRunVersion,
  describe,
  runQuality,
  runMetrics,
  normalizeEnvironment,
  toLocalIso,
  stableStringify,
} from './summarize.mjs';

export const REPEAT_SCHEMA_VERSION = 1;
const STAT_KEYS = [
  ['elapsedSeconds', '完成耗时', '秒'],
  ['speedTps', '有效输出速度', 'tok/s'],
  ['requestWallSeconds', '模型请求耗时', '秒'],
  ['toolSeconds', '工具耗时', '秒'],
  ['outputTokens', '输出 token', '个'],
  ['devRequestCount', '请求轮数', '次'],
  ['toolCount', '工具调用', '次'],
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPathLike(text) {
  return path.isAbsolute(text) || text.includes('/') || text.includes('\\') || text.toLowerCase().endsWith('.json');
}

function resolveResultPath(workspace, input) {
  const text = String(input === undefined || input === null ? '' : input).trim();
  if (text === '') throw new SummarizeError('BAD-ARGS', '--run 不能为空');
  const inputIsPath = isPathLike(text);
  return {
    input: text,
    inputIsPath: inputIsPath,
    resultPath: inputIsPath ? path.resolve(workspace, text) : path.join(workspace, '.speedtest', text, 'result.json'),
  };
}

function loadSingleRun(workspace, input) {
  const resolved = resolveResultPath(workspace, input);
  let raw;
  try {
    raw = fs.readFileSync(resolved.resultPath, 'utf8');
  } catch (error) {
    const code = error && error.code === 'ENOENT' ? 'RUN-NOT-FOUND' : 'RUN-READ-FAILED';
    throw new SummarizeError(code, 'run 无法读取：' + resolved.resultPath + '（' + String(error && error.message) + '）');
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new SummarizeError('RUN-JSON-INVALID', 'result.json 无法解析：' + resolved.resultPath);
  }
  if (!isObject(data)) throw new SummarizeError('RUN-JSON-INVALID', 'result.json 顶层必须是对象：' + resolved.resultPath);
  const runId = typeof data.runId === 'string' ? data.runId.trim() : '';
  if (runId === '') throw new SummarizeError('RUN-ID-MISSING', 'result.json 缺少 runId：' + resolved.resultPath);
  if (!resolved.inputIsPath && runId !== resolved.input) {
    throw new SummarizeError('RUN-ID-MISMATCH', '显式 runId 与文件内容不一致：' + resolved.input + ' != ' + runId);
  }
  const record = { runId: runId, order: 1, resultPath: resolved.resultPath, data: data };
  validateRunVersion(record);
  return record;
}

function loadRecords(workspace, inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new SummarizeError('RUN-LIST-REQUIRED', '至少提供一个 --run');
  }
  if (inputs.length === 1) return [loadSingleRun(workspace, inputs[0])];
  return loadRuns(workspace, inputs);
}

function fieldStatus(values) {
  const known = values.filter(function (value) {
    return value !== null && value !== undefined && value !== '';
  });
  if (known.length === 0) return 'shared-unknown';
  const unique = new Set(known.map(function (value) {
    return typeof value === 'string' ? value : stableStringify(value);
  }));
  if (unique.size > 1) return 'different';
  if (known.length < values.length) return 'partial-unknown';
  return 'same';
}

function buildEnvironment(records) {
  const envs = records.map(function (record) {
    return normalizeEnvironment(record.data);
  });
  const channelValues = envs.map(function (env) {
    if (env.channelAlias === null && env.baseURLHost === null && env.keyIdentity === null) return null;
    return stableStringify({
      channelAlias: env.channelAlias,
      baseURLHost: env.baseURLHost,
      keyIdentity: env.keyIdentity,
    });
  });
  const fields = [
    { name: 'provider', values: envs.map(function (env) { return env.provider; }) },
    { name: 'model', values: envs.map(function (env) { return env.model; }) },
    { name: 'agentPreset', values: envs.map(function (env) { return env.agentPreset; }) },
    { name: 'reasoning', values: envs.map(function (env) { return env.reasoningCompare; }) },
    { name: 'plugins', values: envs.map(function (env) { return env.pluginsCompare; }) },
    { name: 'tools', values: envs.map(function (env) { return env.toolsCompare; }) },
    { name: 'dshVersion', values: envs.map(function (env) { return env.dshVersion; }) },
    { name: 'channel', values: channelValues },
  ].map(function (field) {
    return {
      name: field.name,
      status: fieldStatus(field.values),
      values: field.values,
    };
  });
  const blocking = fields.filter(function (field) {
    return field.status === 'different' || field.status === 'partial-unknown';
  });
  const warnings = fields.filter(function (field) {
    return field.status === 'shared-unknown';
  }).map(function (field) {
    return field.name + ' 在所有 run 中均未知，结论以该字段未变化为前提';
  });
  return {
    consistent: blocking.length === 0,
    fields: fields,
    blockingFields: blocking.map(function (field) { return field.name; }),
    warnings: warnings,
  };
}

function buildPerRun(records) {
  return records.map(function (record, index) {
    const quality = runQuality(record.data);
    const metrics = runMetrics(record.data, quality);
    const env = normalizeEnvironment(record.data);
    return {
      index: index + 1,
      runId: record.runId,
      resultPath: record.resultPath,
      outcome: typeof record.data.outcome === 'string' ? record.data.outcome : 'unknown',
      quality: quality,
      metrics: metrics,
      environment: {
        provider: env.provider,
        model: env.model,
        agentPreset: env.agentPreset,
      },
      environmentChanged: quality.environmentChanged,
      attributionInvalid: quality.attributionInvalid,
    };
  });
}

function buildStats(perRun, environment) {
  const eligible = perRun.filter(function (row) { return row.quality.metricEligible === true; });
  if (!environment.consistent) {
    return { eligible: eligible.length, metrics: null, reason: 'environment-mismatch' };
  }
  if (eligible.length < 2) {
    return { eligible: eligible.length, metrics: null, reason: 'insufficient-successful-runs' };
  }
  const metrics = {};
  for (const entry of STAT_KEYS) {
    const key = entry[0];
    const values = eligible.map(function (row) {
      return key === 'elapsedSeconds' ? row.quality.elapsedSeconds : row.metrics[key];
    }).filter(isFiniteNumber);
    if (values.length > 0) metrics[key] = describe(values);
  }
  return { eligible: eligible.length, metrics: metrics, reason: null };
}

function buildCounts(perRun, missingRounds) {
  const counts = {
    total: perRun.length + missingRounds.length,
    passed: 0,
    failed: 0,
    timeout: 0,
    aborted: 0,
    noReport: 0,
  };
  for (const row of perRun) {
    if (row.outcome === 'passed') counts.passed += 1;
    else if (row.outcome === 'timeout') counts.timeout += 1;
    else if (row.outcome === 'aborted') counts.aborted += 1;
    else counts.failed += 1;
  }
  for (const round of missingRounds) {
    if (round.status === 'no-report') counts.noReport += 1;
    else if (round.status === 'timeout') counts.timeout += 1;
    else if (round.status === 'aborted') counts.aborted += 1;
    else counts.failed += 1;
  }
  return counts;
}

function normalizeMissingRounds(rounds) {
  if (!Array.isArray(rounds)) return [];
  return rounds.filter(function (round) {
    return isObject(round);
  }).map(function (round, index) {
    return {
      index: Number.isInteger(round.index) ? round.index : index + 1,
      status: typeof round.status === 'string' ? round.status : 'no-report',
      error: typeof round.error === 'string' ? round.error : null,
    };
  });
}

export function buildRepeat(options) {
  const workspace = path.resolve(options && options.workspace ? options.workspace : process.cwd());
  const records = loadRecords(workspace, options && options.runs);
  const missingRounds = normalizeMissingRounds(options && options.rounds);
  const environment = buildEnvironment(records);
  const perRun = buildPerRun(records);
  const stats = buildStats(perRun, environment);
  const counts = buildCounts(perRun, missingRounds);
  const caveats = [
    '同环境重复测量，不是 A/B；不能据此做跨环境排名。',
    'n 很小，中位数与 MAD 只描述本次批次。',
    '失败/超时/中断/无报告轮次不计入速度统计。',
    '时段、缓存与服务端状态仍可能漂移，差异不一定来自被测环境。',
  ];
  if (!environment.consistent) {
    caveats.push('环境不一致（' + environment.blockingFields.join('、') + '），已拒绝合并中位数，只列逐轮值。');
  }
  if (stats.reason === 'insufficient-successful-runs') {
    caveats.push('通过且可计量的轮次不足 2，未计算中位数。');
  }
  return {
    schemaVersion: REPEAT_SCHEMA_VERSION,
    metricVersion: METRIC_VERSION,
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    generatedAt: toLocalIso(new Date()),
    workspace: workspace,
    batch: counts,
    environment: environment,
    stats: stats,
    perRun: perRun,
    missingRounds: missingRounds,
    caveats: caveats,
  };
}

function formatNumber(value, digits) {
  return isFiniteNumber(value) ? value.toFixed(digits) : '—';
}

function truncate(text, max) {
  const value = String(text);
  return value.length <= max ? value : value.slice(0, max - 1) + '…';
}

function outcomeText(outcome) {
  if (outcome === 'passed') return '通过';
  if (outcome === 'failed') return '失败';
  if (outcome === 'timeout') return '超时';
  if (outcome === 'aborted') return '中断';
  if (outcome === 'no-report') return '无报告';
  return String(outcome);
}

function renderEnvironmentTable(repeat) {
  const lines = ['| 字段 | 状态 | 值摘要 |', '| --- | --- | --- |'];
  const statusText = {
    same: '一致',
    different: '不一致',
    'partial-unknown': '部分未知',
    'shared-unknown': '共同未知',
  };
  for (const field of repeat.environment.fields) {
    const known = field.values.filter(function (value) {
      return value !== null && value !== undefined && value !== '';
    });
    const summary = known.length === 0 ? '未知' : truncate(known[0], 60);
    lines.push('| ' + field.name + ' | ' + (statusText[field.status] || field.status) + ' | ' + summary + ' |');
  }
  return lines.join('\n');
}

function renderStatsTable(repeat) {
  if (repeat.stats.metrics === null) {
    const reason = repeat.stats.reason === 'environment-mismatch'
      ? '环境不一致，拒绝合并中位数'
      : '通过且可计量的轮次不足 2，样本不足';
    return '> ' + reason + '（可计量轮次：' + repeat.stats.eligible + '）';
  }
  const lines = ['| 指标 | n | 中位数 | 最小 | 最大 | MAD |', '| --- | --- | --- | --- | --- | --- |'];
  for (const entry of STAT_KEYS) {
    const key = entry[0];
    const stat = repeat.stats.metrics[key];
    if (stat === undefined) continue;
    const digits = key === 'outputTokens' || key === 'devRequestCount' || key === 'toolCount' ? 0 : 3;
    lines.push('| ' + entry[1] + '（' + entry[2] + '） | ' + stat.n
      + ' | ' + formatNumber(stat.median, digits)
      + ' | ' + formatNumber(stat.min, digits)
      + ' | ' + formatNumber(stat.max, digits)
      + ' | ' + formatNumber(stat.mad, digits) + ' |');
  }
  return lines.join('\n');
}

function renderPerRunTable(repeat) {
  const rows = repeat.perRun.map(function (row) {
    return {
      index: row.index,
      outcome: row.outcome,
      elapsedSeconds: row.quality.elapsedSeconds,
      speedTps: row.metrics.speedTps,
      requestWallSeconds: row.metrics.requestWallSeconds,
      toolSeconds: row.metrics.toolSeconds,
      toolCount: row.metrics.toolCount,
      outputTokens: row.metrics.outputTokens,
      reasons: row.quality.exclusionReasons.join(', '),
    };
  }).concat(repeat.missingRounds.map(function (round) {
    return {
      index: round.index,
      outcome: round.status,
      elapsedSeconds: null,
      speedTps: null,
      requestWallSeconds: null,
      toolSeconds: null,
      toolCount: null,
      outputTokens: null,
      reasons: round.error === null ? '' : round.error,
    };
  })).sort(function (a, b) { return a.index - b.index; });

  const lines = [
    '| 轮次 | 结果 | 完成耗时(s) | 有效速度(tok/s) | 模型请求(s) | 工具(s) | 工具次数 | 输出token | 排除/说明 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    lines.push('| ' + row.index + ' | ' + outcomeText(row.outcome)
      + ' | ' + formatNumber(row.elapsedSeconds, 3)
      + ' | ' + formatNumber(row.speedTps, 3)
      + ' | ' + formatNumber(row.requestWallSeconds, 3)
      + ' | ' + formatNumber(row.toolSeconds, 3)
      + ' | ' + formatNumber(row.toolCount, 0)
      + ' | ' + formatNumber(row.outputTokens, 0)
      + ' | ' + (row.reasons === '' ? '—' : row.reasons) + ' |');
  }
  return lines.join('\n');
}

export function renderMarkdown(repeat) {
  const counts = repeat.batch;
  const lines = [
    '# 模型测速批次汇总（同环境重复）',
    '',
    '- 生成时间：' + repeat.generatedAt,
    '- 批次：共 ' + counts.total + ' 轮，通过 ' + counts.passed
      + '，失败 ' + counts.failed + '，超时 ' + counts.timeout
      + '，中断 ' + counts.aborted + '，无报告 ' + counts.noReport,
    '- 指标口径：' + repeat.metricVersion + '（有效输出速度为整请求墙钟口径）',
    '',
    '## 环境一致性',
    '',
    renderEnvironmentTable(repeat),
    '',
  ];
  if (repeat.environment.warnings.length > 0) {
    for (const warning of repeat.environment.warnings) lines.push('> 警告：' + warning);
    lines.push('');
  }
  lines.push('## 逐轮结果', '', renderPerRunTable(repeat), '', '## 统计', '', renderStatsTable(repeat), '');
  lines.push('## 说明', '');
  for (const caveat of repeat.caveats) lines.push('- ' + caveat);
  lines.push('');
  return lines.join('\n');
}

function atomicWrite(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(temporary, text, 'utf8');
  fs.renameSync(temporary, file);
}

export async function runRepeat(options) {
  const workspace = path.resolve(options && options.workspace ? options.workspace : process.cwd());
  const outDir = path.resolve(options && options.outDir ? options.outDir : workspace);
  try {
    const repeat = buildRepeat({
      workspace: workspace,
      runs: options && options.runs,
      rounds: options && options.rounds,
    });
    const markdown = renderMarkdown(repeat);
    const jsonPath = path.join(outDir, 'repeat.json');
    const mdPath = path.join(outDir, 'summary.md');
    atomicWrite(jsonPath, JSON.stringify(repeat, null, 2) + '\n');
    atomicWrite(mdPath, markdown);
    return { ok: true, repeat: repeat, markdown: markdown, jsonPath: jsonPath, mdPath: mdPath };
  } catch (error) {
    const code = error instanceof SummarizeError ? error.code : 'REPEAT-FAILED';
    return {
      ok: false,
      code: code,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function usage() {
  return [
    '用法：node scripts/repeat.mjs --workspace <批次目录> --run <result.json> [--run <...> ...] [--out <目录>]',
    '规则：只读 result.json；同环境重复统计；环境不一致或通过轮次 <2 时拒绝合并中位数。',
    '输出：<out>/repeat.json 与 <out>/summary.md。',
  ].join('\n');
}

function parseCli(argv) {
  const out = { runs: [], workspace: undefined, out: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      out.help = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new SummarizeError('BAD-ARGS', '无法识别的位置参数：' + argument);
    const equals = argument.indexOf('=');
    const key = equals > 0 ? argument.slice(2, equals) : argument.slice(2);
    let value = equals > 0 ? argument.slice(equals + 1) : argv[index + 1];
    if (equals < 0) index += 1;
    if (value === undefined || value.startsWith('--')) throw new SummarizeError('BAD-ARGS', '--' + key + ' 缺少参数值');
    if (key === 'run') out.runs.push(value);
    else if (key === 'workspace' || key === 'out') {
      if (out[key] !== undefined) throw new SummarizeError('BAD-ARGS', '--' + key + ' 只能提供一次');
      out[key] = value;
    } else {
      throw new SummarizeError('BAD-ARGS', '未知参数：--' + key);
    }
  }
  return out;
}

async function main(argv) {
  const args = parseCli(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.workspace === undefined) throw new SummarizeError('BAD-ARGS', '必须提供 --workspace\n' + usage());
  if (args.runs.length === 0) throw new SummarizeError('BAD-ARGS', '至少提供一个 --run\n' + usage());
  const result = await runRepeat({ workspace: args.workspace, runs: args.runs, outDir: args.out });
  if (!result.ok) {
    console.error(result.code + ': ' + result.message);
    return 1;
  }
  console.log(JSON.stringify({
    ok: true,
    jsonPath: result.jsonPath,
    mdPath: result.mdPath,
    batch: result.repeat.batch,
    stats: result.repeat.stats,
  }, null, 2));
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).then(function (code) {
    process.exit(code);
  }).catch(function (error) {
    console.error(error instanceof SummarizeError ? error.code + ': ' + error.message : String(error));
    process.exit(1);
  });
}
