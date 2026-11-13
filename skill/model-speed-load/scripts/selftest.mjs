#!/usr/bin/env node
// model-speed-load 离线自测（dev-short-v1）
//
// 用法：node scripts/selftest.mjs [--keep]
//
// 特性：不联网、不发起任何模型请求、不安装依赖，只用 Node 内置模块。
// 覆盖：模板「参考实现全绿 / 骨架失败」、指标聚合、缓存三态、runID 唯一性与串行锁、
//       报告渲染（含未知 / 失败 / 超时分支）、超时与失败路径、自包含检查。
//
// 本文件同时是本 skill 决策规则的「可执行参考」：SKILL.md 里的规则在这里有对应实现，
// 自测通过表示这些规则按设计文档的语义执行。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(HERE, '..');
const TEMPLATE_DIR = path.join(SKILL_ROOT, 'assets', 'dev-short-v1');

export const TASK_VERSION = 'dev-short-v1';
export const HARD_TIMEOUT_MS = 180000;
// 与 measure.mjs 保持一致：outputTokens ÷ Σdt 超过这个值就认为到达时间被批量下发压平。
export const CHUNK_BATCHING_TPS_THRESHOLD = 500;
// 环境指纹中工具清单哈希取 sha256 十六进制的前 8 位。
export const ENV_FINGERPRINT_HASH_LEN = 8;

// ---------------------------------------------------------------------------
// 一、参考实现（用于校验模板测试：参考实现必须全绿，仓库里的骨架必须失败）
// ---------------------------------------------------------------------------

export const REFERENCE_SOURCE = [
  'export function summarize(values) {',
  '  if (!Array.isArray(values)) {',
  "    throw new TypeError('values 必须是数组');",
  '  }',
  '  for (const value of values) {',
  "    if (typeof value !== 'number' || !Number.isFinite(value)) {",
  "      throw new TypeError('数组元素必须是有限数值');",
  '    }',
  '  }',
  '  const count = values.length;',
  '  if (count === 0) {',
  '    return { count: 0, min: null, max: null, median: null };',
  '  }',
  '  const sorted = [...values].sort((a, b) => a - b);',
  '  const median = count % 2 === 1',
  '    ? sorted[(count - 1) / 2]',
  '    : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;',
  '  return { count: count, min: sorted[0], max: sorted[count - 1], median: median };',
  '}',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// 二、缓存三态（设计文档 §10）
// ---------------------------------------------------------------------------

const CACHE_REASON_TEXT = {
  'usage-missing': 'usage 缺失',
  'request-incomplete': '请求未完成',
  'semantics-unconfirmed': '缓存字段语义未确认',
  'cache-read-invalid': 'cacheReadTokens 不可用',
  'request-not-found': '无该请求记录',
};

export function parseCacheState(input) {
  const usage = input || {};
  if (usage.usagePresent !== true) {
    return { state: 'unknown', reason: 'usage-missing', cacheReadTokens: null };
  }
  if (usage.requestComplete !== true) {
    return { state: 'unknown', reason: 'request-incomplete', cacheReadTokens: null };
  }
  if (usage.cacheSemanticsConfirmed !== true) {
    return { state: 'unknown', reason: 'semantics-unconfirmed', cacheReadTokens: null };
  }
  const tokens = usage.cacheReadTokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) {
    return { state: 'unknown', reason: 'cache-read-invalid', cacheReadTokens: null };
  }
  if (tokens > 0) {
    return { state: 'hit', reason: 'cache-read-positive', cacheReadTokens: tokens };
  }
  return { state: 'miss', reason: 'cache-read-zero', cacheReadTokens: 0 };
}

export function formatCacheState(state) {
  const s = state || { state: 'unknown', reason: 'usage-missing' };
  if (s.state === 'hit') {
    return '命中（cacheReadTokens=' + s.cacheReadTokens + '）';
  }
  if (s.state === 'miss') {
    return '未命中（cacheReadTokens=0）';
  }
  return '未知（' + (CACHE_REASON_TEXT[s.reason] || '数据不足') + '）';
}

// ---------------------------------------------------------------------------
// 三、runID 与串行锁（设计文档 §5）
// ---------------------------------------------------------------------------

function pad(value, width) {
  let text = String(value);
  while (text.length < width) text = '0' + text;
  return text;
}

export function formatStamp(date) {
  return pad(date.getFullYear(), 4)
    + pad(date.getMonth() + 1, 2)
    + pad(date.getDate(), 2)
    + '-'
    + pad(date.getHours(), 2)
    + pad(date.getMinutes(), 2)
    + pad(date.getSeconds(), 2);
}

export function createRunIdFactory(options) {
  const opts = options || {};
  const now = opts.now || function () { return new Date(); };
  const rand = opts.rand || function () { return Math.random(); };
  const seen = new Set();
  return function nextRunId() {
    const stamp = formatStamp(now());
    let attempt = 0;
    let id;
    do {
      const tail = ('00000000' + Math.floor(rand() * 0xffffffff).toString(16)).slice(-8);
      id = stamp + '-' + tail + (attempt === 0 ? '' : '-' + attempt);
      attempt += 1;
    } while (seen.has(id));
    seen.add(id);
    return id;
  };
}

export function pickRunId(factory, rootDir) {
  for (let i = 0; i < 100; i += 1) {
    const id = factory();
    if (!fs.existsSync(path.join(rootDir, id))) return id;
  }
  throw new Error('无法生成唯一 runID：目录里已有太多同名运行');
}

export function acquireLock(lockPath, payload) {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeSync(fd, JSON.stringify(payload));
    } finally {
      fs.closeSync(fd);
    }
    return { acquired: true, lock: payload };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      let existing = null;
      let corrupt = false;
      try {
        existing = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch (parseErr) {
        corrupt = true;
      }
      return { acquired: false, reason: 'lock-exists', existing: existing, corrupt: corrupt };
    }
    throw err;
  }
}

export function releaseLock(lockPath, runId) {
  let current;
  try {
    current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { released: false, reason: 'no-lock' };
    return { released: false, reason: 'unreadable' };
  }
  if (!current || current.runId !== runId) {
    return { released: false, reason: 'not-owner' };
  }
  fs.unlinkSync(lockPath);
  return { released: true };
}

export function decideStaleLock(lockPath, options) {
  const opts = options || {};
  let current = null;
  let corrupt = false;
  try {
    current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { action: 'free' };
    corrupt = true;
  }
  if (corrupt || !current || typeof current.runId !== 'string') {
    return { action: 'blocked', reason: 'unknown-lock-state', lock: null };
  }
  if (opts.confirmedTaskEnded === true) {
    return { action: 'cleanable', lock: current, archiveTo: lockPath + '.stale-' + Date.now() };
  }
  return { action: 'blocked', reason: 'needs-confirmation', lock: current };
}

// ---------------------------------------------------------------------------
// 四、指标聚合（设计文档 §9）
// ---------------------------------------------------------------------------

const SPEED_REASON_TEXT = {
  'no-requests': '无可用请求记录',
  'request-incomplete': '存在未完成的请求',
  'token-incomplete': 'token 数据不完整',
  'time-incomplete': '整请求耗时数据不完整（缺 step/start 或消息时间）',
};

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// 主口径｜有效输出速度：speedTps = Σ outputTokens ÷ Σ requestWallSeconds。
// 任一开发请求缺 usage 或缺整请求墙钟 → 整体速度 unknown，不估算、不回退到跨度或 Σdt。
export function computeMetrics(run) {
  const requests = Array.isArray(run.requests) ? run.requests : [];
  const devRequests = requests.filter(function (req) {
    return (req.purpose || 'dev') === 'dev';
  });

  let outputTokens = 0;
  let requestWallSeconds = 0;
  let streamSpanSeconds = 0;
  let chunkDeltaSeconds = 0;
  let tokensOk = devRequests.length > 0;
  let wallOk = devRequests.length > 0;
  let spanOk = devRequests.length > 0;
  let chunkDeltasOk = devRequests.length > 0;
  const speedMissingRequestIds = [];
  const streamSpanMissingRequestIds = [];
  const chunkDeltaMissingRequestIds = [];
  const chunkBatchingRequestIds = [];

  for (const req of devRequests) {
    const id = req.id || ('r' + (devRequests.indexOf(req) + 1));
    if (isFiniteNumber(req.outputTokens) && req.outputTokens >= 0) {
      outputTokens += req.outputTokens;
    } else {
      tokensOk = false;
    }
    // 主口径：整请求墙钟（step/start → assistant/message），含预填、排队、思考与吐字。
    if (isFiniteNumber(req.requestWallSeconds) && req.requestWallSeconds > 0) {
      requestWallSeconds += req.requestWallSeconds;
    } else {
      wallOk = false;
      speedMissingRequestIds.push(id);
    }
    // 对照口径 1：流式跨度（首块 → 末块）。
    if (isFiniteNumber(req.streamSpanSeconds) && req.streamSpanSeconds > 0) {
      streamSpanSeconds += req.streamSpanSeconds;
    } else {
      spanOk = false;
      streamSpanMissingRequestIds.push(id);
    }
    // 对照口径 2：逐段 Σdt。
    if (isFiniteNumber(req.chunkDeltaSeconds) && req.chunkDeltaSeconds > 0) {
      chunkDeltaSeconds += req.chunkDeltaSeconds;
    } else {
      chunkDeltasOk = false;
      chunkDeltaMissingRequestIds.push(id);
    }
    if (req.chunkBatchingSuspected === true) {
      chunkBatchingRequestIds.push(id);
    }
  }

  let speedTps = null;
  let speedUnknownReason = null;
  if (devRequests.length === 0) {
    speedUnknownReason = 'no-requests';
  } else if (Array.isArray(run.incompleteSteps) && run.incompleteSteps.length > 0) {
    speedUnknownReason = 'request-incomplete';
  } else if (!tokensOk) {
    speedUnknownReason = 'token-incomplete';
  } else if (!wallOk || requestWallSeconds <= 0) {
    speedUnknownReason = 'time-incomplete';
  } else {
    speedTps = outputTokens / requestWallSeconds;
  }
  const speedTpsStreamSpan = tokensOk && spanOk && streamSpanSeconds > 0 ? outputTokens / streamSpanSeconds : null;
  const speedTpsChunkDeltas = chunkDeltasOk && tokensOk && chunkDeltaSeconds > 0
    ? outputTokens / chunkDeltaSeconds
    : null;

  const tools = (Array.isArray(run.tools) ? run.tools : []).filter(function (tool) {
    return (tool.phase || 'dev') === 'dev';
  });
  const toolsTimed = tools.every(function (tool) {
    return isFiniteNumber(tool.ms) && tool.ms >= 0;
  });
  const toolMs = tools.length === 0 ? 0 : (toolsTimed ? tools.reduce(function (sum, tool) { return sum + tool.ms; }, 0) : null);

  const firstRequest = devRequests.length > 0 ? devRequests[0] : null;
  const summaryRequest = requests.filter(function (req) { return req.purpose === 'warm-summary'; })[0] || null;

  return {
    devRequestCount: devRequests.length,
    outputTokens: devRequests.length > 0 && tokensOk ? outputTokens : null,
    requestWallSeconds: devRequests.length > 0 && wallOk ? requestWallSeconds : null,
    speedTps: speedTps,
    speedUnknownReason: speedUnknownReason,
    speedMissingRequestIds: speedMissingRequestIds,
    streamSpanSeconds: devRequests.length > 0 && spanOk ? streamSpanSeconds : null,
    speedTpsStreamSpan: speedTpsStreamSpan,
    streamSpanMissingRequestIds: streamSpanMissingRequestIds,
    chunkDeltaSeconds: devRequests.length > 0 && chunkDeltasOk ? chunkDeltaSeconds : null,
    speedTpsChunkDeltas: speedTpsChunkDeltas,
    chunkDeltaMissingRequestIds: chunkDeltaMissingRequestIds,
    chunkBatchingSuspected: chunkBatchingRequestIds.length > 0,
    chunkBatchingRequestIds: chunkBatchingRequestIds,
    toolCount: tools.length,
    toolMs: toolMs,
    firstRequestCache: firstRequest
      ? parseCacheState(firstRequest)
      : { state: 'unknown', reason: 'request-not-found', cacheReadTokens: null },
    summaryCache: summaryRequest
      ? parseCacheState(summaryRequest)
      : { state: 'unknown', reason: 'request-not-found', cacheReadTokens: null },
    summaryFirstResponseSeconds: summaryRequest && isFiniteNumber(summaryRequest.firstResponseSeconds)
      ? summaryRequest.firstResponseSeconds
      : null,
    hasSummaryRequest: summaryRequest !== null,
  };
}

// ---------------------------------------------------------------------------
// 环境指纹：provider/model + agentPreset + 工具清单（与 measure.mjs 同口径）
// ---------------------------------------------------------------------------

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

export function normalizeToolNames(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  for (const item of list) {
    let name = null;
    if (typeof item === 'string') name = asNonEmptyString(item);
    else if (item && typeof item === 'object') name = asNonEmptyString(item.name);
    if (name) seen.add(name);
  }
  return Array.from(seen).sort();
}

export function hashToolNames(toolNames) {
  const names = normalizeToolNames(toolNames);
  if (names === null) return { toolCount: null, toolNamesHash: null, toolNames: [] };
  const digest = crypto.createHash('sha256').update(names.join('\n'), 'utf8').digest('hex');
  return {
    toolCount: names.length,
    toolNamesHash: digest.slice(0, ENV_FINGERPRINT_HASH_LEN),
    toolNames: names,
  };
}

export function computeEnvFingerprint(input) {
  const source = input || {};
  const tools = hashToolNames(source.toolNames);
  return {
    provider: asNonEmptyString(source.provider),
    model: asNonEmptyString(source.model),
    agentPreset: asNonEmptyString(source.agentPreset),
    toolCount: tools.toolCount,
    toolNamesHash: tools.toolNamesHash,
    toolNames: tools.toolNames,
  };
}

// 报告行：a1b2c3d4 · 12 个工具 · deepseek-v4.1-flash · preset=standard
export function formatEnvFingerprint(fingerprint) {
  const fp = fingerprint || {};
  const hash = asNonEmptyString(fp.toolNamesHash);
  const count = isFiniteNumber(fp.toolCount) ? fp.toolCount : null;
  const model = asNonEmptyString(fp.model);
  const preset = asNonEmptyString(fp.agentPreset);
  if (!hash && count === null && !model && !preset) return '未知';
  return [
    hash || '工具哈希未知',
    count === null ? '工具数未知' : count + ' 个工具',
    model || '未知模型',
    preset ? 'preset=' + preset : 'preset=未知',
  ].join(' · ');
}

// ---------------------------------------------------------------------------
// 五、结果判定（设计文档 §12）
// ---------------------------------------------------------------------------

export function evaluateRun(input) {
  const data = input || {};
  const elapsed = data.elapsedMs;
  if (data.timedOut === true) {
    return { outcome: 'timeout', reason: 'marked-timeout' };
  }
  if (!isFiniteNumber(elapsed) || elapsed < 0) {
    return { outcome: 'failed', reason: 'missing-elapsed' };
  }
  if (elapsed > HARD_TIMEOUT_MS) {
    return { outcome: 'timeout', reason: 'over-3-minutes' };
  }
  if (data.testsPassed !== true) {
    return { outcome: 'failed', reason: 'tests-not-passed' };
  }
  const outOfScope = Array.isArray(data.outOfScopeChanges) ? data.outOfScopeChanges : [];
  if (outOfScope.length > 0) {
    return { outcome: 'failed', reason: 'out-of-scope-changes' };
  }
  return { outcome: 'passed', reason: 'ok' };
}

// ---------------------------------------------------------------------------
// 六、报告渲染（设计文档 §11）
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /(sk-)[A-Za-z0-9_-]{6,}/g,
  /(ak-)[A-Za-z0-9_-]{6,}/g,
  /(Bearer\s+)[A-Za-z0-9._-]{6,}/g,
];

export function maskSecrets(value) {
  let text = String(value);
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '$1***');
  }
  return text;
}

function text(value) {
  if (value === null || value === undefined) return '未知';
  const trimmed = String(value).trim();
  if (trimmed === '') return '未知';
  return maskSecrets(trimmed);
}

function outcomeText(outcome) {
  if (outcome === 'passed') return '通过';
  if (outcome === 'timeout') return '超时';
  return '失败';
}

const FAILURE_REASON_TEXT = {
  'tests-not-passed': '测试未全部通过',
  'out-of-scope-changes': '存在越界修改',
  'missing-elapsed': '缺少完成时间数据',
  'marked-timeout': '到达 3 分钟硬上限',
  'over-3-minutes': '超过 3 分钟硬上限',
  'unknown': '原因未知',
};

function elapsedCell(outcome, elapsedMs) {
  if (!isFiniteNumber(elapsedMs)) return '未知';
  const seconds = (elapsedMs / 1000).toFixed(1);
  if (outcome === 'timeout') return seconds + ' 秒（已超过 3 分钟硬上限）';
  return seconds + ' 秒';
}

function speedCell(outcome, metrics) {
  if (outcome !== 'passed') {
    return '未知（任务未通过，原始数据见 result.json）';
  }
  if (metrics.speedTps === null) {
    return '未知（' + (SPEED_REASON_TEXT[metrics.speedUnknownReason] || '数据不足') + '，未估算）';
  }
  return metrics.speedTps.toFixed(1) + ' tok/s';
}

// 「模型请求耗时（含预填与思考）」= Σ requestWallSeconds（step/start → assistant/message）。
function requestWallCell(metrics) {
  if (metrics.requestWallSeconds === null) return '未知';
  return metrics.requestWallSeconds.toFixed(1) + ' 秒';
}

function toolCell(metrics) {
  if (metrics.toolMs === null) return '未知 / ' + metrics.toolCount + ' 次';
  return (metrics.toolMs / 1000).toFixed(1) + ' 秒 / ' + metrics.toolCount + ' 次';
}

function firstResponseCell(metrics) {
  if (metrics.summaryFirstResponseSeconds === null) return '未知';
  return metrics.summaryFirstResponseSeconds.toFixed(2) + ' 秒';
}

function buildNotes(run, metrics) {
  const notes = [];
  const outcome = run.outcome || 'failed';
  const outOfScope = Array.isArray(run.outOfScopeChanges) ? run.outOfScopeChanges : [];

  if (outcome !== 'passed') {
    const reason = FAILURE_REASON_TEXT[run.failureReason] || FAILURE_REASON_TEXT.unknown;
    notes.push('任务未通过（' + reason + '），已观察到的耗时与 token 原始数据保留在 result.json，不作为成功完成速度上报。');
  }
  if (outcome === 'timeout') {
    notes.push('已超过 3 分钟硬上限，任务按超时记为未完成。');
  }
  if (outOfScope.length > 0) {
    notes.push('越界修改：' + outOfScope.join('、') + '（只允许修改 src/summary.js）。');
  }
  if (outcome === 'passed' && metrics.speedTps === null) {
    notes.push('有效输出速度为未知（' + (SPEED_REASON_TEXT[metrics.speedUnknownReason] || '数据不足') + '），按口径不做估算。');
  }
  const wallMissingIds = Array.isArray(metrics.speedMissingRequestIds) ? metrics.speedMissingRequestIds : [];
  if (outcome === 'passed' && wallMissingIds.length > 0) {
    notes.push('有 ' + wallMissingIds.length + ' 个开发请求缺少 step/start（或消息时间），整请求墙钟无法计算（'
      + wallMissingIds.join('、') + '）；主速度按口径记未知，不估算、不回退跨度。');
  }
  // 对照口径只在报告可通过时给，且明确标注「仅供参考」；失败/超时不写任何 tok/s。
  if (outcome === 'passed' && isFiniteNumber(metrics.speedTpsStreamSpan)) {
    notes.push('对照：流式跨度口径 ' + metrics.speedTpsStreamSpan.toFixed(1) + ' tok/s（受服务端缓冲影响，仅供参考）');
  }
  if (outcome === 'passed' && isFiniteNumber(metrics.speedTpsChunkDeltas)) {
    notes.push('对照：逐段 Σdt 口径 ' + metrics.speedTpsChunkDeltas.toFixed(1) + ' tok/s（受服务端批量下发影响，仅供参考）');
  }
  if (outcome === 'passed' && isFiniteNumber(metrics.streamSpanSeconds) && isFiniteNumber(metrics.chunkDeltaSeconds)) {
    notes.push('对照明细：跨度合计 ' + metrics.streamSpanSeconds.toFixed(1) + ' 秒、Σdt 合计 '
      + metrics.chunkDeltaSeconds.toFixed(1) + ' 秒（同一批请求，均不参与结论）。');
  }
  if (metrics.chunkBatchingSuspected === true) {
    notes.push('有请求疑似批量下发（大量 token 挤在同一个 SSE 包里），逐段 Σdt 口径会高估速度，只能作对照。');
  }
  if (!metrics.hasSummaryRequest) {
    notes.push('未取得固定短总结请求的可用数据，暖缓存与首响应时间未知。');
  }
  if (run.metricsSource === 'unknown') {
    notes.push('请求级 usage 无法可靠读取（metricsSource=unknown），相关字段按未知处理。');
  }
  const extra = Array.isArray(run.notes) ? run.notes : [];
  for (const note of extra) {
    if (note) notes.push(maskSecrets(note));
  }
  return notes;
}

function plainSummary(run, metrics) {
  const outcome = run.outcome || 'failed';
  const elapsed = isFiniteNumber(run.elapsedMs) ? (run.elapsedMs / 1000).toFixed(1) : null;
  let line;
  if (outcome === 'passed') line = '本次任务完成';
  else if (outcome === 'timeout') line = '本次任务超时';
  else line = '本次任务未完成';
  line += elapsed === null ? '，实际耗时未知' : '，用时 ' + elapsed + ' 秒';
  if (metrics.toolMs !== null) {
    line += '，其中工具运行占 ' + (metrics.toolMs / 1000).toFixed(1) + ' 秒';
  }
  line += '；';
  if (metrics.summaryCache.state === 'hit') line += '短总结命中了暖缓存';
  else if (metrics.summaryCache.state === 'miss') line += '短总结未命中暖缓存';
  else line += '短总结缓存状态未知';
  return line + '。';
}

export function renderReport(run) {
  const metrics = computeMetrics(run);
  const outcome = run.outcome || 'failed';
  const env = run.env || {};

  const provider = text(env.provider);
  const model = text(env.model);
  const providerModel = (provider === '未知' && model === '未知') ? '未知' : provider + ' / ' + model;

  const lines = [];
  lines.push('# 当前环境测速报告', '');
  lines.push('- 时间：' + text(run.startedAt));
  lines.push('- provider/model：' + providerModel);
  lines.push('- 环境指纹：' + text(formatEnvFingerprint(env.fingerprint)));
  lines.push('- 渠道/Key 别名：' + text(env.channelAlias));
  lines.push('- 插件组合：' + text(env.plugins));
  lines.push('- 推理设置：' + text(env.reasoning));
  lines.push('- 任务版本：' + text(run.taskVersion || TASK_VERSION));
  lines.push('');
  lines.push('| 指标 | 结果 |');
  lines.push('| --- | --- |');
  lines.push('| 任务结果 | ' + outcomeText(outcome) + ' |');
  lines.push('| 实际完成耗时 | ' + elapsedCell(outcome, run.elapsedMs) + ' |');
  lines.push('| 有效输出速度 | ' + speedCell(outcome, metrics) + ' |');
  lines.push('| 模型请求耗时（含预填与思考） | ' + requestWallCell(metrics) + ' |');
  lines.push('| 工具执行耗时与次数 | ' + toolCell(metrics) + ' |');
  lines.push('| 任务首次请求缓存 | ' + formatCacheState(metrics.firstRequestCache) + ' |');
  lines.push('| 短总结暖缓存 | ' + formatCacheState(metrics.summaryCache) + ' |');
  lines.push('| 短总结首响应时间 | ' + firstResponseCell(metrics) + ' |');
  lines.push('');

  const notes = buildNotes(run, metrics);
  if (notes.length > 0) {
    lines.push('补充说明：');
    for (const note of notes) lines.push('- ' + note);
    lines.push('');
  }

  lines.push(plainSummary(run, metrics));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// 七、自测脚手架
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  [ok]   ' + name);
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);
    failures.push(name + ' -> ' + message.split('\n')[0]);
    console.log('  [FAIL] ' + name);
    for (const row of message.split('\n')) console.log('         ' + row);
  }
}

function section(title) {
  console.log('');
  console.log('## ' + title);
}

function makeTempRoot() {
  const candidates = [os.tmpdir(), path.join(SKILL_ROOT, '.selftest-tmp')];
  let lastError = null;
  for (const base of candidates) {
    try {
      fs.mkdirSync(base, { recursive: true });
      return fs.mkdtempSync(path.join(base, 'msl-selftest-'));
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error('无法创建临时目录: ' + (lastError ? lastError.message : '未知原因'));
}

// 首选单进程模式：DSH 沙箱禁止 test runner 的子进程管道（node --test 会 spawn EPERM）。
// 第二种仅作等价兜底（直接执行测试文件），验收语义相同（退出码 0 = 全绿）。
const ACCEPTANCE_MODES = [
  { label: 'node --test --test-isolation=none', args: ['--test', '--test-isolation=none'] },
  { label: 'node test/summary.test.js', args: [path.join('test', 'summary.test.js')] },
];

function runOnce(cwd, args, logPath) {
  let result;
  const fd = fs.openSync(logPath, 'w');
  try {
    result = spawnSync(process.execPath, args, { cwd: cwd, stdio: ['ignore', fd, fd], timeout: 120000 });
  } finally {
    fs.closeSync(fd);
  }
  let log = '';
  try {
    log = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    log = '';
  }
  const errorCode = result.error && result.error.code ? String(result.error.code) : '';
  const blocked = /spawn EPERM|spawn EACCES/.test(log) || errorCode === 'EPERM' || errorCode === 'EACCES';
  return { status: result.status, signal: result.signal, error: result.error || null, log: log, blocked: blocked };
}

// 依次尝试两种等价的内置测试运行方式；沙箱禁止子进程管道时自动降级。
function runAcceptance(cwd, logDir) {
  const attempts = [];
  for (let i = 0; i < ACCEPTANCE_MODES.length; i += 1) {
    const mode = ACCEPTANCE_MODES[i];
    const out = runOnce(cwd, mode.args, path.join(logDir, 'accept-' + i + '.log'));
    attempts.push(mode.label + ' => ' + String(out.status) + (out.blocked ? ' (spawn blocked)' : ''));
    if (!out.blocked) {
      return { mode: mode.label, status: out.status, log: out.log, attempts: attempts };
    }
  }
  return { mode: null, status: null, log: '', attempts: attempts };
}

function tail(text, lines) {
  const rows = String(text).trim().split('\n');
  return rows.slice(Math.max(0, rows.length - lines)).join('\n');
}

function makeRun(overrides) {
  const base = {
    taskVersion: TASK_VERSION,
    runId: '20261110-164304-1a2b3c4d',
    startedAt: '2026-11-10T16:43:04+08:00',
    finishedAt: '2026-11-10T16:44:40+08:00',
    outcome: 'passed',
    elapsedMs: 96200,
    failureReason: null,
    acceptanceCommand: 'node --test --test-isolation=none',
    outOfScopeChanges: [],
    metricsSource: 'session-event-log',
    env: {
      provider: 'provider-x',
      model: 'model-y',
      agentPreset: 'standard',
      channelAlias: '渠道A',
      plugins: '插件组合A',
      reasoning: '低',
      fingerprint: computeEnvFingerprint({
        provider: 'provider-x',
        model: 'model-y',
        agentPreset: 'standard',
        toolNames: ['write', 'read'],
      }),
    },
    requests: [
      // 主口径用 requestWallSeconds（整请求墙钟）；streamSpanSeconds / chunkDeltaSeconds 只作对照。
      { id: 'r1', purpose: 'dev', outputTokens: 500, requestWallSeconds: 6, streamSpanSeconds: 4, chunkDeltaSeconds: 4, chunkBatchingSuspected: false, usagePresent: true, requestComplete: true, cacheReadTokens: 0, cacheSemanticsConfirmed: true, cacheWriteTokens: 1200 },
      { id: 'r2', purpose: 'dev', outputTokens: 300, requestWallSeconds: 3, streamSpanSeconds: 2, chunkDeltaSeconds: 2, chunkBatchingSuspected: false, usagePresent: true, requestComplete: true, cacheReadTokens: 0, cacheSemanticsConfirmed: true },
      { id: 'r3', purpose: 'warm-summary', outputTokens: 120, requestWallSeconds: 2, streamSpanSeconds: 1.5, chunkDeltaSeconds: 1.5, chunkBatchingSuspected: false, usagePresent: true, requestComplete: true, cacheReadTokens: 1920, cacheSemanticsConfirmed: true, firstResponseSeconds: 1.24 },
    ],
    tools: [
      { name: 'read', phase: 'dev', ms: 6000 },
      { name: 'write', phase: 'dev', ms: 12000 },
    ],
    notes: [],
  };
  return Object.assign({}, base, overrides || {});
}

// ---------------------------------------------------------------------------
// 八、检查项
// ---------------------------------------------------------------------------

function checkTemplate(tempRoot) {
  section('模板与验收（assets/dev-short-v1）');

  check('模板文件齐全且 package.json 无第三方依赖', function () {
    for (const rel of ['README.md', 'src/summary.js', 'test/summary.test.js', 'package.json']) {
      assert.ok(fs.existsSync(path.join(TEMPLATE_DIR, rel)), '缺少模板文件: ' + rel);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'package.json'), 'utf8'));
    assert.equal(pkg.type, 'module');
    assert.equal(pkg.dependencies, undefined, 'package.json 不应有 dependencies');
    assert.equal(pkg.devDependencies, undefined, 'package.json 不应有 devDependencies');
  });

  check('验收测试覆盖 count/min/max/median、偶数中位数、空数组、TypeError、不修改入参', function () {
    const src = fs.readFileSync(path.join(TEMPLATE_DIR, 'test', 'summary.test.js'), 'utf8');
    for (const keyword of ['count', 'min', 'max', 'median', 'TypeError', '空数组', '不修改入参', '偶数长度']) {
      assert.ok(src.includes(keyword), '验收测试缺少覆盖: ' + keyword);
    }
    const specifiers = [];
    const re = /from\s+'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) specifiers.push(m[1]);
    for (const spec of specifiers) {
      assert.ok(spec.startsWith('node:') || spec.startsWith('.'), '验收测试不应引用第三方包: ' + spec);
    }
  });

  check('package.json 与 README 统一使用 --test-isolation=none', function () {
    const pkg = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.test, 'node --test --test-isolation=none');
    const readme = fs.readFileSync(path.join(TEMPLATE_DIR, 'README.md'), 'utf8');
    assert.ok(readme.includes('node --test --test-isolation=none'), 'README 必须给出单进程验收命令');
    assert.ok(!/^node --test\s*$/m.test(readme), 'README 不应把裸 node --test 当验收命令');
  });

  check('模板骨架仍是未实现状态（未被提前写完）', function () {
    const src = fs.readFileSync(path.join(TEMPLATE_DIR, 'src', 'summary.js'), 'utf8');
    assert.ok(src.includes('尚未实现'), '骨架必须保持未实现标记');
    assert.ok(src.includes('export function summarize'), '骨架必须导出 summarize');
  });

  check('骨架实现：验收测试失败（退出码非 0）', function () {
    const dir = path.join(tempRoot, 'skeleton');
    fs.cpSync(TEMPLATE_DIR, dir, { recursive: true });
    const result = runAcceptance(dir, path.dirname(dir));
    assert.ok(result.mode, '两种测试运行方式都被环境阻断: ' + result.attempts.join(' | '));
    assert.notEqual(result.status, 0, '骨架实现不应通过验收测试（模式: ' + result.mode + '）');
    assert.ok(/pass 0|fail [1-9]|not ok/.test(result.log), '骨架失败应体现为测试失败，而不是启动失败:\n' + tail(result.log, 8));
  });

  check('参考实现：验收测试全绿（退出码 0，15/15）', function () {
    const dir = path.join(tempRoot, 'reference');
    fs.cpSync(TEMPLATE_DIR, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'summary.js'), REFERENCE_SOURCE, 'utf8');
    const result = runAcceptance(dir, path.dirname(dir));
    assert.ok(result.mode, '两种测试运行方式都被环境阻断: ' + result.attempts.join(' | '));
    assert.equal(result.status, 0, '参考实现未全绿（模式: ' + result.mode + '）:\n' + tail(result.log, 12));
    assert.ok(/pass 15|# pass 15/.test(result.log), '参考实现应通过全部 15 项测试:\n' + tail(result.log, 8));
  });
}

function checkMetrics() {
  section('指标聚合（有效输出速度 = 整请求墙钟口径）');

  check('有效输出速度 = Σ outputTokens ÷ Σ 整请求墙钟（含预填与思考）', function () {
    const metrics = computeMetrics(makeRun());
    assert.equal(metrics.outputTokens, 800);
    assert.equal(metrics.requestWallSeconds, 9);
    assert.ok(Math.abs(metrics.speedTps - 800 / 9) < 1e-9);
    assert.equal(metrics.streamSpanSeconds, 6, '跨度口径作为对照并存');
    assert.ok(Math.abs(metrics.speedTpsStreamSpan - 800 / 6) < 1e-9);
    assert.equal(metrics.chunkDeltaSeconds, 6, 'Σdt 口径作为对照并存');
    assert.ok(Math.abs(metrics.speedTpsChunkDeltas - 800 / 6) < 1e-9);
    assert.equal(metrics.chunkBatchingSuspected, false, '正常请求不应被标成批量下发');
  });

  check('整请求口径优先：墙钟 4s、跨度 2.7s、Σdt 0.2s 并存时按 4s 算速度', function () {
    const run = makeRun({
      requests: [
        { id: 'r1', purpose: 'dev', outputTokens: 600, requestWallSeconds: 4, streamSpanSeconds: 2.7, chunkDeltaSeconds: 0.2, chunkBatchingSuspected: true, usagePresent: true, requestComplete: true, cacheReadTokens: 0, cacheSemanticsConfirmed: true },
      ],
    });
    const metrics = computeMetrics(run);
    assert.equal(metrics.requestWallSeconds, 4);
    assert.ok(Math.abs(metrics.speedTps - 600 / 4) < 1e-9, '主速度应为 150 tok/s，不是 222.2，更不是 3000');
    assert.ok(Math.abs(metrics.speedTpsStreamSpan - 600 / 2.7) < 1e-9, '跨度口径只作对照');
    assert.equal(metrics.speedTpsChunkDeltas, 3000, 'Σdt 口径只作对照');
    assert.equal(metrics.chunkBatchingSuspected, true);
    assert.deepEqual(metrics.chunkBatchingRequestIds, ['r1']);
    assert.ok(600 / 0.2 > CHUNK_BATCHING_TPS_THRESHOLD, '本例必须超过批量下发阈值');
  });

  check('缺 step/start（requestWallSeconds 缺失）→ 速度 unknown，对照仍保留', function () {
    const run = makeRun({
      requests: [
        { id: 'r1', purpose: 'dev', outputTokens: 300, requestWallSeconds: null, streamSpanSeconds: 1.5, chunkDeltaSeconds: 1.5, usagePresent: true, requestComplete: true, cacheReadTokens: 0, cacheSemanticsConfirmed: true },
      ],
    });
    const metrics = computeMetrics(run);
    assert.equal(metrics.speedTps, null);
    assert.equal(metrics.speedUnknownReason, 'time-incomplete');
    assert.deepEqual(metrics.speedMissingRequestIds, ['r1']);
    assert.equal(metrics.requestWallSeconds, null, '缺请求时不得给出部分 Σ墙钟');
    assert.equal(metrics.streamSpanSeconds, 1.5, '跨度对照仍然给出');
    assert.ok(Math.abs(metrics.speedTpsStreamSpan - 200) < 1e-9);
  });

  check('对照值缺失不影响主速度（只有主口径缺失才 unknown）', function () {
    const run = makeRun({
      requests: [
        { id: 'r1', purpose: 'dev', outputTokens: 300, requestWallSeconds: 2, streamSpanSeconds: null, chunkDeltaSeconds: null, usagePresent: true, requestComplete: true, cacheReadTokens: 0, cacheSemanticsConfirmed: true },
      ],
    });
    const metrics = computeMetrics(run);
    assert.ok(Math.abs(metrics.speedTps - 150) < 1e-9);
    assert.equal(metrics.streamSpanSeconds, null);
    assert.equal(metrics.speedTpsStreamSpan, null);
    assert.equal(metrics.speedTpsChunkDeltas, null);
  });

  check('工具执行耗时单独统计，不混入整请求墙钟', function () {
    const metrics = computeMetrics(makeRun());
    assert.equal(metrics.requestWallSeconds, 9, '主口径不能被工具耗时的 18 秒污染');
    assert.equal(metrics.toolMs, 18000);
    assert.equal(metrics.toolCount, 2);
    const slowTools = makeRun({
      tools: [
        { name: 'read', phase: 'dev', ms: 60000 },
        { name: 'write', phase: 'dev', ms: 120000 },
      ],
    });
    assert.equal(computeMetrics(slowTools).speedTps, metrics.speedTps, '工具再慢也不改变主速度');
  });

  check('短总结请求不计入任务主指标', function () {
    const metrics = computeMetrics(makeRun());
    assert.equal(metrics.outputTokens, 800, '只统计 purpose=dev 的请求');
    assert.equal(metrics.requestWallSeconds, 9);
  });

  check('任一请求缺 outputTokens → 速度为未知（不估算）', function () {
    const run = makeRun();
    delete run.requests[1].outputTokens;
    const metrics = computeMetrics(run);
    assert.equal(metrics.speedTps, null);
    assert.equal(metrics.speedUnknownReason, 'token-incomplete');
  });

  check('整请求墙钟为 0 / 缺失 → 速度为未知，不由对照顶替', function () {
    const zero = makeRun();
    zero.requests[0].requestWallSeconds = 0;
    assert.equal(computeMetrics(zero).speedTps, null);
    assert.equal(computeMetrics(zero).speedUnknownReason, 'time-incomplete');

    const missing = makeRun();
    delete missing.requests[0].requestWallSeconds;
    const metrics = computeMetrics(missing);
    assert.equal(metrics.speedTps, null);
    assert.equal(metrics.speedUnknownReason, 'time-incomplete');
    assert.ok(metrics.speedTpsStreamSpan !== null, '对照仍可算出，但不顶替主速度');
  });

  check('无请求记录 → 速度为未知，不出现 NaN/Infinity', function () {
    const metrics = computeMetrics(makeRun({ requests: [] }));
    assert.equal(metrics.speedTps, null);
    assert.equal(metrics.speedUnknownReason, 'no-requests');
    assert.equal(metrics.outputTokens, null);
    assert.equal(metrics.requestWallSeconds, null);
  });

  check('工具耗时缺失 → 工具耗时为未知但次数仍如实统计', function () {
    const run = makeRun();
    delete run.tools[1].ms;
    const metrics = computeMetrics(run);
    assert.equal(metrics.toolMs, null);
    assert.equal(metrics.toolCount, 2);
  });
}

function checkEnvFingerprint() {
  section('环境指纹（provider/model + agentPreset + 工具清单）');

  check('工具名排序去重，哈希取 sha256 前 8 位', function () {
    const fp = computeEnvFingerprint({
      provider: 'provider-x',
      model: 'model-y',
      agentPreset: 'standard',
      toolNames: ['write', 'read', 'run_code', 'read'],
    });
    assert.deepEqual(fp.toolNames, ['read', 'run_code', 'write']);
    assert.equal(fp.toolCount, 3);
    const expected = crypto.createHash('sha256')
      .update('read\nrun_code\nwrite', 'utf8').digest('hex').slice(0, ENV_FINGERPRINT_HASH_LEN);
    assert.equal(fp.toolNamesHash, expected);
    assert.match(fp.toolNamesHash, /^[0-9a-f]{8}$/);
  });

  check('同输入同哈希：工具顺序与重复项不同也完全一致', function () {
    const a = computeEnvFingerprint({
      provider: 'provider-x', model: 'model-y', agentPreset: 'standard',
      toolNames: ['read', 'run_code', 'write'],
    });
    const b = computeEnvFingerprint({
      provider: 'provider-x', model: 'model-y', agentPreset: 'standard',
      toolNames: ['write', 'read', 'run_code', 'write'],
    });
    assert.equal(a.toolNamesHash, b.toolNamesHash);
    assert.deepEqual(a.toolNames, b.toolNames);
    assert.equal(a.toolCount, b.toolCount);
  });

  check('报告行格式：哈希 · N 个工具 · 模型 · preset；读不到写未知', function () {
    const fp = computeEnvFingerprint({
      provider: 'provider-x', model: 'model-y', agentPreset: 'standard',
      toolNames: ['read', 'run_code', 'write'],
    });
    const line = formatEnvFingerprint(fp);
    assert.match(line, /^[0-9a-f]{8} · 3 个工具 · model-y · preset=standard$/);
    assert.equal(formatEnvFingerprint(computeEnvFingerprint({})), '未知');
    assert.equal(
      formatEnvFingerprint(computeEnvFingerprint({ model: 'model-y' })),
      '工具哈希未知 · 工具数未知 · model-y · preset=未知',
    );
  });

  check('报告出现「环境指纹」行，缺数据时写未知', function () {
    const full = renderReport(makeRun());
    assert.ok(
      full.includes('- 环境指纹：' + formatEnvFingerprint(makeRun().env.fingerprint)),
      '完整数据应渲染指纹行：\n' + full,
    );
    const empty = renderReport(makeRun({ env: {} }));
    assert.ok(empty.includes('- 环境指纹：未知'));
  });
}

function checkCache() {
  section('缓存三态（hit / miss / unknown）');

  check('cacheReadTokens > 0 且 usage 可靠 → hit，保留原始 token', function () {
    const state = parseCacheState({ usagePresent: true, requestComplete: true, cacheSemanticsConfirmed: true, cacheReadTokens: 1920 });
    assert.equal(state.state, 'hit');
    assert.equal(state.cacheReadTokens, 1920);
    assert.equal(formatCacheState(state), '命中（cacheReadTokens=1920）');
  });

  check('cacheReadTokens = 0 且语义已确认 → miss', function () {
    const state = parseCacheState({ usagePresent: true, requestComplete: true, cacheSemanticsConfirmed: true, cacheReadTokens: 0 });
    assert.equal(state.state, 'miss');
    assert.equal(formatCacheState(state), '未命中（cacheReadTokens=0）');
  });

  check('usage 缺失 → unknown（不猜命中）', function () {
    const state = parseCacheState({ usagePresent: false, cacheReadTokens: 5000 });
    assert.equal(state.state, 'unknown');
    assert.equal(state.reason, 'usage-missing');
    assert.ok(formatCacheState(state).indexOf('未知') === 0);
  });

  check('请求未完成 → unknown', function () {
    const state = parseCacheState({ usagePresent: true, requestComplete: false, cacheSemanticsConfirmed: true, cacheReadTokens: 800 });
    assert.equal(state.state, 'unknown');
    assert.equal(state.reason, 'request-incomplete');
  });

  check('缓存字段语义未确认 → unknown', function () {
    const state = parseCacheState({ usagePresent: true, requestComplete: true, cacheSemanticsConfirmed: false, cacheReadTokens: 0 });
    assert.equal(state.state, 'unknown');
    assert.equal(state.reason, 'semantics-unconfirmed');
  });

  check('cacheWriteTokens 不算命中：有写无读 = miss，读缺失 = unknown', function () {
    const writeOnly = parseCacheState({ usagePresent: true, requestComplete: true, cacheSemanticsConfirmed: true, cacheReadTokens: 0, cacheWriteTokens: 4096 });
    assert.equal(writeOnly.state, 'miss', '缓存写入不等于读取命中');

    const writeNoRead = parseCacheState({ usagePresent: true, requestComplete: true, cacheSemanticsConfirmed: true, cacheWriteTokens: 4096 });
    assert.equal(writeNoRead.state, 'unknown');
    assert.equal(writeNoRead.reason, 'cache-read-invalid');
  });

  check('cacheReadTokens 非法（负值 / NaN / 字符串）→ unknown', function () {
    for (const bad of [-1, NaN, '120', Infinity]) {
      const state = parseCacheState({ usagePresent: true, requestComplete: true, cacheSemanticsConfirmed: true, cacheReadTokens: bad });
      assert.equal(state.state, 'unknown', '非法值必须判为未知: ' + String(bad));
    }
  });
}

function checkRunIdAndLock(tempRoot) {
  section('runID 唯一性与串行锁');

  check('runID 同一毫秒连续生成 200 次不重复', function () {
    const factory = createRunIdFactory({
      now: function () { return new Date('2026-11-10T16:43:04'); },
      rand: function () { return 0.5; },
    });
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) seen.add(factory());
    assert.equal(seen.size, 200, '固定时钟 + 固定随机数下仍必须唯一');
  });

  check('runID 格式为 <yyyyMMdd-HHmmss>-<8 位十六进制>', function () {
    const factory = createRunIdFactory({ now: function () { return new Date(2026, 10, 10, 16, 43, 4); } });
    const id = factory();
    assert.match(id, /^20261110-164304-[0-9a-f]{8}$/);
  });

  check('runID 与已有运行目录冲突时会重新生成', function () {
    const base = path.join(tempRoot, 'runs');
    fs.mkdirSync(base, { recursive: true });
    const factory = createRunIdFactory({
      now: function () { return new Date('2026-11-10T16:43:04'); },
      rand: function () { return 0.5; },
    });
    const first = factory();
    fs.mkdirSync(path.join(base, first));
    const picked = pickRunId(factory, base);
    assert.notEqual(picked, first, '不能复用已存在的运行目录');
    assert.equal(fs.existsSync(path.join(base, picked)), false);
  });

  const lockDir = path.join(tempRoot, 'locks');
  fs.mkdirSync(lockDir, { recursive: true });

  check('锁空闲时获取成功，锁文件写入 runId', function () {
    const lockPath = path.join(lockDir, 'free.lock');
    const result = acquireLock(lockPath, { runId: 'run-A', status: 'running' });
    assert.equal(result.acquired, true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).runId, 'run-A');
  });

  check('锁冲突：第二次获取被拒，且不覆盖原锁', function () {
    const lockPath = path.join(lockDir, 'busy.lock');
    assert.equal(acquireLock(lockPath, { runId: 'run-A', status: 'running' }).acquired, true);
    const second = acquireLock(lockPath, { runId: 'run-B', status: 'running' });
    assert.equal(second.acquired, false);
    assert.equal(second.reason, 'lock-exists');
    assert.equal(second.existing.runId, 'run-A');
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).runId, 'run-A', '不能并发覆盖别人的锁');
  });

  check('锁只能由持有者释放：非持有者释放被拒', function () {
    const lockPath = path.join(lockDir, 'owner.lock');
    acquireLock(lockPath, { runId: 'run-A', status: 'running' });
    const wrong = releaseLock(lockPath, 'run-B');
    assert.equal(wrong.released, false);
    assert.equal(wrong.reason, 'not-owner');
    assert.ok(fs.existsSync(lockPath), '别人的锁不能被删');
  });

  check('持有者释放后锁目录恢复空闲，可再次获取', function () {
    const lockPath = path.join(lockDir, 'owner.lock');
    const released = releaseLock(lockPath, 'run-A');
    assert.equal(released.released, true);
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(acquireLock(lockPath, { runId: 'run-C', status: 'running' }).acquired, true);
    releaseLock(lockPath, 'run-C');
  });

  check('无锁时判定为 free', function () {
    assert.equal(decideStaleLock(path.join(lockDir, 'missing.lock')).action, 'free');
  });

  check('陈旧锁未确认任务结束 → blocked，且不删除锁', function () {
    const lockPath = path.join(lockDir, 'stale.lock');
    acquireLock(lockPath, { runId: 'run-X', status: 'running' });
    const decision = decideStaleLock(lockPath, {});
    assert.equal(decision.action, 'blocked');
    assert.equal(decision.reason, 'needs-confirmation');
    assert.equal(decision.lock.runId, 'run-X');
    assert.ok(fs.existsSync(lockPath), '不得直接删除未知状态的锁');
  });

  check('陈旧锁确认任务已结束 → cleanable（归档而非删除）', function () {
    const lockPath = path.join(lockDir, 'stale.lock');
    const decision = decideStaleLock(lockPath, { confirmedTaskEnded: true });
    assert.equal(decision.action, 'cleanable');
    assert.ok(decision.archiveTo.indexOf('.stale-') > 0);
    assert.ok(fs.existsSync(lockPath), '判定 cleanable 也不应自行删除，需先改名归档');
  });

  check('锁内容损坏 → blocked（不猜、不清理）', function () {
    const lockPath = path.join(lockDir, 'corrupt.lock');
    fs.writeFileSync(lockPath, 'not-a-json', 'utf8');
    const decision = decideStaleLock(lockPath, { confirmedTaskEnded: true });
    assert.equal(decision.action, 'blocked');
    assert.equal(decision.reason, 'unknown-lock-state');
    assert.ok(fs.existsSync(lockPath));
  });
}

function checkVerdict() {
  section('结果判定（超时 / 失败 / 越界）');

  check('全部通过且未超时 → passed', function () {
    assert.equal(evaluateRun({ elapsedMs: 96000, testsPassed: true, outOfScopeChanges: [] }).outcome, 'passed');
  });

  check('恰好 180 秒 → passed（超过才算超时）', function () {
    assert.equal(evaluateRun({ elapsedMs: 180000, testsPassed: true }).outcome, 'passed');
  });

  check('180001 ms → timeout', function () {
    const verdict = evaluateRun({ elapsedMs: 180001, testsPassed: true });
    assert.equal(verdict.outcome, 'timeout');
    assert.equal(verdict.reason, 'over-3-minutes');
  });

  check('超时优先于测试结果（超时 + 测试未过 → timeout）', function () {
    assert.equal(evaluateRun({ elapsedMs: 190000, testsPassed: false }).outcome, 'timeout');
  });

  check('测试未全部通过 → failed', function () {
    const verdict = evaluateRun({ elapsedMs: 60000, testsPassed: false });
    assert.equal(verdict.outcome, 'failed');
    assert.equal(verdict.reason, 'tests-not-passed');
  });

  check('越界修改 → failed', function () {
    const verdict = evaluateRun({ elapsedMs: 60000, testsPassed: true, outOfScopeChanges: ['src/helper.js'] });
    assert.equal(verdict.outcome, 'failed');
    assert.equal(verdict.reason, 'out-of-scope-changes');
  });

  check('缺少耗时数据 → failed（不按通过处理）', function () {
    assert.equal(evaluateRun({ elapsedMs: null, testsPassed: true }).outcome, 'failed');
  });
}

function checkReport() {
  section('报告渲染（含未知 / 失败 / 超时分支）');

  const full = renderReport(makeRun());

  check('正常报告：标题、8 项指标行、通俗概括齐全', function () {
    assert.ok(full.startsWith('# 当前环境测速报告\n'), '标题必须是「当前环境测速报告」');
    for (const row of [
      '| 任务结果 | 通过 |',
      '| 实际完成耗时 | 96.2 秒 |',
      '| 有效输出速度 | 88.9 tok/s |',
      '| 模型请求耗时（含预填与思考） | 9.0 秒 |',
      '| 工具执行耗时与次数 | 18.0 秒 / 2 次 |',
      '| 任务首次请求缓存 | 未命中（cacheReadTokens=0） |',
      '| 短总结暖缓存 | 命中（cacheReadTokens=1920） |',
      '| 短总结首响应时间 | 1.24 秒 |',
    ]) {
      assert.ok(full.includes(row), '缺少指标行: ' + row);
    }
    assert.ok(full.includes('短总结命中了暖缓存'), '缺少通俗概括');
    assert.ok(full.trim().endsWith('。'), '概括句应以句号结束');
    assert.ok(
      full.includes('- 环境指纹：' + formatEnvFingerprint(makeRun().env.fingerprint)),
      '缺少环境指纹行',
    );
    assert.ok(full.includes('对照：流式跨度口径 133.3 tok/s（受服务端缓冲影响，仅供参考）'));
  });

  check('数据齐全时报告不出现「未知」（不无端降级）', function () {
    assert.ok(!full.includes('未知'), '全部数据可确认时不应写未知:\n' + full);
  });

  check('数据缺失 → 各字段写「未知」，不编造数字', function () {
    const text = renderReport(makeRun({ env: {}, requests: [], tools: [], elapsedMs: null }));
    assert.ok(text.includes('未知'), '缺数据必须出现未知');
    assert.ok(text.includes('- provider/model：未知'), 'provider/model 未知');
    assert.ok(text.includes('- 环境指纹：未知'), '环境指纹未知');
    assert.ok(!/\d+\.\d+ tok\/s/.test(text), '没有请求数据时不得出现速度数字');
    assert.ok(text.includes('未估算'), '应说明温度未知且未估算');
  });

  check('失败报告：不把失败写成成功速度', function () {
    const text = renderReport(makeRun({ outcome: 'failed', failureReason: 'tests-not-passed' }));
    assert.ok(text.includes('| 任务结果 | 失败 |'));
    assert.ok(text.includes('未知（任务未通过，原始数据见 result.json）'));
    assert.ok(!/\d+\.\d+ tok\/s/.test(text), '失败时不得出现 tok/s 数字');
    assert.ok(text.includes('不作为成功完成速度上报'));
  });

  check('超时报告：显式标出超时与 3 分钟硬上限', function () {
    const text = renderReport(makeRun({ outcome: 'timeout', failureReason: 'over-3-minutes', elapsedMs: 181000 }));
    assert.ok(text.includes('| 任务结果 | 超时 |'));
    assert.ok(text.includes('181.0 秒（已超过 3 分钟硬上限）'));
    assert.ok(!/\d+\.\d+ tok\/s/.test(text));
    assert.ok(text.includes('按超时记为未完成'));
  });

  check('越界修改写进补充说明', function () {
    const text = renderReport(makeRun({ outcome: 'failed', failureReason: 'out-of-scope-changes', outOfScopeChanges: ['src/helper.js', 'test/extra.test.js'] }));
    assert.ok(text.includes('越界修改：src/helper.js、test/extra.test.js'));
  });

  check('批量下发只影响 Σdt 对照，主速度仍按整请求墙钟', function () {
    const run = makeRun({
      requests: [
        { id: 'r1', purpose: 'dev', outputTokens: 600, requestWallSeconds: 4, streamSpanSeconds: 2.7, chunkDeltaSeconds: 0.2, chunkBatchingSuspected: true, usagePresent: true, requestComplete: true, cacheReadTokens: 0, cacheSemanticsConfirmed: true },
        { id: 'r2', purpose: 'warm-summary', outputTokens: 120, requestWallSeconds: 2, streamSpanSeconds: 1.5, chunkDeltaSeconds: 1.5, usagePresent: true, requestComplete: true, cacheReadTokens: 1920, cacheSemanticsConfirmed: true, firstResponseSeconds: 1.24 },
      ],
    });
    const text = renderReport(run);
    assert.ok(text.includes('| 模型请求耗时（含预填与思考） | 4.0 秒 |'), '模型请求耗时必须是 ΣrequestWallSeconds');
    assert.ok(text.includes('| 有效输出速度 | 150.0 tok/s |'), '600 ÷ 4 = 150，不是 222.2，更不是 3000');
    assert.ok(text.includes('对照：流式跨度口径 222.2 tok/s（受服务端缓冲影响，仅供参考）'));
    assert.ok(text.includes('对照：逐段 Σdt 口径 3000.0 tok/s（受服务端批量下发影响，仅供参考）'));
    assert.ok(text.includes('有请求疑似批量下发（大量 token 挤在同一个 SSE 包里），逐段 Σdt 口径会高估速度，只能作对照。'));
    for (const line of text.split('\n')) {
      if (line.indexOf('| 有效输出速度 |') === 0) {
        assert.ok(line.indexOf('150.0 tok/s') > 0, '主速度不能被对照口径顶替: ' + line);
      }
    }
  });

  check('缺 step/start（墙钟缺失）：报告写未知并保留对照，不估算', function () {
    const run = makeRun({
      requests: [
        { id: 'r1', purpose: 'dev', outputTokens: 300, requestWallSeconds: null, streamSpanSeconds: 1.5, chunkDeltaSeconds: 1.5, usagePresent: true, requestComplete: true, cacheReadTokens: 0, cacheSemanticsConfirmed: true },
        { id: 'r2', purpose: 'warm-summary', outputTokens: 120, requestWallSeconds: 2, streamSpanSeconds: 1.5, chunkDeltaSeconds: 1.5, usagePresent: true, requestComplete: true, cacheReadTokens: 1920, cacheSemanticsConfirmed: true, firstResponseSeconds: 1.24 },
      ],
    });
    const text = renderReport(run);
    assert.ok(text.includes('| 模型请求耗时（含预填与思考） | 未知 |'));
    assert.ok(text.includes('有效输出速度为未知（整请求耗时数据不完整'));
    assert.ok(text.includes('缺少 step/start'), '应点名缺 step/start 的请求');
    assert.ok(text.includes('对照：流式跨度口径 200.0 tok/s（受服务端缓冲影响，仅供参考）'));
    for (const line of text.split('\n')) {
      if (line.indexOf('| 有效输出速度 |') === 0) {
        assert.ok(line.indexOf('tok/s') < 0, '缺 step/start 时主速度不得出现数字: ' + line);
      }
    }
  });

  check('Key/敏感串被掩码，不出现在报告里', function () {
    const text = renderReport(makeRun({ env: { provider: 'provider-x', model: 'model-y', channelAlias: 'sk-live-0123456789abcdef', plugins: '插件组合A', reasoning: '低' } }));
    assert.ok(!text.includes('0123456789abcdef'), '报告不得包含 Key 值');
    assert.ok(text.includes('sk-***'), '应保留可识别前缀 + 掩码');
  });

  check('报告不做排名、不给跨环境结论', function () {
    for (const word of ['排名', '推荐', '更好', 'A/B 结论']) {
      assert.ok(!full.includes(word), '报告不应包含: ' + word);
    }
  });

  check('通过时补充说明只给对照行，不写异常说明', function () {
    assert.ok(full.includes('补充说明'), '通过的报告也要给出对照（新口径要求）');
    for (const word of ['未知', '失败', '超时', '越界', '回退']) {
      assert.ok(!full.includes(word), '全绿报告不应出现异常说明: ' + word);
    }
    assert.ok(full.includes('对照明细：跨度合计 6.0 秒、Σdt 合计 6.0 秒'));
  });
}

function checkSelfContained() {
  section('自包含与文案检查（不依赖已删除的旧脚本）');

  const skill = fs.readFileSync(path.join(SKILL_ROOT, 'SKILL.md'), 'utf8');

  check('触发描述覆盖「用测速功能帮我测速」', function () {
    const front = skill.split('---')[1] || '';
    assert.ok(front.includes('name: model-speed-load'));
    assert.ok(front.includes('用测速功能帮我测速'), 'frontmatter description 必须覆盖这句触发词');
  });

  check('正文写清人工分任务 A/B、不自动切换、显式选择 run 与三分钟上限', function () {
    for (const phrase of ['单环境单次', '人工分任务', 'A/B', '不自动切换', '显式选择 run', '1–3 分钟', '180']) {
      assert.ok(skill.includes(phrase), 'SKILL.md 缺少要点: ' + phrase);
    }
  });

  check('固定短总结提示词逐字存在', function () {
    assert.ok(skill.includes('不要修改文件，简要说明你刚才改了什么。'));
  });

  check('文案写清新主口径与对照口径（有效输出速度 / 整请求墙钟 / 环境指纹）', function () {
    for (const phrase of ['有效输出速度', '整请求', '环境指纹', 'requestWallSeconds', 'speedTpsStreamSpan']) {
      assert.ok(skill.includes(phrase), 'SKILL.md 缺少新口径要点: ' + phrase);
    }
    const contract = fs.readFileSync(path.join(SKILL_ROOT, 'MEASUREMENT-CONTRACT.md'), 'utf8');
    for (const phrase of ['环境指纹', 'requestWallSeconds', 'speedTpsStreamSpan', 'chunkDeltaSeconds']) {
      assert.ok(contract.includes(phrase), 'MEASUREMENT-CONTRACT.md 缺少: ' + phrase);
    }
  });

  check('不引用已删除的旧测速脚本', function () {
    for (const dead of ['split_stream', 'compare.mjs', 'analyze.js', '_speedtest\\']) {
      assert.ok(!skill.includes(dead), '不应引用已删除的脚本: ' + dead);
    }
  });

  check('SKILL.md 直接调用 scripts/measure.mjs 的 start / finish', function () {
    assert.ok(skill.includes('scripts/measure.mjs'), 'SKILL.md 必须直接调用测量脚本');
    assert.ok(skill.includes('measure.mjs start'), '缺少 start 调用');
    assert.ok(skill.includes('measure.mjs finish'), '缺少 finish 调用');
    assert.ok(skill.includes('node --test --test-isolation=none'), '验收命令必须是单进程模式');
  });

  check('measure.mjs 存在，提供 start/finish/selftest 且只用内置模块', function () {
    const measurePath = path.join(SKILL_ROOT, 'scripts', 'measure.mjs');
    assert.ok(fs.existsSync(measurePath), '缺少 scripts/measure.mjs');
    const source = fs.readFileSync(measurePath, 'utf8');
    for (const token of ['start', 'finish', 'selftest', 'node:zlib', 'node:fs', 'session.v4.jsonl.zstd', '--session-log', 'out-of-scope', 'requestWallSeconds', 'speedTpsStreamSpan', 'env.fingerprint', 'resultSchemaVersion', 'metricVersion', 'v3-request-wall', 'taskTemplateHash', 'environmentFlags', 'environmentStart', 'environment.mjs']) {
      assert.ok(source.includes(token), 'measure.mjs 缺少实现要点: ' + token);
    }
    assert.ok(!source.includes('child_process'), 'measure.mjs 不得使用 child_process');
  });

  check('独立环境模块与离线测试存在，且不使用网络或子进程', function () {
    for (const rel of ['environment.mjs', 'environment-selftest.mjs']) {
      const file = path.join(SKILL_ROOT, 'scripts', rel);
      assert.ok(fs.existsSync(file), '缺少 scripts/' + rel);
      const source = fs.readFileSync(file, 'utf8');
      for (const token of ['node:fs', 'node:crypto']) assert.ok(source.includes(token), rel + ' 缺少 ' + token);
      for (const bad of ['child_process', 'node:http', 'node:https', 'fetch(']) {
        assert.ok(!source.includes(bad), rel + ' 不应包含 ' + bad);
      }
    }
    const source = fs.readFileSync(path.join(SKILL_ROOT, 'scripts', 'environment.mjs'), 'utf8');
    for (const token of ['baseUrlHost', 'keyFingerprint', 'changedFields', 'attributionInvalidFields', 'environment-changed', 'attribution-invalid']) {
      assert.ok(source.includes(token), 'environment.mjs 缺少 ' + token);
    }
  });

  check('模板不联网、不装依赖', function () {
    const files = ['README.md', 'src/summary.js', 'test/summary.test.js'];
    for (const rel of files) {
      const text = fs.readFileSync(path.join(TEMPLATE_DIR, rel), 'utf8');
      for (const bad of ['fetch(', 'node:http', 'node:https', 'npm install', 'require(\'axios\')']) {
        assert.ok(!text.includes(bad), rel + ' 不应包含: ' + bad);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// 九、入口
// ---------------------------------------------------------------------------

function main() {
  const keep = process.argv.includes('--keep');
  console.log('== model-speed-load 离线自测（' + TASK_VERSION + '）==');
  console.log('skill 根目录: ' + SKILL_ROOT);
  console.log('node: ' + process.version);
  console.log('说明: 不联网、不发起模型请求、不安装依赖');

  const tempRoot = makeTempRoot();
  console.log('临时目录: ' + tempRoot);

  checkTemplate(tempRoot);
  checkMetrics();
  checkEnvFingerprint();
  checkCache();
  checkRunIdAndLock(tempRoot);
  checkVerdict();
  checkReport();
  checkSelfContained();

  const total = passed + failures.length;
  console.log('');
  console.log('== 结果：通过 ' + passed + ' / ' + total + ' ==');
  if (failures.length > 0) {
    console.log('失败项:');
    for (const item of failures) console.log('  - ' + item);
    process.exitCode = 1;
  } else {
    console.log('全部通过');
    process.exitCode = 0;
  }

  if (keep) {
    console.log('临时目录已保留: ' + tempRoot);
    return;
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (err) {
    console.log('清理临时目录失败（不影响结论）: ' + err.message);
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
