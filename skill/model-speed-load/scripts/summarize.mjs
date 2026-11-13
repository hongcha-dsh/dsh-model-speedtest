#!/usr/bin/env node
// model-speed-load · 显式 run 人工 A/B 汇总器
//
// 只使用 Node 内置模块；不联网、不调用模型、不修改原始 run。
// 用法：
//   node scripts/summarize.mjs --workspace <dir> --target <plugin:<id>|channel|preset> \
//     --run <runId|result.json路径> --run <runId|result.json路径> [...]
//
// --run 的顺序就是实际执行顺序。每两个相邻 run 尝试配对，比值统一为 A / B。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const RESULT_SCHEMA_VERSION = 1;
export const METRIC_VERSION = 'v3-request-wall';
export const COMPARISON_SCHEMA_VERSION = 1;
export const DEFAULT_BOOTSTRAP_ITERATIONS = 10000;
export const HARD_TIMEOUT_MS = 180000;

const UNKNOWN_TEXT = new Set(['', 'unknown', '未知', 'n/a', 'na', 'null', 'undefined']);
const SECRET_NAME = /(api.?key|token|secret|password|passwd|authorization|cookie|credential)/i;
const METRIC_DEFINITIONS = [
  { key: 'elapsedSeconds', label: '完成耗时', unit: '秒', digits: 3 },
  { key: 'requestWallSeconds', label: '模型请求耗时', unit: '秒', digits: 3 },
  { key: 'toolSeconds', label: '工具耗时', unit: '秒', digits: 3 },
  { key: 'outputTokens', label: '输出 token', unit: '个', digits: 0 },
  { key: 'devRequestCount', label: '请求轮数', unit: '次', digits: 0 },
  { key: 'toolCount', label: '工具调用', unit: '次', digits: 0 },
  { key: 'speedTps', label: '有效输出速度', unit: 'tok/s', digits: 3 },
];

export class SummarizeError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'SummarizeError';
    this.code = code;
    this.detail = detail || null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0 ? value : null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function toLocalIso(input) {
  const date = input instanceof Date ? input : new Date(input);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return date.getFullYear()
    + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + 'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
    + '.' + String(date.getMilliseconds()).padStart(3, '0')
    + sign + pad2(Math.floor(absolute / 60)) + ':' + pad2(absolute % 60);
}

function localStamp(date) {
  return String(date.getFullYear())
    + pad2(date.getMonth() + 1) + pad2(date.getDate())
    + '-' + pad2(date.getHours()) + pad2(date.getMinutes()) + pad2(date.getSeconds());
}

function maskSecrets(value) {
  return String(value)
    .replace(/(sk-)[A-Za-z0-9_-]{6,}/gi, '$1***')
    .replace(/(ak-)[A-Za-z0-9_-]{6,}/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***')
    .replace(/((?:api.?key|token|secret|password|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1***');
}

function secretLike(value) {
  return /(?:sk-|ak-)[A-Za-z0-9_-]{6,}/i.test(String(value))
    || /Bearer\s+[A-Za-z0-9._-]{6,}/i.test(String(value));
}

function cleanText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (UNKNOWN_TEXT.has(text.toLowerCase())) return null;
  return text;
}

function safeIdentityText(value) {
  const text = cleanText(value);
  if (text === null || secretLike(text)) return null;
  return maskSecrets(text);
}

function canonicalize(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (typeof value[key] !== 'function' && value[key] !== undefined) out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return String(value);
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 8);
}

function fullHash(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizeHost(value) {
  const raw = cleanText(value);
  if (raw === null) return null;
  try {
    const urlText = /^[a-z][a-z\d+.-]*:\/\//i.test(raw) || raw.startsWith('//')
      ? (raw.startsWith('//') ? 'https:' + raw : raw)
      : 'https://' + raw;
    const hostname = new URL(urlText).hostname;
    return hostname ? hostname.toLowerCase() : null;
  } catch (err) {
    return null;
  }
}

// 推理配置允许是对象。对外只展示白名单中的简单值；其余内容仅以不可逆哈希表示。
function normalizeReasoning(value) {
  if (value === null || value === undefined) return { value: null, compare: null };
  if (typeof value === 'string') {
    const text = safeIdentityText(value);
    return { value: text, compare: text === null ? null : 'string:' + text };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { value: value, compare: typeof value + ':' + String(value) };
  }
  if (!isObject(value) && !Array.isArray(value)) return { value: null, compare: null };

  const compare = stableStringify(value);
  const display = {};
  const allowed = new Set([
    'effort', 'reasoningEffort', 'level', 'enabled', 'thinking', 'thinkingEnabled',
    'budgetTokens', 'maxThinkingTokens', 'temperature', 'topP',
  ]);
  if (isObject(value)) {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key) || SECRET_NAME.test(key)) continue;
      const item = value[key];
      if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) display[key] = item;
      else if (typeof item === 'string' && !secretLike(item)) display[key] = maskSecrets(item);
    }
  }
  return {
    value: Object.keys(display).length > 0 ? display : { sha256: fullHash(compare) },
    compare: compare,
  };
}

// 新版 plugins 是启用插件 ID/版本数组。旧字符串或结构不完整时返回 null，绝不猜状态。
export function normalizePlugins(value) {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];
  const byId = new Map();
  for (const entry of value) {
    let id = null;
    let version = null;
    let enabled = true;
    if (typeof entry === 'string') {
      id = safeIdentityText(entry);
    } else if (isObject(entry)) {
      id = safeIdentityText(entry.id !== undefined ? entry.id : entry.pluginId);
      version = safeIdentityText(entry.version);
      if (entry.enabled === false) enabled = false;
    }
    if (id === null) return null;
    const item = { id: id, version: version, enabled: enabled };
    const fingerprint = stableStringify(item);
    if (byId.has(id) && byId.get(id).fingerprint !== fingerprint) return null;
    byId.set(id, { item: item, fingerprint: fingerprint });
  }
  return Array.from(byId.values()).map(function (entry) { return entry.item; })
    .sort(function (a, b) { return a.id.localeCompare(b.id); });
}

function pluginCompare(plugins, excludedId) {
  if (plugins === null) return null;
  const list = excludedId === null ? plugins : plugins.filter(function (plugin) { return plugin.id !== excludedId; });
  // 版本未知不再直接抹掉整个数组；由归因检查区分共享未知、部分未知和已知冲突。
  return stableStringify(list);
}

function normalizeToolNames(value) {
  if (!Array.isArray(value)) return null;
  const names = new Set();
  for (const entry of value) {
    const name = safeIdentityText(isObject(entry) ? entry.name : entry);
    if (name === null) return null;
    names.add(name);
  }
  return Array.from(names).sort();
}

export function normalizeEnvironment(run) {
  const env = isObject(run.env) ? run.env : {};
  const fingerprint = isObject(env.fingerprint) ? env.fingerprint : {};
  const reasoning = normalizeReasoning(env.reasoning);
  const plugins = normalizePlugins(env.plugins);
  const provider = safeIdentityText(env.provider !== undefined ? env.provider : fingerprint.provider);
  const model = safeIdentityText(env.model !== undefined ? env.model : fingerprint.model);
  const agentPreset = safeIdentityText(env.agentPreset !== undefined ? env.agentPreset : fingerprint.agentPreset);
  const channelAlias = safeIdentityText(env.channelAlias);
  const baseURLHost = normalizeHost(
    env.baseURLHost !== undefined ? env.baseURLHost
      : (env.baseUrlHost !== undefined ? env.baseUrlHost : (env.baseURL !== undefined ? env.baseURL : env.baseUrl)),
  );
  const keyAlias = safeIdentityText(env.keyAlias);
  const keyFingerprint = safeIdentityText(env.keyFingerprint);
  const dshVersion = safeIdentityText(env.dshVersion);

  const rawNames = fingerprint.toolNames !== undefined ? fingerprint.toolNames : env.toolNames;
  const toolNames = normalizeToolNames(rawNames);
  const rawCount = fingerprint.toolCount !== undefined ? fingerprint.toolCount : env.toolCount;
  const toolCount = isFiniteNumber(rawCount) && rawCount >= 0 ? rawCount : null;
  const rawHash = fingerprint.toolNamesHash !== undefined ? fingerprint.toolNamesHash : env.toolNamesHash;
  let toolNamesHash = safeIdentityText(rawHash);
  // 旧实现常用 names=[] + hash=null + count=null 表示“读不到”，不能当作已确认零工具。
  const namesAreKnown = toolNames !== null && (toolNames.length > 0 || toolNamesHash !== null || toolCount === 0);
  if (namesAreKnown) toolNamesHash = shortHash(toolNames.join('\n'));
  const toolsCompare = namesAreKnown || toolNamesHash !== null ? toolNamesHash : null;

  return {
    provider: provider,
    model: model,
    channelAlias: channelAlias,
    baseURLHost: baseURLHost,
    keyAlias: keyAlias,
    keyFingerprint: keyFingerprint,
    // 与设计一致：优先使用已有别名；没有别名时才使用不可逆指纹判断同一凭据。
    keyIdentity: keyAlias !== null ? 'alias:' + keyAlias
      : (keyFingerprint !== null ? 'fingerprint:' + keyFingerprint : null),
    agentPreset: agentPreset,
    reasoning: reasoning.value,
    reasoningCompare: reasoning.compare,
    plugins: plugins,
    pluginsCompare: pluginCompare(plugins, null),
    dshVersion: dshVersion,
    toolNames: namesAreKnown ? toolNames : null,
    toolCount: namesAreKnown && toolNames !== null ? toolNames.length : toolCount,
    toolNamesHash: toolsCompare,
    toolsCompare: toolsCompare,
  };
}

function targetPluginState(plugins, pluginId) {
  if (plugins === null) return null;
  const plugin = plugins.find(function (item) { return item.id === pluginId; });
  return plugin && plugin.enabled === false ? 'disabled' : (plugin ? 'enabled' : 'disabled');
}

export function parseTarget(value) {
  const text = cleanText(value);
  if (text === 'channel' || text === 'preset') return { kind: text, pluginId: null, text: text };
  if (text && text.startsWith('plugin:') && text.length > 'plugin:'.length) {
    const pluginId = text.slice('plugin:'.length).trim();
    if (pluginId && !/[\s\u0000-\u001f]/.test(pluginId)) {
      return { kind: 'plugin', pluginId: pluginId, text: 'plugin:' + pluginId };
    }
  }
  throw new SummarizeError('BAD-TARGET', '--target 必须是 plugin:<id>、channel 或 preset');
}

export function parseArgs(argv) {
  const out = { runs: [], help: false };
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
    if (value === undefined || value.startsWith('--')) {
      throw new SummarizeError('BAD-ARGS', '--' + key + ' 缺少参数值');
    }
    if (key === 'run') out.runs.push(value);
    else if (key === 'workspace' || key === 'target') {
      if (out[key] !== undefined) throw new SummarizeError('BAD-ARGS', '--' + key + ' 只能提供一次');
      out[key] = value;
    } else {
      throw new SummarizeError('BAD-ARGS', '未知参数：--' + key);
    }
  }
  return out;
}

function resolveResultPath(workspace, input) {
  const text = String(input).trim();
  const isPath = path.isAbsolute(text) || text.includes('/') || text.includes('\\') || text.toLowerCase().endsWith('.json');
  return {
    input: text,
    inputIsPath: isPath,
    resultPath: isPath ? path.resolve(workspace, text) : path.join(workspace, '.speedtest', text, 'result.json'),
  };
}

function requiredComparableText(value) {
  const text = cleanText(value);
  return text === null ? null : text;
}

export function validateRunVersion(record) {
  const run = record.data;
  if (run.resultSchemaVersion !== RESULT_SCHEMA_VERSION) {
    throw new SummarizeError(
      'RESULT-SCHEMA-UNSUPPORTED',
      record.runId + '：resultSchemaVersion 必须为 1，实际为 ' + String(run.resultSchemaVersion ?? '缺失'),
    );
  }
  if (run.metricVersion !== METRIC_VERSION) {
    throw new SummarizeError(
      'METRIC-VERSION-UNSUPPORTED',
      record.runId + '：metricVersion 必须为 ' + METRIC_VERSION + '，实际为 ' + String(run.metricVersion ?? '缺失'),
    );
  }
  for (const field of ['taskTemplateHash', 'taskVersion', 'acceptanceCommand']) {
    if (requiredComparableText(run[field]) === null) {
      throw new SummarizeError('TASK-FIELD-MISSING', record.runId + '：缺少可比较的 ' + field + '，拒绝主比较');
    }
  }
  if (typeof run.taskTemplateHash !== 'string' || !/^[0-9a-f]{64}$/i.test(run.taskTemplateHash)) {
    throw new SummarizeError('TASK-HASH-INVALID', record.runId + '：taskTemplateHash 必须是 64 位十六进制 SHA-256，拒绝主比较');
  }
}

export function loadRuns(workspace, inputs) {
  if (!Array.isArray(inputs) || inputs.length < 2) {
    throw new SummarizeError('RUN-LIST-REQUIRED', '至少按执行顺序显式提供两个 --run');
  }
  const records = [];
  const seenIds = new Set();
  const seenPaths = new Set();
  for (let index = 0; index < inputs.length; index += 1) {
    const resolved = resolveResultPath(workspace, inputs[index]);
    let raw;
    try {
      raw = fs.readFileSync(resolved.resultPath, 'utf8');
    } catch (err) {
      const code = err && err.code === 'ENOENT' ? 'RUN-NOT-FOUND' : 'RUN-READ-FAILED';
      throw new SummarizeError(code, '第 ' + (index + 1) + ' 个 run 无法读取：' + resolved.resultPath + '（' + err.message + '）');
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new SummarizeError('RUN-JSON-INVALID', '第 ' + (index + 1) + ' 个 run 的 JSON 无法解析：' + resolved.resultPath);
    }
    if (!isObject(data)) throw new SummarizeError('RUN-JSON-INVALID', 'result.json 顶层必须是对象：' + resolved.resultPath);
    const runId = requiredComparableText(data.runId);
    if (runId === null) throw new SummarizeError('RUN-ID-MISSING', 'result.json 缺少 runId：' + resolved.resultPath);
    if (!resolved.inputIsPath && runId !== resolved.input) {
      throw new SummarizeError('RUN-ID-MISMATCH', '显式 runId 与文件内容不一致：' + resolved.input + ' != ' + runId);
    }
    if (seenIds.has(runId)) throw new SummarizeError('DUPLICATE-RUN', 'runId 重复：' + runId);
    if (seenPaths.has(resolved.resultPath)) throw new SummarizeError('DUPLICATE-RUN', 'result.json 路径重复：' + resolved.resultPath);
    seenIds.add(runId);
    seenPaths.add(resolved.resultPath);
    const record = { runId: runId, order: index + 1, resultPath: resolved.resultPath, data: data };
    validateRunVersion(record);
    records.push(record);
  }

  const baseline = records[0].data;
  for (const record of records.slice(1)) {
    for (const field of ['resultSchemaVersion', 'metricVersion', 'taskTemplateHash', 'taskVersion', 'acceptanceCommand']) {
      if (record.data[field] !== baseline[field]) {
        throw new SummarizeError(
          'RUN-COMPATIBILITY',
          record.runId + '：' + field + ' 与首个 run 不一致，拒绝混合主比较',
          { field: field, expected: baseline[field], actual: record.data[field] },
        );
      }
    }
  }
  return records;
}

function booleanAt(object, keys) {
  for (const key of keys) {
    if (object && object[key] === true) return true;
  }
  return false;
}

export function runQuality(run) {
  const dataQuality = isObject(run.dataQuality) ? run.dataQuality : {};
  const environment = isObject(run.environment) ? run.environment : {};
  const env = isObject(run.env) ? run.env : {};
  const statusValues = [
    run.environmentStatus, run.attributionStatus, dataQuality.environment, dataQuality.attribution,
    environment.status, environment.attributionStatus, env.environmentStatus, env.attributionStatus,
  ].filter(function (value) { return typeof value === 'string'; });
  const environmentFlags = Array.isArray(run.environmentFlags) ? run.environmentFlags : [];
  const changedFields = Array.isArray(environment.changedFields) ? environment.changedFields : null;
  const attributionInvalidFields = Array.isArray(environment.attributionInvalidFields)
    ? environment.attributionInvalidFields : null;
  const environmentMetadataUnknown = !Array.isArray(run.environmentFlags)
    || !isObject(run.environment) || changedFields === null || attributionInvalidFields === null;
  const environmentChanged = environmentFlags.includes('environment-changed')
    || (changedFields !== null && changedFields.length > 0)
    || run.environmentChanged === true
    || environment.changed === true || env.environmentChanged === true
    || statusValues.includes('environment-changed');
  const attributionInvalid = environmentFlags.includes('attribution-invalid')
    || (attributionInvalidFields !== null && attributionInvalidFields.length > 0)
    || run.attributionInvalid === true
    || environment.attributionInvalid === true || env.attributionInvalid === true
    || statusValues.includes('attribution-invalid');
  const concurrent = booleanAt(run, ['concurrentPollution', 'concurrencyPollution', 'concurrentDetected', 'contaminated'])
    || booleanAt(dataQuality, ['concurrentPollution', 'concurrencyPollution', 'contaminated'])
    || booleanAt(environment, ['concurrentPollution', 'concurrencyPollution']);
  const timingIncomplete = run.timingComplete === false || run.elapsedComplete === false
    || dataQuality.elapsed === 'unknown' || dataQuality.timing === 'incomplete';
  const outOfScope = Array.isArray(run.outOfScopeChanges) ? run.outOfScopeChanges.length : 0;
  const successful = run.outcome === 'passed' && outOfScope === 0;
  const elapsedMs = nonNegativeNumber(run.elapsedMs);
  const durationEligible = successful && !concurrent && !timingIncomplete
    && elapsedMs !== null && elapsedMs <= HARD_TIMEOUT_MS;
  const exclusionReasons = [];
  if (!successful) exclusionReasons.push('outcome-not-passed');
  if (outOfScope > 0 && !exclusionReasons.includes('out-of-scope')) exclusionReasons.push('out-of-scope');
  if (concurrent) exclusionReasons.push('concurrent-pollution');
  if (timingIncomplete) exclusionReasons.push('timing-incomplete');
  if (successful && elapsedMs === null) exclusionReasons.push('elapsed-unknown');
  if (successful && elapsedMs !== null && elapsedMs > HARD_TIMEOUT_MS) exclusionReasons.push('over-hard-timeout');
  return {
    successful: successful,
    elapsedSeconds: durationEligible ? elapsedMs / 1000 : null,
    metricEligible: successful && !concurrent,
    exclusionReasons: exclusionReasons,
    environmentChanged: environmentChanged,
    attributionInvalid: attributionInvalid,
    environmentMetadataUnknown: environmentMetadataUnknown,
    concurrent: concurrent,
    timingIncomplete: timingIncomplete,
  };
}

function metricNumber(metrics, key) {
  return nonNegativeNumber(metrics[key]);
}

export function runMetrics(run, quality) {
  const metrics = isObject(run.metrics) ? run.metrics : {};
  if (!quality.metricEligible) {
    return {
      elapsedSeconds: null, requestWallSeconds: null, toolSeconds: null, outputTokens: null,
      devRequestCount: null, toolCount: null, speedTps: null,
    };
  }
  const toolMs = metricNumber(metrics, 'toolMs');
  return {
    elapsedSeconds: quality.elapsedSeconds,
    requestWallSeconds: metricNumber(metrics, 'requestWallSeconds'),
    toolSeconds: toolMs === null ? null : toolMs / 1000,
    outputTokens: metricNumber(metrics, 'outputTokens'),
    devRequestCount: metricNumber(metrics, 'devRequestCount'),
    toolCount: metricNumber(metrics, 'toolCount'),
    speedTps: metricNumber(metrics, 'speedTps'),
  };
}

export function median(values) {
  const numbers = values.filter(isFiniteNumber).slice().sort(function (a, b) { return a - b; });
  if (numbers.length === 0) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

export function describe(values) {
  const numbers = values.filter(isFiniteNumber).slice().sort(function (a, b) { return a - b; });
  if (numbers.length === 0) return { n: 0, median: null, min: null, max: null, range: null, mad: null };
  const center = median(numbers);
  return {
    n: numbers.length,
    median: center,
    min: numbers[0],
    max: numbers[numbers.length - 1],
    range: numbers[numbers.length - 1] - numbers[0],
    mad: median(numbers.map(function (value) { return Math.abs(value - center); })),
  };
}

function directionOf(ratio) {
  if (ratio < 1) return 'A';
  if (ratio > 1) return 'B';
  return 'tie';
}

function createPrng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapMedianLogRatios(ratios, options) {
  const opts = options || {};
  if (!Array.isArray(ratios) || ratios.length < 6 || ratios.some(function (ratio) {
    return !isFiniteNumber(ratio) || ratio <= 0;
  })) return null;
  const iterations = Number.isInteger(opts.iterations) && opts.iterations > 0
    ? opts.iterations : DEFAULT_BOOTSTRAP_ITERATIONS;
  const logs = ratios.map(Math.log);
  const seedText = opts.seedText || ratios.map(function (ratio) { return String(ratio); }).join('|');
  const seed = crypto.createHash('sha256').update(seedText, 'utf8').digest().readUInt32BE(0);
  const random = createPrng(seed);
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample = [];
    for (let index = 0; index < logs.length; index += 1) {
      resample.push(logs[Math.floor(random() * logs.length)]);
    }
    samples.push(median(resample));
  }
  samples.sort(function (a, b) { return a - b; });
  // 离散百分位：索引 0..n-1 的 p 分位，避免小样本使用看似精确的插值。
  const lower = samples[Math.floor((samples.length - 1) * 0.025)];
  const upper = samples[Math.floor((samples.length - 1) * 0.975)];
  return {
    method: 'paired-bootstrap-percentile',
    statistic: 'median-log-a-over-b',
    level: 0.95,
    iterations: iterations,
    seed: seed,
    lower: lower,
    upper: upper,
    ratioLower: Math.exp(lower),
    ratioUpper: Math.exp(upper),
    crossesZero: lower <= 0 && upper >= 0,
    exploratory: true,
  };
}

function environmentSummary(env) {
  return {
    provider: env.provider,
    model: env.model,
    channelAlias: env.channelAlias,
    baseURLHost: env.baseURLHost,
    keyAlias: env.keyAlias,
    keyFingerprint: env.keyFingerprint,
    agentPreset: env.agentPreset,
    reasoning: env.reasoning,
    plugins: env.plugins,
    dshVersion: env.dshVersion,
    toolCount: env.toolCount,
    toolNamesHash: env.toolNamesHash,
    toolNames: env.toolNames,
  };
}

function cacheCounts(records, key) {
  const counts = { hit: 0, miss: 0, unknown: 0 };
  for (const record of records) {
    if (!record.quality.metricEligible) continue;
    const metrics = isObject(record.data.metrics) ? record.data.metrics : {};
    const cache = isObject(metrics[key]) ? metrics[key] : {};
    const state = cache.state === 'hit' || cache.state === 'miss' ? cache.state : 'unknown';
    counts[state] += 1;
  }
  return counts;
}

function pairRecords(records) {
  const pairs = [];
  for (let index = 0; index < records.length; index += 2) {
    const first = records[index];
    const second = records[index + 1] || null;
    const pair = {
      pairId: 'pair-' + (pairs.length + 1),
      firstRunId: first.runId,
      secondRunId: second ? second.runId : null,
      order: first.group && second && second.group ? first.group + second.group : 'unknown',
      aRunId: null,
      bRunId: null,
      aElapsedSeconds: null,
      bElapsedSeconds: null,
      ratioAOverB: null,
      logRatio: null,
      direction: null,
      valid: false,
      reasons: [],
    };
    if (!second) pair.reasons.push('missing-adjacent-run');
    else if (!first.group || !second.group) pair.reasons.push('target-group-unknown');
    else if (first.group === second.group) pair.reasons.push('same-target-group');

    if (second && first.group && second.group && first.group !== second.group) {
      const a = first.group === 'A' ? first : second;
      const b = first.group === 'A' ? second : first;
      pair.aRunId = a.runId;
      pair.bRunId = b.runId;
      pair.aElapsedSeconds = a.metrics.elapsedSeconds;
      pair.bElapsedSeconds = b.metrics.elapsedSeconds;
      if (!a.quality.successful || !b.quality.successful) pair.reasons.push('unsuccessful-run');
      if (a.quality.concurrent || b.quality.concurrent) pair.reasons.push('concurrent-pollution');
      if (a.metrics.elapsedSeconds === null || b.metrics.elapsedSeconds === null) pair.reasons.push('elapsed-unavailable');
      if (a.metrics.elapsedSeconds !== null && b.metrics.elapsedSeconds !== null) {
        if (b.metrics.elapsedSeconds > 0) {
          pair.ratioAOverB = a.metrics.elapsedSeconds / b.metrics.elapsedSeconds;
          pair.logRatio = Math.log(pair.ratioAOverB);
          pair.direction = directionOf(pair.ratioAOverB);
          pair.valid = true;
        } else if (a.metrics.elapsedSeconds === 0) {
          pair.reasons.push('zero-duration-ratio-undefined');
        } else {
          pair.reasons.push('zero-b-duration');
        }
      }
    }
    pair.reasons = Array.from(new Set(pair.reasons));
    if (pair.valid) {
      first.includedInPairStats = true;
      second.includedInPairStats = true;
    } else {
      first.unpairedReason = pair.reasons.join(',') || 'not-paired';
      if (second) second.unpairedReason = pair.reasons.join(',') || 'not-paired';
    }
    pairs.push(pair);
  }
  return pairs;
}

function alternatingInfo(validPairs) {
  const orders = validPairs.map(function (pair) { return pair.order; });
  if (orders.length < 2) {
    return { sequence: orders, alternating: null, risk: 'pair-count-insufficient' };
  }
  let alternating = true;
  for (let index = 1; index < orders.length; index += 1) {
    if (orders[index] === orders[index - 1]) alternating = false;
  }
  return { sequence: orders, alternating: alternating, risk: alternating ? null : 'time-drift' };
}

function channelParts(env) {
  return {
    channelAlias: env.channelAlias,
    baseUrlHost: env.baseURLHost,
    keyIdentity: env.keyIdentity,
  };
}

function channelIdentityValue(env) {
  const parts = channelParts(env);
  if (parts.channelAlias === null && parts.baseUrlHost === null && parts.keyIdentity === null) return null;
  return stableStringify(parts);
}

function targetIdentity(env, target) {
  if (target.kind === 'plugin') return targetPluginState(env.plugins, target.pluginId);
  if (target.kind === 'channel') {
    // 仅用于内部稳定分组，不写入产物：同渠道/主机只换 Key 也是另一组。
    return channelIdentityValue(env);
  }
  return env.agentPreset;
}

function targetDisplayValue(env, target, identity) {
  if (identity === null) return null;
  if (target.kind !== 'channel') return identity;
  // 报告只显示安全别名/主机；指纹身份只说明存在，绝不显示指纹本身。
  if (env.channelAlias !== null) return env.channelAlias;
  if (env.baseURLHost !== null) return env.baseURLHost;
  if (env.keyAlias !== null) return 'Key=' + env.keyAlias;
  return 'Key=指纹身份（不显示）';
}

function assignGroups(records, target) {
  const identities = { A: null, B: null };
  const labels = { A: null, B: null };
  if (target.kind === 'plugin') {
    identities.A = 'disabled';
    identities.B = 'enabled';
    labels.A = 'disabled';
    labels.B = 'enabled';
    for (const record of records) {
      const state = targetIdentity(record.env, target);
      record.targetIdentity = state;
      record.targetValue = state;
      record.group = state === 'disabled' ? 'A' : (state === 'enabled' ? 'B' : null);
    }
    return { identities: identities, labels: labels };
  }

  const values = [];
  for (const record of records) {
    const identity = targetIdentity(record.env, target);
    record.targetIdentity = identity;
    record.targetValue = targetDisplayValue(record.env, target, identity);
    if (identity !== null && !values.includes(identity)) values.push(identity);
  }
  if (values.length > 2) {
    throw new SummarizeError('GROUP-COUNT', target.text + ' 出现了 ' + values.length + ' 个已知身份；A/B 汇总只允许两个，请显式拆分批次数');
  }
  identities.A = values[0] || null;
  identities.B = values[1] || null;
  for (const record of records) {
    record.group = record.targetIdentity === null ? null
      : (record.targetIdentity === identities.A ? 'A' : (record.targetIdentity === identities.B ? 'B' : null));
    if (record.group && labels[record.group] === null) labels[record.group] = record.targetValue;
  }
  return { identities: identities, labels: labels };
}

const CONTROL_FIELDS = {
  provider: { label: 'provider', value: function (env) { return env.provider; } },
  model: { label: '模型', value: function (env) { return env.model; } },
  channel: { label: '渠道复合身份（别名/主机/Key）', value: function (env) { return channelIdentityValue(env); } },
  preset: { label: 'agentPreset', value: function (env) { return env.agentPreset; } },
  reasoning: { label: '推理设置', value: function (env) { return env.reasoningCompare; } },
  plugins: { label: '插件组合', value: function (env) { return env.pluginsCompare; } },
  nonTargetPlugins: { label: '非目标插件', value: function (env, target) {
    return pluginCompare(env.plugins, target.pluginId);
  } },
  tools: { label: '工具组合', value: function (env) { return env.toolsCompare; } },
  dshVersion: { label: 'DSH 版本', value: function (env) { return env.dshVersion; } },
};

function controlFieldNames(target) {
  if (target.kind === 'plugin') {
    return {
      controls: ['provider', 'model', 'channel', 'preset', 'reasoning', 'nonTargetPlugins', 'dshVersion'],
      allowed: ['tools'],
    };
  }
  if (target.kind === 'channel') {
    return {
      controls: ['provider', 'model', 'preset', 'reasoning', 'plugins', 'tools', 'dshVersion'],
      allowed: ['channel'],
    };
  }
  return {
    controls: ['provider', 'model', 'channel', 'plugins', 'dshVersion'],
    allowed: ['preset', 'reasoning', 'tools'],
  };
}

function displayFieldValue(field, value) {
  if (value === null) return null;
  if (field === 'channel') {
    try {
      const parts = JSON.parse(value);
      const display = [];
      if (parts.channelAlias) display.push('渠道=' + parts.channelAlias);
      if (parts.baseUrlHost) display.push('主机=' + parts.baseUrlHost);
      if (parts.keyIdentity) {
        display.push(String(parts.keyIdentity).startsWith('alias:')
          ? 'Key=' + String(parts.keyIdentity).slice('alias:'.length)
          : 'Key=指纹身份（不显示）');
      }
      return display.join(' · ') || null;
    } catch (err) {
      return '(unavailable)';
    }
  }
  if (field === 'plugins' || field === 'nonTargetPlugins') {
    try {
      const plugins = JSON.parse(value);
      return plugins.map(function (plugin) {
        return plugin.id + (plugin.version ? '@' + plugin.version : '') + (plugin.enabled === false ? '(disabled)' : '');
      }).join(', ') || '(none)';
    } catch (err) {
      return '(unavailable)';
    }
  }
  if (field === 'reasoning') return 'sha256:' + shortHash(value);
  return maskSecrets(String(value));
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function evaluateChannelControl(records, allowed) {
  const values = records.map(function (record) { return channelIdentityValue(record.env); });
  const known = values.filter(function (value) { return value !== null; });
  const unique = Array.from(new Set(known));
  if (allowed) {
    return {
      status: known.length !== records.length ? 'unknown' : (unique.length > 1 ? 'different' : 'same'),
      missing: [], unexplained: [], sharedUnknown: [],
    };
  }
  if (known.length !== records.length) {
    return { status: 'unknown', missing: ['channel'], unexplained: [], sharedUnknown: [] };
  }

  const missing = [];
  const unexplained = [];
  const sharedUnknown = [];
  for (const component of ['channelAlias', 'baseUrlHost', 'keyIdentity']) {
    const componentValues = records.map(function (record) { return channelParts(record.env)[component]; });
    const componentKnown = componentValues.filter(function (value) { return value !== null; });
    const componentUnique = Array.from(new Set(componentKnown));
    if (componentKnown.length === 0) sharedUnknown.push(component);
    else if (componentKnown.length !== records.length) missing.push(component);
    if (componentUnique.length > 1) unexplained.push(component);
  }
  const status = missing.length > 0 ? 'unknown'
    : (unexplained.length > 0 ? 'different' : (sharedUnknown.length > 0 ? 'shared-unknown' : 'same'));
  return { status: status, missing: missing, unexplained: unexplained, sharedUnknown: sharedUnknown };
}

function evaluatePluginControl(records, target, field) {
  const excludedId = field === 'nonTargetPlugins' ? target.pluginId : null;
  const lists = records.map(function (record) {
    if (record.env.plugins === null) return null;
    return excludedId === null ? record.env.plugins
      : record.env.plugins.filter(function (plugin) { return plugin.id !== excludedId; });
  });
  if (lists.some(function (list) { return list === null; })) {
    return {
      status: 'unknown', missing: [field], unexplained: [], sharedVersions: [], partialVersions: [],
    };
  }

  const signatures = lists.map(function (list) {
    return stableStringify(list.map(function (plugin) { return { id: plugin.id, enabled: plugin.enabled }; }));
  });
  const sharedVersions = [];
  const partialVersions = [];
  const unexplained = [];
  if (new Set(signatures).size > 1) {
    // ID/启用状态已不同就是混合环境；缺失的一侧不是“版本未知”。
    return {
      status: 'different', missing: [], unexplained: [field], sharedVersions: [], partialVersions: [],
    };
  }
  const ids = Array.from(new Set(lists.flatMap(function (list) {
    return list.map(function (plugin) { return plugin.id; });
  }))).sort();
  for (const id of ids) {
    const versions = lists.map(function (list) {
      const plugin = list.find(function (item) { return item.id === id; });
      return plugin ? plugin.version : null;
    });
    const known = versions.filter(function (version) { return version !== null; });
    if (new Set(known).size > 1 && !unexplained.includes(field)) unexplained.push(field);
    if (known.length === 0 && versions.length > 0 && !unexplained.includes(field)) {
      sharedVersions.push({ field: field, pluginId: id });
    } else if (known.length > 0 && known.length !== versions.length) {
      partialVersions.push({ field: field, pluginId: id });
    }
  }
  const missing = partialVersions.length > 0 ? [field] : [];
  const status = unexplained.length > 0 ? 'different'
    : (missing.length > 0 ? 'unknown' : (sharedVersions.length > 0 ? 'same-with-unknown-versions' : 'same'));
  return {
    status: status,
    missing: missing,
    unexplained: unexplained,
    sharedVersions: sharedVersions,
    partialVersions: partialVersions,
  };
}

function checkEnvironment(records, target, hasAB) {
  const names = controlFieldNames(target);
  // 关键身份和共享未知策略按所有显式入选 run 审计，失败 run 也不能悄悄绕过身份检查。
  const analysisRecords = records;
  const checks = [];
  const unexplained = [];
  const missing = [];
  const allowedDifferences = [];
  const sharedUnknownControls = [];
  const pluginVersionUnknown = [];
  const pluginVersionPartial = [];
  for (const field of names.controls.concat(names.allowed)) {
    const definition = CONTROL_FIELDS[field];
    const allowed = names.allowed.includes(field);
    const values = analysisRecords.map(function (record) {
      return { runId: record.runId, value: definition.value(record.env, target) };
    });
    let status;
    if (field === 'channel') {
      const result = evaluateChannelControl(analysisRecords, allowed);
      status = result.status;
      result.missing.forEach(function (item) { pushUnique(missing, item); });
      result.unexplained.forEach(function (item) { pushUnique(unexplained, item); });
      result.sharedUnknown.forEach(function (item) { pushUnique(sharedUnknownControls, item); });
      if (allowed && status === 'different') pushUnique(allowedDifferences, field);
    } else if (field === 'plugins' || field === 'nonTargetPlugins') {
      const result = evaluatePluginControl(analysisRecords, target, field);
      status = result.status;
      result.missing.forEach(function (item) { pushUnique(missing, item); });
      result.unexplained.forEach(function (item) { pushUnique(unexplained, item); });
      pluginVersionUnknown.push.apply(pluginVersionUnknown, result.sharedVersions);
      pluginVersionPartial.push.apply(pluginVersionPartial, result.partialVersions);
    } else {
      const known = values.filter(function (item) { return item.value !== null; });
      const unique = Array.from(new Set(known.map(function (item) { return item.value; })));
      const sharedUnknownAllowed = field === 'reasoning' || field === 'dshVersion';
      if (!allowed && known.length === 0 && sharedUnknownAllowed) {
        status = 'shared-unknown';
        pushUnique(sharedUnknownControls, field);
      } else {
        status = known.length !== analysisRecords.length ? 'unknown' : (unique.length > 1 ? 'different' : 'same');
        if (!allowed && status === 'unknown') pushUnique(missing, field);
        if (!allowed && unique.length > 1) pushUnique(unexplained, field);
      }
      if (allowed && status === 'different') pushUnique(allowedDifferences, field);
    }
    checks.push({
      field: field,
      label: definition.label,
      role: allowed ? 'target-allowed' : 'control',
      status: status,
      values: values.map(function (item) {
        return { runId: item.runId, value: displayFieldValue(field, item.value) };
      }),
    });
  }

  const invalidRuns = analysisRecords.filter(function (record) { return record.quality.attributionInvalid; });
  const changedRuns = analysisRecords.filter(function (record) { return record.quality.environmentChanged; });
  const metadataUnknownRuns = analysisRecords.filter(function (record) { return record.quality.environmentMetadataUnknown; });
  const unknownGroupRuns = records.filter(function (record) { return record.group === null; });
  let status = 'eligible';
  if (invalidRuns.length > 0) status = 'attribution-invalid';
  else if (changedRuns.length > 0 || metadataUnknownRuns.length > 0 || missing.length > 0 || unknownGroupRuns.length > 0 || !hasAB) status = 'insufficient-data';
  else if (unexplained.length > 0) status = 'mixed-environment';
  const reasons = [];
  if (invalidRuns.length > 0) reasons.push('配置声明与实际请求身份冲突：' + invalidRuns.map(function (r) { return r.runId; }).join(', '));
  if (changedRuns.length > 0) reasons.push('start/finish 环境发生变化：' + changedRuns.map(function (r) { return r.runId; }).join(', '));
  if (metadataUnknownRuns.length > 0) reasons.push('环境有效性字段缺失：' + metadataUnknownRuns.map(function (r) { return r.runId; }).join(', '));
  if (missing.length > 0) reasons.push('关键控制字段缺失或部分未知：' + missing.join(', '));
  if (unknownGroupRuns.length > 0) reasons.push('目标分组未知：' + unknownGroupRuns.map(function (r) { return r.runId; }).join(', '));
  if (!hasAB) reasons.push('没有同时确认 A/B 两组');
  if (unexplained.length > 0) reasons.push('存在目标无法解释的环境差异：' + unexplained.join(', '));
  const warnings = [];
  if (sharedUnknownControls.length > 0) {
    warnings.push('共享未知控制字段：' + sharedUnknownControls.join(', ') + '；结论以这些字段未变化为前提。');
  }
  if (pluginVersionUnknown.length > 0) {
    warnings.push('插件版本共享未知：' + pluginVersionUnknown.map(function (item) {
      return item.pluginId + '(' + item.field + ')';
    }).join(', ') + '；结论以这些插件版本未变化为前提。');
  }
  if (pluginVersionPartial.length > 0) {
    warnings.push('插件版本仅部分已知：' + pluginVersionPartial.map(function (item) {
      return item.pluginId + '(' + item.field + ')';
    }).join(', ') + '；归因数据不足。');
  }
  return {
    status: status,
    attributionEligible: status === 'eligible',
    checks: checks,
    unexplainedDifferences: unexplained,
    missingControls: missing,
    allowedDifferences: allowedDifferences,
    sharedUnknownControls: sharedUnknownControls,
    pluginVersionUnknown: pluginVersionUnknown,
    pluginVersionPartial: pluginVersionPartial,
    warnings: warnings,
    environmentChangedRunIds: changedRuns.map(function (record) { return record.runId; }),
    attributionInvalidRunIds: invalidRuns.map(function (record) { return record.runId; }),
    reasons: reasons,
  };
}

function sampleSufficiency(pairCount) {
  if (pairCount === 0) return { level: 'none', label: '无有效配对', exploratoryInterval: false };
  if (pairCount === 1) return { level: 'insufficient', label: '样本不足（单对观察）', exploratoryInterval: false };
  if (pairCount === 2) return { level: 'insufficient', label: '样本不足（两对）', exploratoryInterval: false };
  if (pairCount < 6) return { level: 'preliminary', label: '初步描述', exploratoryInterval: false };
  return { level: 'interval-estimate', label: '区间估计（探索性）', exploratoryInterval: true };
}

function makeConclusion(sufficiency, directions, bootstrap, attribution) {
  const count = directions.count;
  if (count === 0) return { code: 'no-valid-pair', text: '无法判断：没有同时包含有效 A 和 B 的相邻配对。' };
  if (count === 1) {
    return {
      code: 'single-pair-observation',
      text: '单对观察，不能据此判定稳定差异。' + (attribution.attributionEligible ? '' : ' 归因数据不足，不能作单一因素因果解释。'),
    };
  }
  if (count === 2) {
    return {
      code: 'insufficient-sample',
      text: '两对样本不足，仅展示本次差异，不能判定稳定更快或可信差异。'
        + (attribution.attributionEligible ? '' : ' 归因数据不足，不能作单一因素因果解释。'),
    };
  }
  if (!attribution.attributionEligible) {
    return {
      code: attribution.status === 'mixed-environment' ? 'mixed-environment' : 'attribution-insufficient',
      text: attribution.status === 'mixed-environment'
        ? '这里只能描述两套混合环境的本次结果，不能把差异归因于单一目标因素。'
        : '归因数据不足；只能保留本次描述性结果，无法判断目标因素的独立影响。',
    };
  }
  if (count >= 6 && bootstrap) {
    if (bootstrap.crossesZero) {
      return { code: 'direction-undetermined', text: '探索性 95% 区间跨过 0，当前样本无法判定方向；不宣称普遍显著性。' };
    }
    const side = bootstrap.upper < 0 ? 'A' : 'B';
    return {
      code: side === 'A' ? 'experiment-supports-a' : 'experiment-supports-b',
      text: '本次实验支持存在 ' + side + ' 方向的耗时差异（配对 log(A/B) 中位数的探索性区间未跨过 0）；不宣称普遍显著性。',
    };
  }
  if (!directions.consistent) {
    return { code: 'direction-inconsistent', text: '不同轮次方向不一致；当前仅作初步描述，无法判定稳定方向。' };
  }
  if (directions.aFaster === count) {
    return { code: 'preliminary-a', text: '本次 ' + count + ' 对中 A 的完成耗时均较短；这只是初步描述，不代表统计显著或普遍结论。' };
  }
  if (directions.bFaster === count) {
    return { code: 'preliminary-b', text: '本次 ' + count + ' 对中 B 的完成耗时均较短；这只是初步描述，不代表统计显著或普遍结论。' };
  }
  return { code: 'preliminary-no-direction', text: '本次样本没有一致的快慢方向；仅作初步描述。' };
}

export function buildComparison(records, targetInput, options) {
  const opts = options || {};
  const target = typeof targetInput === 'string' ? parseTarget(targetInput) : targetInput;
  const comparisonId = opts.comparisonId || localStamp(opts.now || new Date()) + '-' + crypto.randomBytes(4).toString('hex');
  if (!/^[A-Za-z0-9._-]+$/.test(comparisonId)) throw new SummarizeError('BAD-COMPARISON-ID', 'comparisonId 含非法路径字符');
  const generatedAt = toLocalIso(opts.now || new Date());
  const prepared = records.map(function (record) {
    const env = normalizeEnvironment(record.data);
    const quality = runQuality(record.data);
    return Object.assign({}, record, {
      env: env,
      quality: quality,
      metrics: runMetrics(record.data, quality),
      targetIdentity: null,
      targetValue: null,
      group: null,
      includedInPairStats: false,
      unpairedReason: null,
    });
  });
  const grouping = assignGroups(prepared, target);
  const groupLabels = grouping.labels;
  const pairs = pairRecords(prepared);
  const validPairs = pairs.filter(function (pair) { return pair.valid; });
  const ratios = validPairs.map(function (pair) { return pair.ratioAOverB; });
  const directions = {
    count: validPairs.length,
    consistent: validPairs.length > 0 && new Set(validPairs.map(function (pair) { return pair.direction; })).size === 1,
    aFaster: validPairs.filter(function (pair) { return pair.direction === 'A'; }).length,
    bFaster: validPairs.filter(function (pair) { return pair.direction === 'B'; }).length,
    ties: validPairs.filter(function (pair) { return pair.direction === 'tie'; }).length,
  };
  const groups = {};
  for (const group of ['A', 'B']) {
    const members = prepared.filter(function (record) { return record.group === group; });
    const statistics = {};
    for (const definition of METRIC_DEFINITIONS) {
      statistics[definition.key] = describe(members.map(function (record) { return record.metrics[definition.key]; }));
    }
    groups[group] = {
      meaning: target.kind === 'plugin'
        ? '插件 ' + target.pluginId + (group === 'A' ? ' 关闭/未启用' : ' 启用')
        : (groupLabels[group] === null ? '未知' : String(groupLabels[group])),
      targetValue: groupLabels[group],
      selectedCount: members.length,
      successCount: members.filter(function (record) { return record.quality.successful; }).length,
      failureCount: members.filter(function (record) { return !record.quality.successful; }).length,
      runIds: members.map(function (record) { return record.runId; }),
      statistics: statistics,
      cache: {
        firstRequest: cacheCounts(members, 'firstRequestCache'),
        warmSummary: cacheCounts(members, 'summaryCache'),
      },
    };
  }
  const hasAB = groups.A.selectedCount > 0 && groups.B.selectedCount > 0;
  const attribution = checkEnvironment(prepared, target, hasAB);
  const sufficiency = sampleSufficiency(validPairs.length);
  const bootstrap = sufficiency.exploratoryInterval
    ? bootstrapMedianLogRatios(ratios, {
      iterations: opts.bootstrapIterations,
      seedText: target.text + '|' + prepared.map(function (record) { return record.runId; }).join('|'),
    })
    : null;
  const conclusion = makeConclusion(sufficiency, directions, bootstrap, attribution);
  const baseline = records[0].data;

  return {
    comparisonSchemaVersion: COMPARISON_SCHEMA_VERSION,
    comparisonId: comparisonId,
    generatedAt: generatedAt,
    target: { kind: target.kind, text: target.text, pluginId: target.pluginId, groups: groupLabels },
    compatibility: {
      resultSchemaVersion: baseline.resultSchemaVersion,
      metricVersion: baseline.metricVersion,
      taskTemplateHash: baseline.taskTemplateHash,
      taskVersion: baseline.taskVersion,
      acceptanceCommand: baseline.acceptanceCommand,
      consistent: true,
    },
    runs: prepared.map(function (record) {
      return {
        runId: record.runId,
        order: record.order,
        resultPath: record.resultPath,
        group: record.group || 'unknown',
        targetValue: record.targetValue,
        environment: environmentSummary(record.env),
        outcome: record.data.outcome || 'unknown',
        successful: record.quality.successful,
        elapsedSeconds: record.metrics.elapsedSeconds,
        includedInSuccessStats: record.quality.metricEligible,
        includedInDurationStats: record.metrics.elapsedSeconds !== null,
        includedInPairStats: record.includedInPairStats,
        unpairedReason: record.unpairedReason,
        exclusionReasons: record.quality.exclusionReasons,
        environmentChanged: record.quality.environmentChanged,
        attributionInvalid: record.quality.attributionInvalid,
        environmentMetadataUnknown: record.quality.environmentMetadataUnknown,
        concurrentPollution: record.quality.concurrent,
      };
    }),
    groups: groups,
    pairs: pairs,
    paired: {
      validPairCount: validPairs.length,
      ratioAOverB: describe(ratios),
      directions: directions,
      alternation: alternatingInfo(validPairs),
    },
    attribution: attribution,
    sampleSufficiency: sufficiency,
    bootstrap: bootstrap,
    conclusion: conclusion,
    limitations: [
      '仅汇总显式选择的 run；不自动补入最近运行。',
      '每两个相邻 run 尝试配对；失败、超时、越界、并发污染或耗时不完整者不进入相应速度判断。',
      '比值统一为 A/B，完成耗时比值小于 1 表示 A 更快。',
      '单对和两对只作观察；三对是初步描述；六对以上的 bootstrap 区间仍是本批样本的探索性区间。',
      '不同编程题、任务哈希、验收命令或指标版本不得混合比较。',
    ],
  };
}

function md(value) {
  if (value === null || value === undefined || value === '') return '未知';
  return maskSecrets(String(value)).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function numberText(value, digits) {
  return isFiniteNumber(value) ? value.toFixed(digits) : '未知';
}

function describeText(statistic, digits) {
  if (!statistic || statistic.n === 0) return 'n=0；未知';
  return 'n=' + statistic.n
    + '；中位=' + numberText(statistic.median, digits)
    + '；最小=' + numberText(statistic.min, digits)
    + '；最大=' + numberText(statistic.max, digits)
    + '；极差=' + numberText(statistic.range, digits)
    + '；MAD=' + numberText(statistic.mad, digits);
}

function outcomeText(value) {
  if (value === 'passed') return '通过';
  if (value === 'failed') return '失败';
  if (value === 'timeout') return '超时';
  if (value === 'aborted') return '中断';
  return '未知';
}

function runEnvironmentLine(env) {
  const plugins = env.plugins === null ? '插件未知'
    : (env.plugins.length === 0 ? '无启用插件' : env.plugins.map(function (plugin) {
      return plugin.id + (plugin.version ? '@' + plugin.version : '');
    }).join(','));
  return [env.model || '模型未知', env.channelAlias || env.baseURLHost || '渠道未知',
    'preset=' + (env.agentPreset || '未知'), plugins,
    '工具=' + (env.toolNamesHash || '未知') + '/' + (env.toolCount === null ? '未知' : env.toolCount)].join(' · ');
}

function inclusionText(run) {
  const parts = [];
  if (run.includedInSuccessStats) parts.push('成功描述');
  if (run.includedInPairStats) parts.push('配对');
  if (parts.length === 0) return '否（' + (run.unpairedReason || run.exclusionReasons.join(',') || '数据不足') + '）';
  if (run.unpairedReason) parts.push('未配对:' + run.unpairedReason);
  return parts.join('；');
}

function attributionText(status) {
  if (status === 'eligible') return '可归因（仅限本次样本，不代表因果保证）';
  if (status === 'mixed-environment') return '多套混合环境，仅可描述';
  if (status === 'attribution-invalid') return '环境身份冲突，归因无效';
  return '归因数据不足';
}

function directionText(direction) {
  if (direction === 'A') return 'A 较快';
  if (direction === 'B') return 'B 较快';
  if (direction === 'tie') return '相同';
  return '未知';
}

export function renderMarkdown(comparison) {
  const lines = [];
  lines.push('# 人工 A/B 测速比较');
  lines.push('');
  lines.push('- 比较目标：' + md(comparison.target.text));
  lines.push('- A 含义：' + md(comparison.groups.A.meaning));
  lines.push('- B 含义：' + md(comparison.groups.B.meaning));
  lines.push('- 生成时间：' + md(comparison.generatedAt));
  lines.push('- comparisonId：' + md(comparison.comparisonId));
  lines.push('');

  lines.push('## 入选 run 清单');
  lines.push('');
  lines.push('| 顺序 | runId | 分组 | 目标值 | 环境摘要 | 结果 | 完成耗时（秒） | 是否进入统计 |');
  lines.push('| ---: | --- | --- | --- | --- | --- | ---: | --- |');
  for (const run of comparison.runs) {
    lines.push('| ' + run.order + ' | ' + md(run.runId) + ' | ' + md(run.group) + ' | ' + md(run.targetValue)
      + ' | ' + md(runEnvironmentLine(run.environment)) + ' | ' + md(outcomeText(run.outcome))
      + ' | ' + numberText(run.elapsedSeconds, 3) + ' | ' + md(inclusionText(run)) + ' |');
  }
  lines.push('');

  lines.push('## 环境差异及比较资格');
  lines.push('');
  lines.push('- 版本/任务一致性：通过（resultSchemaVersion=' + comparison.compatibility.resultSchemaVersion
    + '，metricVersion=' + md(comparison.compatibility.metricVersion)
    + '，taskVersion=' + md(comparison.compatibility.taskVersion)
    + '，taskTemplateHash=' + md(comparison.compatibility.taskTemplateHash) + '）。');
  lines.push('- 验收命令：`' + md(comparison.compatibility.acceptanceCommand) + '`。');
  lines.push('- 归因资格：' + md(attributionText(comparison.attribution.status)) + '。');
  if (comparison.attribution.reasons.length > 0) {
    for (const reason of comparison.attribution.reasons) lines.push('- 说明：' + md(reason));
  }
  if (comparison.attribution.warnings.length > 0) {
    for (const warning of comparison.attribution.warnings) lines.push('- 限制：' + md(warning));
  }
  lines.push('');
  lines.push('| 字段 | 角色 | 检查 |');
  lines.push('| --- | --- | --- |');
  for (const check of comparison.attribution.checks) {
    const status = check.status === 'same' ? '一致'
      : (check.status === 'different' ? '不同'
        : (check.status === 'shared-unknown' ? '共享未知（结论以其未变化为前提）'
          : (check.status === 'same-with-unknown-versions' ? 'ID/启用状态一致，版本共享未知' : '未知')));
    lines.push('| ' + md(check.label) + ' | ' + md(check.role === 'control' ? '控制变量' : '目标允许差异')
      + ' | ' + status + ' |');
  }
  lines.push('');

  lines.push('## 完成耗时与主要分解指标');
  lines.push('');
  lines.push('- A：入选 ' + comparison.groups.A.selectedCount + '，成功 ' + comparison.groups.A.successCount
    + '，失败/超时/中断 ' + comparison.groups.A.failureCount + '。');
  lines.push('- B：入选 ' + comparison.groups.B.selectedCount + '，成功 ' + comparison.groups.B.successCount
    + '，失败/超时/中断 ' + comparison.groups.B.failureCount + '。');
  lines.push('');
  lines.push('| 指标 | A：n / 中位数 / 最小 / 最大 / 极差 / MAD | B：n / 中位数 / 最小 / 最大 / 极差 / MAD |');
  lines.push('| --- | --- | --- |');
  for (const definition of METRIC_DEFINITIONS) {
    lines.push('| ' + md(definition.label + (definition.unit ? '（' + definition.unit + '）' : ''))
      + ' | ' + md(describeText(comparison.groups.A.statistics[definition.key], definition.digits))
      + ' | ' + md(describeText(comparison.groups.B.statistics[definition.key], definition.digits)) + ' |');
  }
  lines.push('');
  lines.push('| 配对 | 顺序 | A run / 秒 | B run / 秒 | A/B | 方向 | 有效性 |');
  lines.push('| --- | --- | --- | --- | ---: | --- | --- |');
  for (const pair of comparison.pairs) {
    lines.push('| ' + pair.pairId + ' | ' + md(pair.order)
      + ' | ' + md(pair.aRunId) + ' / ' + numberText(pair.aElapsedSeconds, 3)
      + ' | ' + md(pair.bRunId) + ' / ' + numberText(pair.bElapsedSeconds, 3)
      + ' | ' + numberText(pair.ratioAOverB, 4) + ' | ' + md(directionText(pair.direction))
      + ' | ' + md(pair.valid ? '有效' : '未配对：' + pair.reasons.join(',')) + ' |');
  }
  lines.push('');
  lines.push('- 配对比值 A/B：' + md(describeText(comparison.paired.ratioAOverB, 4)) + '。');
  lines.push('- 方向：A 较快 ' + comparison.paired.directions.aFaster + ' 对，B 较快 '
    + comparison.paired.directions.bFaster + ' 对，相同 ' + comparison.paired.directions.ties + ' 对；方向'
    + (comparison.paired.directions.consistent ? '一致' : '不一致或样本不足') + '。');
  for (const group of ['A', 'B']) {
    const cache = comparison.groups[group].cache;
    lines.push('- ' + group + ' 缓存：任务首次请求 hit/miss/unknown = '
      + cache.firstRequest.hit + '/' + cache.firstRequest.miss + '/' + cache.firstRequest.unknown
      + '；短总结 hit/miss/unknown = ' + cache.warmSummary.hit + '/' + cache.warmSummary.miss + '/' + cache.warmSummary.unknown + '。');
  }
  lines.push('');

  lines.push('## 样本充分性、交替顺序和限制');
  lines.push('');
  lines.push('- 有效配对：' + comparison.paired.validPairCount + ' 对；等级：' + md(comparison.sampleSufficiency.label) + '。');
  lines.push('- 有效对顺序：' + md(comparison.paired.alternation.sequence.join(' → ') || '无') + '。');
  if (comparison.paired.alternation.alternating === null) {
    lines.push('- 少于两对有效样本，无法检查连续 AB/BA 交替；注意时段漂移。');
  } else if (comparison.paired.alternation.alternating) {
    lines.push('- 有效对采用交替顺序，可降低但不能消除时段漂移风险。');
  } else {
    lines.push('- 未采用连续 AB/BA 交替顺序，存在时段漂移风险；结果仍保留但不阻断描述。');
  }
  if (comparison.bootstrap) {
    lines.push('- 探索性 bootstrap：对配对 log(A/B) 中位数重采样 ' + comparison.bootstrap.iterations
      + ' 次，95% 区间 [' + numberText(comparison.bootstrap.lower, 5) + ', '
      + numberText(comparison.bootstrap.upper, 5) + ']；换算 A/B 比值区间 ['
      + numberText(comparison.bootstrap.ratioLower, 4) + ', ' + numberText(comparison.bootstrap.ratioUpper, 4) + ']。');
    lines.push('- 该区间只描述本次样本的探索性结果，不宣称普遍显著性'
      + (comparison.bootstrap.crossesZero ? '；区间跨过 0，当前样本无法判定方向。' : '。'));
  } else {
    lines.push('- 少于六对完整有效样本，不输出 bootstrap 区间。');
  }
  for (const limitation of comparison.limitations) lines.push('- ' + md(limitation));
  lines.push('');

  lines.push('## 客观结论');
  lines.push('');
  lines.push(comparison.conclusion.text);
  lines.push('');
  return lines.join('\n');
}

export function writeComparison(workspace, comparison, report) {
  const comparisonsRoot = path.join(workspace, '.speedtest', 'comparisons');
  const finalDir = path.join(comparisonsRoot, comparison.comparisonId);
  let temporaryDir = null;
  try {
    fs.mkdirSync(comparisonsRoot, { recursive: true });
    temporaryDir = fs.mkdtempSync(path.join(comparisonsRoot, '.pending-'));
    fs.writeFileSync(path.join(temporaryDir, 'comparison.json'), JSON.stringify(comparison, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(temporaryDir, 'comparison.md'), report, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryDir, finalDir);
    temporaryDir = null;
    return {
      comparisonDir: finalDir,
      comparisonJson: path.join(finalDir, 'comparison.json'),
      comparisonMarkdown: path.join(finalDir, 'comparison.md'),
    };
  } catch (err) {
    if (temporaryDir && path.dirname(temporaryDir) === comparisonsRoot && path.basename(temporaryDir).startsWith('.pending-')) {
      try { fs.rmSync(temporaryDir, { recursive: true, force: true }); } catch (cleanupError) { /* 保留原写入错误 */ }
    }
    throw new SummarizeError('WRITE-FAILED', '汇总文件写入失败：' + err.message + '；原始 run 未修改');
  }
}

export function runSummary(options) {
  const opts = options || {};
  if (!opts.workspace) throw new SummarizeError('WORKSPACE-REQUIRED', '必须提供 --workspace');
  const workspace = path.resolve(String(opts.workspace));
  let stat;
  try { stat = fs.statSync(workspace); } catch (err) {
    throw new SummarizeError('WORKSPACE-NOT-FOUND', '工作区不存在：' + workspace);
  }
  if (!stat.isDirectory()) throw new SummarizeError('WORKSPACE-NOT-DIRECTORY', '工作区不是目录：' + workspace);
  const target = parseTarget(opts.target);
  const records = loadRuns(workspace, opts.runs);
  const now = opts.now || new Date();
  const comparisonId = opts.comparisonId || localStamp(now) + '-' + crypto.randomBytes(4).toString('hex');
  const comparison = buildComparison(records, target, {
    comparisonId: comparisonId,
    now: now,
    bootstrapIterations: opts.bootstrapIterations,
  });
  const report = renderMarkdown(comparison);
  const paths = writeComparison(workspace, comparison, report);
  return { comparison: comparison, report: report, paths: paths };
}

function usage() {
  return [
    '用法：',
    '  node scripts/summarize.mjs --workspace <dir> --target <plugin:<id>|channel|preset> --run <runId|result.json路径> --run <...> [...]',
    '',
    '规则：--run 顺序即执行顺序；只读原 run；输出 .speedtest/comparisons/<comparisonId>/。',
  ].join('\n');
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.workspace || !args.target) throw new SummarizeError('BAD-ARGS', '必须提供 --workspace 与 --target\n' + usage());
  const result = runSummary({ workspace: args.workspace, target: args.target, runs: args.runs });
  console.log(JSON.stringify({
    comparisonId: result.comparison.comparisonId,
    comparisonDir: result.paths.comparisonDir,
    comparisonJson: result.paths.comparisonJson,
    comparisonMarkdown: result.paths.comparisonMarkdown,
    validPairs: result.comparison.paired.validPairCount,
    attributionStatus: result.comparison.attribution.status,
    conclusion: result.comparison.conclusion.text,
  }));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    const code = err && err.code ? err.code : 'UNEXPECTED';
    console.error('SUMMARIZE-ERROR ' + code + ': ' + maskSecrets(err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  }
}
