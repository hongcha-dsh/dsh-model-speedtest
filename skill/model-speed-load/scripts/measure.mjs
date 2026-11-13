#!/usr/bin/env node
// model-speed-load · 测量脚本（dev-short-v1）
//
// 只使用 Node 内置模块；不联网、不安装依赖、不启动任何子进程；会话日志只读。
//
// 子命令：
//   node scripts/measure.mjs start --workspace <dir>
//   node scripts/measure.mjs finish --workspace <dir> --run <runId> --outcome <pass|fail|timeout|aborted> [--session-log <file>]
//   node scripts/measure.mjs selftest [--keep]
//
// 数据口径见 ../MEASUREMENT-CONTRACT.md 与设计文档第 9–12 节。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  captureEnvironmentSnapshot,
  sanitizeEnvironmentSnapshot,
  compareEnvironmentSnapshots,
  UNKNOWN as ENV_UNKNOWN,
} from './environment.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(HERE, '..');
export const TEMPLATE_DIR = path.join(SKILL_ROOT, 'assets', 'dev-short-v1');
export const TASK_VERSION = 'dev-short-v1';
export const RESULT_SCHEMA_VERSION = 1;
export const METRIC_VERSION = 'v3-request-wall';
export const HARD_TIMEOUT_MS = 180000;
export const ACCEPTANCE_COMMAND = 'node --test --test-isolation=none';
// 单请求「outputTokens ÷ Σdt」超过这个值，就认为到达时间被服务端批量下发压平，Σdt 对照口径不可信。
export const CHUNK_BATCHING_TPS_THRESHOLD = 500;
// 环境指纹中工具清单哈希取 sha256 十六进制的前 8 位。
export const ENV_FINGERPRINT_HASH_LEN = 8;

const SPEEDTEST_DIR = '.speedtest';
const LOCK_FILE = '.lock';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const ALLOWED_EVENT_TYPES = new Set([
  'step/start',
  'assistant/message',
  'tool/call',
  'tool/result',
  'request/header',
  'request/context',
  'model/selection',
]);

const TASK_ALLOWED = new Set([
  'README.md',
  'package.json',
  'test/summary.test.js',
  'src/summary.js',
]);
const TASK_FROZEN = ['README.md', 'test/summary.test.js', 'package.json'];
const COPY_EXCLUDES = new Set(['.write-probe', 'node_modules', '.git', '.selftest-tmp', '.DS_Store']);

export class MeasureError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'MeasureError';
    this.code = code;
    this.detail = detail || null;
  }
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function toLocalIso(input) {
  const date = input instanceof Date ? input : new Date(input);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return date.getFullYear()
    + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + 'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
    + '.' + String(date.getMilliseconds()).padStart(3, '0')
    + sign + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sameStep(a, b) {
  const da = a.data || {};
  const db = b.data || {};
  return da.turn !== undefined && da.step !== undefined
    && da.turn === db.turn && da.step === db.step;
}

function stepKey(event) {
  const data = event.data || {};
  if (data.turn === undefined || data.step === undefined) return null;
  return data.turn + ':' + data.step;
}

function maskSecrets(value) {
  return String(value)
    .replace(/(sk-)[A-Za-z0-9_-]{6,}/g, '\$1***')
    .replace(/(ak-)[A-Za-z0-9_-]{6,}/g, '\$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/g, '\$1***');
}

// ---------------------------------------------------------------------------
// 环境指纹：provider/model + agentPreset + 工具清单
//
// 用途：同一模型在不同 preset / 插件（工具）组合下速度不同，报告必须能区分。
// 工具清单只保留 name（不含参数 schema、不含任何 Key），排序去重后取 sha256 前 8 位作指纹哈希。
// ---------------------------------------------------------------------------

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

// 工具定义的 name 列表：排序 + 去重。非数组返回 null（表示「读不到」，区别于「0 个工具」）。
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

// 报告里的环境指纹行，例如：a1b2c3d4 · 12 个工具 · deepseek-v4.1-flash · preset=standard
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

// agentPreset 只在会话首帧的 session 头里有；字段名以实测为准，逐个候选回退。
export function extractAgentPreset(header) {
  if (!header || typeof header !== 'object') return null;
  const direct = asNonEmptyString(header.agentPreset);
  if (direct) return direct;
  const preset = asNonEmptyString(header.preset);
  if (preset) return preset;
  if (header.agent && typeof header.agent === 'object') {
    const nested = asNonEmptyString(header.agent.preset) || asNonEmptyString(header.agent.agentPreset);
    if (nested) return nested;
  }
  if (header.meta && typeof header.meta === 'object') {
    const meta = asNonEmptyString(header.meta.agentPreset);
    if (meta) return meta;
  }
  return null;
}

// 解码后的日志第一行就是会话首帧 session 头；agentPreset 从这里读，读不到就是 null。
export function parseSessionHeaderFromText(text) {
  if (!text) return null;
  const first = String(text).split('\n').find(function (line) { return line.trim() !== ''; });
  if (!first) return null;
  let header;
  try {
    header = JSON.parse(first);
  } catch (err) {
    return null;
  }
  if (header && typeof header === 'object' && header.type === 'session') return header;
  return null;
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

export function resolveWorkspace(input) {
  const workspace = path.resolve(input || process.cwd());
  let stat;
  try {
    stat = fs.statSync(workspace);
  } catch (err) {
    throw new MeasureError('WORKSPACE-MISSING', '工作区不存在或不可访问：' + workspace + '（' + (err.code || err.message) + '）');
  }
  if (!stat.isDirectory()) {
    throw new MeasureError('WORKSPACE-MISSING', '工作区不是目录：' + workspace);
  }
  try {
    fs.accessSync(workspace, fs.constants.W_OK);
  } catch (err) {
    throw new MeasureError('WORKSPACE-NOT-WRITABLE', '工作区不可写：' + workspace + '（' + (err.code || err.message) + '）');
  }
  return workspace;
}

function ensureTemplate() {
  for (const rel of ['README.md', 'src/summary.js', 'test/summary.test.js', 'package.json']) {
    if (!fs.existsSync(path.join(TEMPLATE_DIR, rel))) {
      throw new MeasureError('TEMPLATE-MISSING', '固定任务模板缺少文件：' + path.join(TEMPLATE_DIR, rel));
    }
  }
}

const TASK_TEMPLATE_FILES = Object.freeze([
  'README.md',
  'package.json',
  'src/summary.js',
  'test/summary.test.js',
]);

// 题目身份哈希：固定顺序写入相对路径与原始字节，并用 NUL 分隔，避免简单拼接产生边界歧义。
export function computeTaskTemplateHash(templateDir) {
  const root = templateDir || TEMPLATE_DIR;
  const hash = crypto.createHash('sha256');
  for (const rel of TASK_TEMPLATE_FILES) {
    hash.update(rel, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(fs.readFileSync(path.join(root, rel)));
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

function copyTemplate(destination) {
  fs.cpSync(TEMPLATE_DIR, destination, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter(source) {
      const base = path.basename(source);
      if (COPY_EXCLUDES.has(base)) return false;
      if (base.endsWith('.log')) return false;
      return true;
    },
  });
}

function pickRunId(speedtestDir) {
  const stamp = toLocalIso(new Date()).slice(0, 19).replace(/[-:T]/g, '');
  const compact = stamp.slice(0, 8) + '-' + stamp.slice(8, 14);
  for (let i = 0; i < 200; i += 1) {
    const id = compact + '-' + crypto.randomBytes(4).toString('hex');
    if (!fs.existsSync(path.join(speedtestDir, id))) return id;
  }
  throw new MeasureError('RUNID-EXHAUSTED', '无法生成唯一的 runID（同名运行目录过多）');
}

// ---------------------------------------------------------------------------
// 串行锁
// ---------------------------------------------------------------------------

function acquireLock(lockPath, payload) {
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx');
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      let raw = null;
      let value = null;
      let corrupt = false;
      try {
        raw = fs.readFileSync(lockPath, 'utf8');
        value = JSON.parse(raw);
      } catch (readErr) {
        if (readErr && readErr.code !== 'ENOENT') corrupt = true;
      }
      return { acquired: false, raw: raw, value: value, corrupt: corrupt };
    }
    throw err;
  }
  try {
    fs.writeSync(fd, JSON.stringify(payload));
  } finally {
    fs.closeSync(fd);
  }
  return { acquired: true };
}

export function readLock(lockPath) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, raw: null, value: null, corrupt: false };
    return { exists: true, raw: null, value: null, corrupt: true, error: err.message };
  }
  try {
    return { exists: true, raw: raw, value: JSON.parse(raw), corrupt: false };
  } catch (err) {
    return { exists: true, raw: raw, value: null, corrupt: true, error: err.message };
  }
}

export function releaseOwnLock(lockPath, runId) {
  const info = readLock(lockPath);
  if (!info.exists) return { released: false, reason: 'no-lock' };
  if (info.corrupt || !info.value || info.value.runId !== runId) {
    return { released: false, reason: 'not-owner' };
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    return { released: false, reason: 'unlink-failed:' + (err.code || err.message) };
  }
  return { released: true };
}

// ---------------------------------------------------------------------------
// DSH_HOME / 会话日志定位
// ---------------------------------------------------------------------------

export function resolveDshHome(env) {
  const source = env || process.env || {};
  const candidates = [];
  if (source.DSH_HOME) candidates.push(source.DSH_HOME);
  candidates.push('D:\\DSH-Home');
  if (source.USERPROFILE) candidates.push(path.join(source.USERPROFILE, '.dsh'));
  try {
    candidates.push(path.join(os.homedir(), '.dsh'));
  } catch (err) {
    // ignore
  }
  if (source.LOCALAPPDATA) candidates.push(path.join(source.LOCALAPPDATA, 'dsh'));

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate) continue;
    let resolved;
    try {
      resolved = path.resolve(candidate);
    } catch (err) {
      continue;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!fs.statSync(resolved).isDirectory()) continue;
      if (!fs.statSync(path.join(resolved, 'sessions')).isDirectory()) continue;
      if (!fs.statSync(path.join(resolved, 'skills')).isDirectory()) continue;
      return resolved;
    } catch (err) {
      // 继续尝试下一个候选
    }
  }
  return null;
}

function listSessionLogs(dshHome) {
  const root = path.join(dshHome, 'sessions');
  let level1;
  try {
    level1 = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const files = [];
  for (const workspaceDir of level1) {
    if (!workspaceDir.isDirectory()) continue;
    const workspacePath = path.join(root, workspaceDir.name);
    let level2;
    try {
      level2 = fs.readdirSync(workspacePath, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const sessionDir of level2) {
      if (!sessionDir.isDirectory()) continue;
      const file = path.join(workspacePath, sessionDir.name, 'session.v4.jsonl.zstd');
      try {
        if (fs.statSync(file).isFile()) files.push(file);
      } catch (err) {
        // ignore
      }
    }
  }
  return files;
}

function readSessionHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    return null;
  }
  try {
    for (const size of [16384, 262144, 1048576]) {
      const buffer = Buffer.alloc(size);
      let read;
      try {
        read = fs.readSync(fd, buffer, 0, size, 0);
      } catch (err) {
        return null;
      }
      if (read <= 0) return null;
      try {
        const text = zlib.zstdDecompressSync(buffer.subarray(0, read)).toString('utf8');
        const first = text.split('\n').find(function (line) { return line.trim() !== ''; });
        const header = JSON.parse(first);
        if (header && header.type === 'session') return header;
      } catch (err) {
        // 首帧比当前读取窗口大，换更大的窗口
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

function normalizePath(input) {
  if (!input) return '';
  let value = String(input);
  try {
    value = fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  } catch (err) {
    // 保留原路径
  }
  try {
    value = path.resolve(value);
  } catch (err) {
    // ignore
  }
  if (process.platform === 'win32') value = value.toLowerCase();
  return value.replace(/[\\/]+$/, '');
}

export function findSessionLog(options) {
  const opts = options || {};
  if (opts.sessionLog && opts.sessionLog !== true) {
    const overridden = path.resolve(String(opts.sessionLog));
    let stat;
    try {
      stat = fs.statSync(overridden);
    } catch (err) {
      throw new MeasureError('SESSION-LOG-MISSING', '--session-log 指定的文件不存在：' + overridden);
    }
    if (!stat.isFile()) {
      throw new MeasureError('SESSION-LOG-MISSING', '--session-log 指定的路径不是文件：' + overridden);
    }
    return { path: overridden, source: 'override', matches: 1, mtimeMs: stat.mtimeMs };
  }

  const dshHome = opts.dshHome || resolveDshHome();
  if (!dshHome) {
    return {
      path: null,
      source: 'none',
      matches: 0,
      reason: '未找到 DSH_HOME（候选目录必须同时包含 sessions 与 skills）',
    };
  }

  // 优先用 DSH 注入的会话 id 精确定位，避免同工作区多个会话（子代理、并发对话）互相顶替。
  const envSessionId = process.env.DSH_SESSION_ID ? String(process.env.DSH_SESSION_ID).trim() : '';
  if (envSessionId) {
    const sessionsRoot = path.join(dshHome, 'sessions');
    let workspaceDirs = [];
    try {
      workspaceDirs = fs.readdirSync(sessionsRoot, { withFileTypes: true });
    } catch (err) {
      workspaceDirs = [];
    }
    for (const workspaceDir of workspaceDirs) {
      if (!workspaceDir.isDirectory()) continue;
      const candidate = path.join(sessionsRoot, workspaceDir.name, envSessionId, 'session.v4.jsonl.zstd');
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        return {
          path: candidate,
          source: 'session-id',
          matches: 1,
          inspected: 1,
          dshHome: dshHome,
          sessionId: envSessionId,
          mtimeMs: stat.mtimeMs,
        };
      } catch (err) {
        // 继续尝试下一个工作区目录
      }
    }
  }

  const workspaceKey = normalizePath(opts.workspace);
  const files = listSessionLogs(dshHome);
  let best = null;
  let inspected = 0;
  let matches = 0;
  for (const file of files) {
    const header = readSessionHeader(file);
    if (!header) continue;
    inspected += 1;
    if (normalizePath(header.cwd) !== workspaceKey) continue;
    matches += 1;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (err) {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) {
      best = { path: file, mtimeMs: mtimeMs, cwd: header.cwd, sessionId: header.id };
    }
  }

  if (!best) {
    return {
      path: null,
      source: 'discovered',
      matches: 0,
      inspected: inspected,
      dshHome: dshHome,
      reason: '在 ' + dshHome + ' 下未找到 cwd 匹配当前工作区的会话日志（已检查 ' + inspected + ' 个日志）',
    };
  }
  return {
    path: best.path,
    source: 'discovered',
    matches: matches,
    inspected: inspected,
    dshHome: dshHome,
    cwd: best.cwd,
    sessionId: best.sessionId,
    mtimeMs: best.mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// 多帧 zstd 解码与事件解析
// ---------------------------------------------------------------------------

function magicOffsets(buffer) {
  const offsets = [];
  let index = buffer.indexOf(ZSTD_MAGIC, 0);
  while (index !== -1) {
    offsets.push(index);
    index = buffer.indexOf(ZSTD_MAGIC, index + 1);
  }
  return offsets;
}

export function decodeZstdFrames(buffer) {
  if (!buffer || buffer.length === 0) {
    return { text: '', frames: 0, skipped: 0, plain: false };
  }
  const offsets = magicOffsets(buffer);
  if (offsets.length === 0) {
    const text = buffer.toString('utf8');
    if (/^\s*\{/.test(text)) {
      return { text: text, frames: 0, skipped: 0, plain: true };
    }
    throw new MeasureError('LOG-NOT-ZSTD', '日志既不是 zstd 帧，也不是 JSONL 明文');
  }

  const outputs = [];
  let index = 0;
  let skipped = 0;
  while (index < offsets.length) {
    const start = offsets[index];
    let end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    let cursor = index + 1;
    let done = false;
    for (;;) {
      try {
        outputs.push(zlib.zstdDecompressSync(buffer.subarray(start, end)));
        done = true;
        break;
      } catch (err) {
        if (cursor >= offsets.length) break;
        end = cursor + 1 < offsets.length ? offsets[cursor + 1] : buffer.length;
        cursor += 1;
      }
    }
    if (done) {
      index = cursor;
    } else {
      skipped += 1;
      index += 1;
    }
  }

  if (outputs.length === 0) {
    throw new MeasureError('LOG-DECODE-FAILED', '按 zstd 魔数切分后没有任何一帧能解压');
  }
  return {
    text: Buffer.concat(outputs).toString('utf8'),
    frames: outputs.length,
    skipped: skipped,
    plain: false,
  };
}

export function parseEvents(text) {
  const events = [];
  let badLines = 0;
  let filtered = 0;
  if (!text) return { events: events, badLines: 0, filtered: 0 };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      badLines += 1;
      continue;
    }
    if (!event || typeof event.type !== 'string') {
      badLines += 1;
      continue;
    }
    if (!ALLOWED_EVENT_TYPES.has(event.type)) {
      filtered += 1;
      continue;
    }
    events.push({
      type: event.type,
      seq: typeof event.seq === 'number' ? event.seq : null,
      time: typeof event.time === 'number' ? event.time : null,
      data: event.data && typeof event.data === 'object' ? event.data : {},
    });
  }
  events.sort(function (a, b) {
    const at = a.time === null ? 0 : a.time;
    const bt = b.time === null ? 0 : b.time;
    if (at !== bt) return at - bt;
    return (a.seq === null ? 0 : a.seq) - (b.seq === null ? 0 : b.seq);
  });
  return { events: events, badLines: badLines, filtered: filtered };
}

// ---------------------------------------------------------------------------
// 请求级指标
// ---------------------------------------------------------------------------

function pickNumber(usage, keys) {
  if (!usage || typeof usage !== 'object') return null;
  for (const key of keys) {
    if (isFiniteNumber(usage[key])) return usage[key];
  }
  return null;
}

export function extractUsage(messageEvent) {
  const data = (messageEvent && messageEvent.data) || {};
  const candidates = [];
  if (data.usage && typeof data.usage === 'object') {
    candidates.push({ usage: data.usage, source: 'data.usage' });
  }
  if (Array.isArray(data.stream)) {
    for (const item of data.stream) {
      if (item && item.chunk && item.chunk.usage && typeof item.chunk.usage === 'object') {
        candidates.push({ usage: item.chunk.usage, source: 'stream.chunk.usage' });
        break;
      }
    }
  }
  const replay = data.message
    && data.message.source
    && data.message.source.replayState
    && data.message.source.replayState.response
    && data.message.source.replayState.response.usage;
  if (replay && typeof replay === 'object') {
    candidates.push({ usage: replay, source: 'replayState.usage' });
  }

  if (candidates.length === 0) {
    return {
      usagePresent: false,
      source: null,
      outputTokens: null,
      inputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
      cacheSemanticsConfirmed: false,
    };
  }

  const read = function (keys) {
    for (const candidate of candidates) {
      const value = pickNumber(candidate.usage, keys);
      if (value !== null) return value;
    }
    return null;
  };

  const outputTokens = read(['outputTokens', 'output']);
  const inputTokens = read(['inputTokens', 'input']);
  const cacheReadTokens = read(['cacheReadTokens', 'cacheRead']);
  const cacheWriteTokens = read(['cacheWriteTokens', 'cacheWrite']);
  const totalTokens = read(['totalTokens', 'total']);

  return {
    usagePresent: true,
    source: candidates[0].source,
    outputTokens: outputTokens,
    inputTokens: inputTokens,
    cacheReadTokens: cacheReadTokens,
    cacheWriteTokens: cacheWriteTokens,
    totalTokens: totalTokens,
    cacheSemanticsConfirmed: cacheReadTokens !== null,
  };
}

export function streamHasText(stream) {
  if (!Array.isArray(stream)) return false;
  for (const item of stream) {
    if (!item) continue;
    if (item.type === 'text-chunks' && Array.isArray(item.texts)) {
      if (item.texts.some(function (text) { return typeof text === 'string' && text.trim() !== ''; })) return true;
    }
    if (item.type === 'chunk' && item.chunk && item.chunk.type === 'block-end'
      && item.chunk.block && item.chunk.block.type === 'text'
      && typeof item.chunk.block.text === 'string' && item.chunk.block.text.trim() !== '') {
      return true;
    }
  }
  return false;
}

// 一次请求的流式时间给出两个「对照口径」（主指标已改为整请求墙钟，见 analyzeEvents 里的 requestWallMs）：
//   spanMs  = (max(time0 + Σdt) − min(time0))：首个内容块到最后一个内容块结束的墙钟跨度
//   sumDtMs = Σ(Σdt)：逐 token 间隔之和
// 两者都只用于 result.json 与报告补充说明的对照：工具调用参数这类输出会被服务端批量塞进一个 SSE 包，
// dt 被压平（Σdt 高估速度）；而跨度又会随服务端「先想后吐 / 边想边吐」的交付形态伸缩（同一模型差 2 倍）。
// 所以主指标两个都不用，改用能同时覆盖预填、排队、思考与吐字的整请求墙钟。
export function streamTiming(stream) {
  if (!Array.isArray(stream)) {
    return { groups: 0, spanMs: null, sumDtMs: null, firstTokenTime: null, untimedGroups: 0 };
  }
  let sumDtMs = 0;
  let groups = 0;
  let untimedGroups = 0;
  let firstTime0 = null;
  let minTime0 = null;
  let maxEndMs = null;
  for (const item of stream) {
    if (!item || !Array.isArray(item.dt)) continue;
    groups += 1;
    let groupSum = 0;
    for (const dt of item.dt) {
      if (isFiniteNumber(dt) && dt >= 0) groupSum += dt;
    }
    sumDtMs += groupSum;
    if (isFiniteNumber(item.time0)) {
      if (firstTime0 === null || item.time0 < firstTime0) firstTime0 = item.time0;
      if (minTime0 === null || item.time0 < minTime0) minTime0 = item.time0;
      const groupEnd = item.time0 + groupSum;
      if (maxEndMs === null || groupEnd > maxEndMs) maxEndMs = groupEnd;
    } else {
      // 没有 time0 的组无法参与跨度，但它的 dt 仍计入旧口径；这里只记数量，便于报告说明回退。
      untimedGroups += 1;
    }
  }
  const spanMs = minTime0 !== null && maxEndMs !== null ? Math.max(0, maxEndMs - minTime0) : null;
  return {
    groups: groups,
    spanMs: spanMs,
    sumDtMs: groups > 0 ? sumDtMs : null,
    firstTokenTime: firstTime0,
    untimedGroups: untimedGroups,
  };
}

function resolveResultCallId(resultEvent, callSeqToId) {
  const data = (resultEvent && resultEvent.data) || {};
  const direct = data.toolCallId || data.callId
    || (data.message && (data.message.toolCallId || (data.message.source && data.message.source.callId)));
  if (direct) return String(direct);
  const seqs = resultEvent.sourceEventSeqs;
  if (Array.isArray(seqs)) {
    for (const seq of seqs) {
      if (callSeqToId.has(seq)) return callSeqToId.get(seq);
    }
  }
  return null;
}

function pickEnvironment(envEvents, startTime) {
  const before = envEvents.filter(function (event) {
    return event.time !== null && (startTime === null || event.time <= startTime);
  });
  const pool = before.length > 0 ? before : envEvents;
  for (let i = pool.length - 1; i >= 0; i -= 1) {
    const event = pool[i];
    const data = event.data || {};
    let provider = null;
    let model = null;
    if (event.type === 'request/header') {
      const config = data.header && data.header.config;
      if (config) {
        provider = config.provider;
        model = config.model;
      }
    } else {
      provider = data.provider;
      model = data.model;
    }
    if (typeof provider === 'string' || typeof model === 'string') {
      return {
        provider: typeof provider === 'string' ? provider : null,
        model: typeof model === 'string' ? model : null,
        source: event.type,
        time: event.time,
      };
    }
  }
  return { provider: null, model: null, source: null, time: null };
}

// 取任务开始前最后一个带 tools 的 request/header，只保留工具名列表；读不到返回 null。
function pickHeaderTools(envEvents, startTime) {
  const withTools = envEvents.filter(function (event) {
    return event.type === 'request/header'
      && event.data && event.data.header && Array.isArray(event.data.header.tools);
  });
  if (withTools.length === 0) return null;
  const before = withTools.filter(function (event) {
    return event.time !== null && (startTime === null || event.time <= startTime);
  });
  const pool = before.length > 0 ? before : withTools;
  return normalizeToolNames(pool[pool.length - 1].data.header.tools);
}

// start 的快照只从已定位日志补充 preset 与实际工具清单；provider/model 仍保留配置声明，
// 以便 finish 时与日志中的实际请求身份做冲突检查。任何读取失败都只导致未知，不阻断测量。
function readLogEnvironment(file) {
  if (!file) return { agentPreset: null, toolNames: null };
  try {
    const decoded = decodeZstdFrames(fs.readFileSync(file));
    const parsed = parseEvents(decoded.text);
    const envEvents = parsed.events.filter(function (event) {
      return event.type === 'request/header' || event.type === 'request/context' || event.type === 'model/selection';
    });
    return {
      agentPreset: extractAgentPreset(parseSessionHeaderFromText(decoded.text)),
      toolNames: pickHeaderTools(envEvents, null),
    };
  } catch (err) {
    return { agentPreset: null, toolNames: null };
  }
}

export function analyzeEvents(events, options) {
  const opts = options || {};
  const markerTime = isFiniteNumber(opts.markerTime) ? opts.markerTime : null;
  const finishTime = isFiniteNumber(opts.finishTime) ? opts.finishTime : Date.now();
  const notes = [];

  const stepList = [];
  const messages = [];
  const toolCalls = [];
  const toolResults = [];
  const envEvents = [];

  for (const event of events) {
    if (event.type === 'step/start') stepList.push(event);
    else if (event.type === 'assistant/message') messages.push(event);
    else if (event.type === 'tool/call') toolCalls.push(event);
    else if (event.type === 'tool/result') toolResults.push(event);
    else if (event.type === 'request/header' || event.type === 'request/context' || event.type === 'model/selection') {
      envEvents.push(event);
    }
  }

  const stepByKey = new Map();
  for (const step of stepList) {
    const key = stepKey(step);
    if (key !== null && !stepByKey.has(key)) stepByKey.set(key, step);
  }

  const callSeqToId = new Map();
  for (const call of toolCalls) {
    const callId = call.data && call.data.callId;
    if (call.seq !== null && callId) callSeqToId.set(call.seq, String(callId));
  }

  const resultByCallId = new Map();
  for (const result of toolResults) {
    const callId = resolveResultCallId(result, callSeqToId);
    if (callId && !resultByCallId.has(callId)) resultByCallId.set(callId, result);
  }

  let acceptanceTime = null;
  for (const result of toolResults) {
    if (result.time !== null && result.time < finishTime
      && (acceptanceTime === null || result.time > acceptanceTime)) {
      acceptanceTime = result.time;
    }
  }

  let startTime = null;
  if (markerTime !== null) {
    for (const step of stepList) {
      if (step.time !== null && step.time >= markerTime
        && (startTime === null || step.time < startTime)) {
        startTime = step.time;
      }
    }
  }

  const elapsedMs = startTime !== null && acceptanceTime !== null && acceptanceTime >= startTime
    ? acceptanceTime - startTime
    : null;

  if (markerTime === null) notes.push('缺少 markerTime，无法确定固定任务开始时刻。');
  else if (startTime === null) notes.push('日志中没有找到 markerTime 之后的 step/start，任务开始时刻未知。');
  if (acceptanceTime === null) notes.push('日志中没有找到 finish 之前的 tool/result，验收时刻未知。');

  const requests = [];
  for (const message of messages) {
    const step = stepByKey.get(stepKey(message)) || null;
    const usage = extractUsage(message);
    const timing = streamTiming(message.data && message.data.stream);
    const stepTime = step ? step.time : null;
    // 主口径｜整请求墙钟：assistant/message.time − 对应 step/start.time。
    // 含预填、排队、思考与吐字；工具执行在消息结束之后才跑，天然被排除。
    const requestWallMs = stepTime !== null && message.time !== null && message.time >= stepTime
      ? message.time - stepTime
      : null;
    const requestWallSeconds = requestWallMs !== null ? requestWallMs / 1000 : null;
    // 对照口径 1｜流式跨度：首个内容块 → 最后一个内容块结束。
    const streamSpanMs = timing.spanMs;
    const streamSpanSeconds = timing.spanMs !== null ? timing.spanMs / 1000 : null;
    // 对照口径 2｜逐段 Σdt：到达时间被服务端合并下发时会严重偏小。
    const chunkDeltaMs = timing.sumDtMs;
    const chunkDeltaSeconds = timing.sumDtMs !== null ? timing.sumDtMs / 1000 : null;
    // 到达时间被批量下发压平的特征：按 Σdt 口径算出来的速度高得离谱（> 500 tok/s）。
    const chunkBatchingSuspected = isFiniteNumber(chunkDeltaSeconds) && chunkDeltaSeconds > 0
      && isFiniteNumber(usage.outputTokens)
      && usage.outputTokens / chunkDeltaSeconds > CHUNK_BATCHING_TPS_THRESHOLD;
    const ttftMs = stepTime !== null && timing.firstTokenTime !== null && timing.firstTokenTime >= stepTime
      ? timing.firstTokenTime - stepTime
      : null;
    const hasToolCallAfter = toolCalls.some(function (call) {
      return sameStep(call, message) && call.time !== null && message.time !== null && call.time >= message.time;
    });
    const hasText = streamHasText(message.data && message.data.stream);
    requests.push({
      id: 'r' + (requests.length + 1),
      turn: message.data ? message.data.turn : null,
      step: message.data ? message.data.step : null,
      stepTime: stepTime,
      messageTime: message.time,
      outputTokens: usage.outputTokens,
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      usagePresent: usage.usagePresent,
      usageSource: usage.source,
      cacheSemanticsConfirmed: usage.cacheSemanticsConfirmed,
      requestWallMs: requestWallMs,
      requestWallSeconds: requestWallSeconds,
      streamSpanMs: streamSpanMs,
      streamSpanSeconds: streamSpanSeconds,
      chunkDeltaMs: chunkDeltaMs,
      chunkDeltaSeconds: chunkDeltaSeconds,
      chunkBatchingSuspected: chunkBatchingSuspected,
      ttftMs: ttftMs,
      firstResponseSeconds: ttftMs !== null ? ttftMs / 1000 : null,
      hasToolCallAfter: hasToolCallAfter,
      hasText: hasText,
      requestComplete: true,
      purpose: 'other',
    });
  }

  if (markerTime !== null && acceptanceTime !== null) {
    for (const request of requests) {
      const anchor = request.stepTime !== null ? request.stepTime : request.messageTime;
      if (anchor !== null && anchor >= markerTime
        && request.messageTime !== null && request.messageTime <= acceptanceTime) {
        request.purpose = 'dev';
      }
    }
    // 短总结 = 验收之后最后一次含文本的模型请求；若日志里没有文本分块，
    // 退回“验收后最后一次没有后续工具调用的请求”，最后才退回“验收后最后一次请求”。
    // 这样无论短总结与 finish 是同一条消息还是分开两次请求，都能取到暖缓存与首响应。
    const summaryCandidates = requests.filter(function (request) {
      const anchor = request.stepTime !== null ? request.stepTime : request.messageTime;
      return anchor !== null && anchor >= acceptanceTime;
    });
    let summary = null;
    const withText = summaryCandidates.filter(function (request) { return request.hasText === true; });
    if (withText.length > 0) {
      summary = withText[withText.length - 1];
    } else {
      const withoutTool = summaryCandidates.filter(function (request) { return request.hasToolCallAfter === false; });
      if (withoutTool.length > 0) summary = withoutTool[withoutTool.length - 1];
      else if (summaryCandidates.length > 0) summary = summaryCandidates[summaryCandidates.length - 1];
    }
    if (summary) summary.purpose = 'warm-summary';
  }

  const messageKeys = new Set();
  for (const message of messages) {
    const key = stepKey(message);
    if (key !== null) messageKeys.add(key);
  }
  const incompleteSteps = [];
  if (markerTime !== null && acceptanceTime !== null) {
    for (const step of stepList) {
      const key = stepKey(step);
      if (step.time !== null && step.time >= markerTime && step.time < acceptanceTime
        && (key === null || !messageKeys.has(key))) {
        incompleteSteps.push({
          turn: step.data ? step.data.turn : null,
          step: step.data ? step.data.step : null,
          time: step.time,
        });
      }
    }
  }
  if (incompleteSteps.length > 0) {
    notes.push('任务窗口内有 ' + incompleteSteps.length + ' 个 step/start 没有对应的 assistant/message（请求未完成），速度按口径记未知。');
  }

  const calls = markerTime !== null && acceptanceTime !== null
    ? toolCalls.filter(function (call) {
      return call.time !== null && call.time >= markerTime && call.time <= acceptanceTime;
    })
    : [];
  const tools = calls.map(function (call) {
    const callId = call.data && call.data.callId
      ? String(call.data.callId)
      : (call.seq !== null ? 'seq:' + call.seq : null);
    const result = callId ? resultByCallId.get(callId) : null;
    const duration = result && result.time !== null && call.time !== null && result.time >= call.time
      ? result.time - call.time
      : null;
    const isError = result && result.data
      ? (typeof result.data.isError === 'boolean'
        ? result.data.isError
        : (result.data.message && typeof result.data.message.isError === 'boolean' ? result.data.message.isError : null))
      : null;
    return {
      name: call.data && call.data.name ? String(call.data.name) : '未知',
      phase: 'dev',
      callId: callId,
      ms: duration,
      paired: duration !== null,
      isError: isError,
      turn: call.data ? call.data.turn : null,
      step: call.data ? call.data.step : null,
    };
  });
  if (calls.length > 0 && tools.some(function (tool) { return !tool.paired; })) {
    notes.push('有工具调用未配对到 tool/result，工具耗时记未知（调用次数仍如实统计）。');
  }

  // 实际请求身份取任务窗口内（或 finish 前）最后一条环境事件；配置声明另存于 finish 快照。
  const environment = pickEnvironment(envEvents, acceptanceTime === null ? finishTime : acceptanceTime);
  if (!environment.provider && !environment.model) {
    notes.push('日志中没有可用的 provider/model 记录。');
  }
  const toolNames = pickHeaderTools(envEvents, startTime);
  const agentPreset = extractAgentPreset(opts.sessionHeader);
  const fingerprint = computeEnvFingerprint({
    provider: environment.provider,
    model: environment.model,
    agentPreset: agentPreset,
    toolNames: toolNames,
  });
  if (fingerprint.toolNamesHash === null) {
    notes.push('日志中没有可用的 request/header 工具清单，环境指纹的工具部分记未知。');
  }
  if (!fingerprint.agentPreset) {
    notes.push('会话首帧没有可用的 agentPreset，环境指纹的 preset 部分记未知。');
  }
  const env = Object.assign({}, environment, {
    agentPreset: fingerprint.agentPreset,
    toolNames: fingerprint.toolNames,
    toolCount: fingerprint.toolCount,
    toolNamesHash: fingerprint.toolNamesHash,
    fingerprint: fingerprint,
  });

  return {
    markerTime: markerTime,
    finishTime: finishTime,
    startTime: startTime,
    acceptanceTime: acceptanceTime,
    elapsedMs: elapsedMs,
    requests: requests,
    devRequests: requests.filter(function (request) { return request.purpose === 'dev'; }),
    summaryRequest: requests.find(function (request) { return request.purpose === 'warm-summary'; }) || null,
    tools: tools,
    incompleteSteps: incompleteSteps,
    env: env,
    notes: notes,
  };
}

// ---------------------------------------------------------------------------
// 缓存三态 / 指标聚合 / 判定 / 报告
// ---------------------------------------------------------------------------

const CACHE_REASON_TEXT = {
  'usage-missing': 'usage 缺失',
  'request-incomplete': '请求未完成',
  'semantics-unconfirmed': '缓存字段语义未确认',
  'cache-read-invalid': 'cacheReadTokens 不可用',
  'request-not-found': '无该请求记录',
};

export function parseCacheState(request) {
  if (!request) return { state: 'unknown', reason: 'request-not-found', cacheReadTokens: null };
  if (request.usagePresent !== true) return { state: 'unknown', reason: 'usage-missing', cacheReadTokens: null };
  if (request.requestComplete !== true) return { state: 'unknown', reason: 'request-incomplete', cacheReadTokens: null };
  if (request.cacheSemanticsConfirmed !== true) {
    return { state: 'unknown', reason: 'semantics-unconfirmed', cacheReadTokens: null };
  }
  const tokens = request.cacheReadTokens;
  if (!isFiniteNumber(tokens) || tokens < 0) {
    return { state: 'unknown', reason: 'cache-read-invalid', cacheReadTokens: null };
  }
  if (tokens > 0) return { state: 'hit', reason: 'cache-read-positive', cacheReadTokens: tokens };
  return { state: 'miss', reason: 'cache-read-zero', cacheReadTokens: 0 };
}

export function formatCacheState(state) {
  const value = state || { state: 'unknown', reason: 'usage-missing' };
  if (value.state === 'hit') return '命中（cacheReadTokens=' + value.cacheReadTokens + '）';
  if (value.state === 'miss') return '未命中（cacheReadTokens=0）';
  return '未知（' + (CACHE_REASON_TEXT[value.reason] || '数据不足') + '）';
}

const SPEED_REASON_TEXT = {
  'no-requests': '无可用请求记录',
  'request-incomplete': '存在未完成的请求',
  'token-incomplete': 'token 数据不完整',
  'time-incomplete': '整请求耗时数据不完整（缺 step/start 或消息时间）',
};

// 主口径｜有效输出速度：
//   speedTps = Σ outputTokens ÷ Σ requestWallSeconds
// 任一开发请求缺 usage 或缺 step/start（拿不到整请求墙钟）→ 该请求不计入，整体速度记 unknown，不估算。
// 跨度口径（speedTpsStreamSpan）与逐段 Σdt 口径（speedTpsChunkDeltas）降级为对照，只出现在
// result.json 与报告补充说明里，任何情况下都不顶替主速度。
export function computeMetrics(run) {
  const requests = Array.isArray(run.requests) ? run.requests : [];
  const dev = requests.filter(function (request) { return request.purpose === 'dev'; });
  const summary = requests.find(function (request) { return request.purpose === 'warm-summary'; }) || null;

  let outputTokens = 0;
  let requestWallSeconds = 0;
  let streamSpanSeconds = 0;
  let chunkDeltaSeconds = 0;
  let tokensOk = dev.length > 0;
  let wallOk = dev.length > 0;
  let spanOk = dev.length > 0;
  let chunkDeltasOk = dev.length > 0;
  const wallMissingRequestIds = [];
  const spanMissingRequestIds = [];
  const chunkDeltaMissingRequestIds = [];
  const batchingRequestIds = [];
  for (const request of dev) {
    const id = request.id || ('r' + (dev.indexOf(request) + 1));
    if (request.usagePresent !== false && isFiniteNumber(request.outputTokens) && request.outputTokens >= 0) {
      outputTokens += request.outputTokens;
    } else {
      tokensOk = false;
    }
    // 主口径：整请求墙钟（step/start → assistant/message）。缺一个就让整体速度未知，绝不回退跨度。
    if (isFiniteNumber(request.requestWallSeconds) && request.requestWallSeconds > 0) {
      requestWallSeconds += request.requestWallSeconds;
    } else {
      wallOk = false;
      wallMissingRequestIds.push(id);
    }
    // 对照口径 1：流式跨度。
    if (isFiniteNumber(request.streamSpanSeconds) && request.streamSpanSeconds > 0) {
      streamSpanSeconds += request.streamSpanSeconds;
    } else {
      spanOk = false;
      spanMissingRequestIds.push(id);
    }
    // 对照口径 2：逐段 Σdt。
    if (isFiniteNumber(request.chunkDeltaSeconds) && request.chunkDeltaSeconds > 0) {
      chunkDeltaSeconds += request.chunkDeltaSeconds;
    } else {
      chunkDeltasOk = false;
      chunkDeltaMissingRequestIds.push(id);
    }
    if (request.chunkBatchingSuspected === true) {
      batchingRequestIds.push(id);
    }
  }

  let speedTps = null;
  let speedUnknownReason = null;
  if (dev.length === 0) {
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
  // 对照值只在 token 与对应时间都齐全时给出；缺了就是 null（未知），不混算。
  const spanSpeedTps = tokensOk && spanOk && streamSpanSeconds > 0
    ? outputTokens / streamSpanSeconds
    : null;
  const chunkDeltaSpeedTps = chunkDeltasOk && tokensOk && chunkDeltaSeconds > 0
    ? outputTokens / chunkDeltaSeconds
    : null;

  const tools = Array.isArray(run.tools) ? run.tools : [];
  const toolsKnown = run.toolsKnown !== false;
  const allToolsTimed = tools.every(function (tool) { return isFiniteNumber(tool.ms) && tool.ms >= 0; });
  const toolMs = !toolsKnown ? null : (tools.length === 0 ? 0 : (allToolsTimed
    ? tools.reduce(function (sum, tool) { return sum + tool.ms; }, 0)
    : null));

  return {
    devRequestCount: dev.length,
    outputTokens: dev.length > 0 && tokensOk ? outputTokens : null,
    requestWallSeconds: dev.length > 0 && wallOk ? requestWallSeconds : null,
    speedTps: speedTps,
    speedUnknownReason: speedUnknownReason,
    speedMissingRequestIds: wallMissingRequestIds,
    streamSpanSeconds: dev.length > 0 && spanOk ? streamSpanSeconds : null,
    speedTpsStreamSpan: spanSpeedTps,
    streamSpanMissingRequestIds: spanMissingRequestIds,
    chunkDeltaSeconds: dev.length > 0 && chunkDeltasOk ? chunkDeltaSeconds : null,
    speedTpsChunkDeltas: chunkDeltaSpeedTps,
    chunkDeltaMissingRequestIds: chunkDeltaMissingRequestIds,
    chunkBatchingSuspected: batchingRequestIds.length > 0,
    chunkBatchingRequestIds: batchingRequestIds,
    toolCount: toolsKnown ? tools.length : null,
    toolMs: toolMs,
    firstRequestCache: dev.length > 0
      ? parseCacheState(dev[0])
      : { state: 'unknown', reason: 'request-not-found', cacheReadTokens: null },
    summaryCache: summary
      ? parseCacheState(summary)
      : { state: 'unknown', reason: 'request-not-found', cacheReadTokens: null },
    summaryFirstResponseSeconds: summary && isFiniteNumber(summary.ttftMs) ? summary.ttftMs / 1000 : null,
    hasSummaryRequest: summary !== null,
  };
}

export function evaluateOutcome(input) {
  const data = input || {};
  const requested = data.requested;
  const elapsed = data.elapsedMs;
  const outOfScope = Array.isArray(data.outOfScopeChanges) ? data.outOfScopeChanges : [];
  if (requested === 'aborted') return { outcome: 'aborted', failureReason: 'aborted' };
  if (isFiniteNumber(elapsed) && elapsed > HARD_TIMEOUT_MS) {
    return { outcome: 'timeout', failureReason: 'over-3-minutes' };
  }
  if (requested === 'timeout') return { outcome: 'timeout', failureReason: 'marked-timeout' };
  if (requested === 'fail') return { outcome: 'failed', failureReason: 'tests-not-passed' };
  if (outOfScope.length > 0) return { outcome: 'failed', failureReason: 'out-of-scope-changes' };
  return { outcome: 'passed', failureReason: null };
}

const FAILURE_REASON_TEXT = {
  'tests-not-passed': '测试未全部通过',
  'out-of-scope-changes': '存在越界修改',
  'over-3-minutes': '超过 3 分钟硬上限',
  'marked-timeout': '到达 3 分钟硬上限',
  'aborted': '测量被中断',
};

function outcomeText(outcome) {
  if (outcome === 'passed') return '通过';
  if (outcome === 'timeout') return '超时';
  if (outcome === 'aborted') return '中断';
  return '失败';
}

function reportText(value) {
  if (value === null || value === undefined || value === ENV_UNKNOWN) return '未知';
  const text = String(value).trim();
  if (text === '') return '未知';
  return maskSecrets(text);
}

function elapsedCell(run) {
  if (!isFiniteNumber(run.elapsedMs)) return '未知';
  const seconds = (run.elapsedMs / 1000).toFixed(1) + ' 秒';
  if (run.outcome === 'timeout') {
    return seconds + (run.elapsedMs > HARD_TIMEOUT_MS
      ? '（已超过 3 分钟硬上限）'
      : '（主会话判定超时，日志耗时未超过 3 分钟）');
  }
  return seconds;
}

function speedCell(run, metrics) {
  if (run.outcome === 'passed' && metrics.speedTps !== null) {
    return metrics.speedTps.toFixed(1) + ' tok/s';
  }
  if (run.outcome === 'passed') {
    return '未知（' + (SPEED_REASON_TEXT[metrics.speedUnknownReason] || '数据不足') + '，未估算）';
  }
  if (run.outcome === 'timeout') return '未知（任务超时，原始数据见 result.json）';
  if (run.outcome === 'aborted') return '未知（测量中断，原始数据见 result.json）';
  return '未知（任务未通过，原始数据见 result.json）';
}

// 「模型请求耗时（含预填与思考）」= Σ requestWallSeconds（step/start → assistant/message）。
function requestWallCell(metrics) {
  if (metrics.requestWallSeconds === null) return '未知';
  return metrics.requestWallSeconds.toFixed(1) + ' 秒';
}

function toolCell(metrics) {
  if (metrics.toolMs === null) {
    return metrics.toolCount === null ? '未知' : '未知 / ' + metrics.toolCount + ' 次';
  }
  return (metrics.toolMs / 1000).toFixed(1) + ' 秒 / ' + metrics.toolCount + ' 次';
}

function firstResponseCell(metrics) {
  if (metrics.summaryFirstResponseSeconds === null) return '未知';
  return metrics.summaryFirstResponseSeconds.toFixed(2) + ' 秒';
}

function buildReportNotes(run, metrics) {
  const notes = [];
  if (run.outcome === 'aborted') {
    notes.push('测量被中断，已观察到的耗时与 token 原始数据保留在 result.json，不作为成功完成速度上报。');
  } else if (run.outcome !== 'passed') {
    notes.push('任务未通过（' + (FAILURE_REASON_TEXT[run.failureReason] || '原因未知')
      + '），已观察到的耗时与 token 原始数据保留在 result.json，不作为成功完成速度上报。');
  }
  if (run.outcome === 'timeout') {
    notes.push(isFiniteNumber(run.elapsedMs) && run.elapsedMs > HARD_TIMEOUT_MS
      ? '已超过 3 分钟硬上限，任务按超时记为未完成。'
      : '主会话按超时记录（日志耗时未超过 3 分钟硬上限）。');
  }
  const outOfScope = Array.isArray(run.outOfScopeChanges) ? run.outOfScopeChanges : [];
  if (outOfScope.length > 0) {
    notes.push('越界修改：' + outOfScope.join('、') + '（只允许修改 src/summary.js）。');
  }
  const environmentFlags = Array.isArray(run.environmentFlags) ? run.environmentFlags : [];
  const environmentInfo = run.environment || {};
  if (environmentFlags.includes('environment-changed')) {
    const fields = Array.isArray(environmentInfo.changedFields) ? environmentInfo.changedFields : [];
    notes.push('start/finish 环境快照发生变化（字段：' + (fields.join('、') || '未知')
      + '），本 run 已标记为 environment-changed。');
  }
  if (environmentFlags.includes('attribution-invalid')) {
    const fields = Array.isArray(environmentInfo.attributionInvalidFields) ? environmentInfo.attributionInvalidFields : [];
    notes.push('配置声明与日志实际请求身份冲突（字段：' + (fields.join('、') || '未知')
      + '），本 run 已标记为 attribution-invalid。');
  }
  if (run.outcome === 'passed' && metrics.speedTps === null) {
    notes.push('有效输出速度为未知（' + (SPEED_REASON_TEXT[metrics.speedUnknownReason] || '数据不足') + '），按口径不做估算。');
  }
  const wallMissingIds = Array.isArray(metrics.speedMissingRequestIds) ? metrics.speedMissingRequestIds : [];
  if (run.outcome === 'passed' && wallMissingIds.length > 0) {
    notes.push('有 ' + wallMissingIds.length + ' 个开发请求缺少 step/start（或消息时间），整请求墙钟无法计算（'
      + wallMissingIds.join('、') + '）；主速度按口径记未知，不估算、不回退跨度。');
  }
  // 对照口径只在报告可通过（有可信主速度）时给，且明确标注「仅供参考」；失败/超时不写任何 tok/s。
  if (run.outcome === 'passed' && isFiniteNumber(metrics.speedTpsStreamSpan)) {
    notes.push('对照：流式跨度口径 ' + metrics.speedTpsStreamSpan.toFixed(1) + ' tok/s（受服务端缓冲影响，仅供参考）');
  }
  if (run.outcome === 'passed' && isFiniteNumber(metrics.speedTpsChunkDeltas)) {
    notes.push('对照：逐段 Σdt 口径 ' + metrics.speedTpsChunkDeltas.toFixed(1) + ' tok/s（受服务端批量下发影响，仅供参考）');
  }
  if (run.outcome === 'passed' && isFiniteNumber(metrics.streamSpanSeconds) && isFiniteNumber(metrics.chunkDeltaSeconds)) {
    notes.push('对照明细：跨度合计 ' + metrics.streamSpanSeconds.toFixed(1) + ' 秒、Σdt 合计 '
      + metrics.chunkDeltaSeconds.toFixed(1) + ' 秒（同一批请求，均不参与结论）。');
  }
  if (metrics.chunkBatchingSuspected === true) {
    notes.push('有请求疑似批量下发（大量 token 挤在同一个 SSE 包里），逐段 Σdt 口径会高估速度，只能作对照。');
  }
  if (!metrics.hasSummaryRequest) {
    notes.push('未取得独立的固定短总结请求数据，暖缓存与首响应时间按未知处理。');
  }
  if (run.metricsSource && run.metricsSource !== 'session-event-log') {
    notes.push('请求级 usage 无法可靠读取（metricsSource=' + run.metricsSource + '），token 与缓存相关字段按未知处理。');
  }
  for (const note of Array.isArray(run.notes) ? run.notes : []) {
    if (note) notes.push(maskSecrets(note));
  }
  return notes;
}

function plainSummary(run, metrics) {
  let line;
  if (run.outcome === 'passed') line = '本次任务通过';
  else if (run.outcome === 'timeout') line = '本次任务超时';
  else if (run.outcome === 'aborted') line = '本次测量中断';
  else line = '本次任务未完成';

  if (isFiniteNumber(run.elapsedMs)) line += '，用时 ' + (run.elapsedMs / 1000).toFixed(1) + ' 秒';
  else line += '，实际耗时未知';

  if (metrics.toolMs !== null) line += '，其中工具运行占 ' + (metrics.toolMs / 1000).toFixed(1) + ' 秒';
  line += '；';

  if (metrics.summaryCache.state === 'hit') line += '短总结命中了暖缓存';
  else if (metrics.summaryCache.state === 'miss') line += '短总结未命中暖缓存';
  else line += '短总结缓存状态未知';
  return line + '。';
}

function toolNamesCell(fingerprint) {
  const names = fingerprint && Array.isArray(fingerprint.toolNames) ? fingerprint.toolNames : null;
  if (names === null) return '未知';
  if (names.length === 0) return '无工具';
  return names.map(reportText).join('、');
}

function channelKeyCell(env) {
  const channel = reportText(env.channelAlias);
  const alias = reportText(env.keyAlias);
  const fingerprint = reportText(env.keyFingerprint);
  const key = alias !== '未知' ? alias : fingerprint;
  if (key === '未知') return channel;
  return channel + ' / ' + key;
}

function pluginsCell(plugins) {
  if (!Array.isArray(plugins)) return reportText(plugins);
  if (plugins.length === 0) return '无启用插件';
  return plugins.map(function (plugin) {
    return reportText(plugin && plugin.id) + '@' + reportText(plugin && plugin.version);
  }).join('、');
}

function reasoningCell(reasoning) {
  if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
    return reportText(JSON.stringify(reasoning));
  }
  return reportText(reasoning);
}

export function renderReport(run) {
  const metrics = computeMetrics(run);
  const env = run.env || {};

  const provider = reportText(env.provider);
  const model = reportText(env.model);
  const providerModel = provider === '未知' && model === '未知' ? '未知' : provider + ' / ' + model;

  const lines = [];
  lines.push('# 当前环境测速报告', '');
  lines.push('- 时间：' + reportText(run.startedAt));
  lines.push('- provider/model：' + providerModel);
  lines.push('- 环境指纹：' + reportText(formatEnvFingerprint(env.fingerprint)));
  lines.push('- 工具清单：' + toolNamesCell(env.fingerprint));
  lines.push('- 渠道/Key 别名：' + channelKeyCell(env));
  lines.push('- baseURL 主机：' + reportText(env.baseUrlHost));
  lines.push('- 插件组合：' + pluginsCell(env.plugins));
  lines.push('- 推理设置：' + reasoningCell(env.reasoning));
  lines.push('- DSH 版本：' + reportText(env.dshVersion));
  lines.push('- 结果/指标版本：' + reportText(run.resultSchemaVersion === undefined ? RESULT_SCHEMA_VERSION : run.resultSchemaVersion)
    + ' / ' + reportText(run.metricVersion || METRIC_VERSION));
  lines.push('- 任务版本：' + reportText(run.taskVersion || TASK_VERSION));
  lines.push('- 任务模板哈希：' + reportText(run.taskTemplateHash || computeTaskTemplateHash(TEMPLATE_DIR)));
  lines.push('');
  lines.push('| 指标 | 结果 |');
  lines.push('| --- | --- |');
  lines.push('| 任务结果 | ' + outcomeText(run.outcome) + ' |');
  lines.push('| 实际完成耗时 | ' + elapsedCell(run) + ' |');
  lines.push('| 有效输出速度 | ' + speedCell(run, metrics) + ' |');
  lines.push('| 模型请求耗时（含预填与思考） | ' + requestWallCell(metrics) + ' |');
  lines.push('| 工具执行耗时与次数 | ' + toolCell(metrics) + ' |');
  lines.push('| 任务首次请求缓存 | ' + formatCacheState(metrics.firstRequestCache) + ' |');
  lines.push('| 短总结暖缓存 | ' + formatCacheState(metrics.summaryCache) + ' |');
  lines.push('| 短总结首响应时间 | ' + firstResponseCell(metrics) + ' |');
  lines.push('');

  const notes = buildReportNotes(run, metrics);
  if (notes.length > 0) {
    lines.push('补充说明：');
    for (const note of notes) lines.push('- ' + note);
    lines.push('');
  }

  lines.push(plainSummary(run, metrics));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// 越界检查
// ---------------------------------------------------------------------------

export function checkOutOfScope(taskDir, templateDir) {
  const problems = [];
  for (const rel of TASK_FROZEN) {
    const templateFile = path.join(templateDir, rel);
    const taskFile = path.join(taskDir, rel);
    let templateBuffer = null;
    let taskBuffer = null;
    try {
      templateBuffer = fs.readFileSync(templateFile);
    } catch (err) {
      templateBuffer = null;
    }
    try {
      taskBuffer = fs.readFileSync(taskFile);
    } catch (err) {
      taskBuffer = null;
    }
    if (taskBuffer === null) {
      problems.push(rel + '（缺失）');
      continue;
    }
    if (templateBuffer === null || !templateBuffer.equals(taskBuffer)) {
      problems.push(rel + '（被修改）');
    }
  }

  function walk(dir, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        problems.push(rel + '（符号链接）');
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!TASK_ALLOWED.has(rel)) problems.push(rel + '（新增）');
    }
  }
  walk(taskDir, '');
  return problems;
}

// ---------------------------------------------------------------------------
// start / finish
// ---------------------------------------------------------------------------

export function runStart(options) {
  const opts = options || {};
  const workspace = resolveWorkspace(opts.workspace);
  ensureTemplate();

  const speedtestDir = path.join(workspace, SPEEDTEST_DIR);
  fs.mkdirSync(speedtestDir, { recursive: true });

  const runId = pickRunId(speedtestDir);
  const lockPath = path.join(speedtestDir, LOCK_FILE);
  const startedAt = toLocalIso(new Date());
  const payload = { runId: runId, status: 'running', startedAt: startedAt, pid: process.pid };

  const lock = acquireLock(lockPath, payload);
  if (!lock.acquired) {
    throw new MeasureError('BUSY', '工作区已有测速在跑，锁已存在：' + lockPath, {
      raw: lock.raw,
      value: lock.value,
      corrupt: lock.corrupt,
    });
  }

  try {
    const runDir = path.join(speedtestDir, runId);
    fs.mkdirSync(runDir);
    const taskDir = path.join(runDir, 'task');
    copyTemplate(taskDir);
    const markerTime = Date.now();

    let logInfo = { path: null, source: 'skipped', reason: null };
    if (!opts.noSessionLog) {
      try {
        logInfo = findSessionLog({
          workspace: workspace,
          dshHome: opts.dshHome,
          sessionLog: opts.sessionLog,
        });
      } catch (err) {
        logInfo = { path: null, source: 'error', reason: err.message };
      }
    }

    const dshHome = opts.dshHome || resolveDshHome();
    const hintRoot = dshHome || '<DSH_HOME>';
    const logEnvironment = readLogEnvironment(logInfo.path);
    const taskTemplateHash = computeTaskTemplateHash(TEMPLATE_DIR);
    const startEnvironment = opts.environmentSnapshot !== undefined
      ? sanitizeEnvironmentSnapshot(opts.environmentSnapshot)
      : captureEnvironmentSnapshot({
        dshHome: dshHome,
        profileDir: opts.profileDir,
        taskVersion: TASK_VERSION,
        agentPreset: logEnvironment.agentPreset,
        toolNames: logEnvironment.toolNames,
      });
    const info = {
      runId: runId,
      runDir: runDir,
      taskDir: taskDir,
      markerTime: markerTime,
      lockPath: lockPath,
      dshHome: dshHome,
      sessionLogHint: logInfo.path || path.join(hintRoot, 'sessions', '*', '*', 'session.v4.jsonl.zstd'),
      sessionLog: logInfo.path || null,
      sessionLogSource: logInfo.source || null,
      sessionLogReason: logInfo.reason || null,
      taskVersion: TASK_VERSION,
    };

    fs.writeFileSync(path.join(runDir, 'marker.json'), JSON.stringify({
      taskVersion: TASK_VERSION,
      taskTemplateHash: taskTemplateHash,
      runId: runId,
      startedAt: startedAt,
      markerTime: markerTime,
      workspace: workspace,
      taskDir: taskDir,
      sessionLog: info.sessionLog,
      dshHome: dshHome,
      environmentStart: startEnvironment,
    }, null, 2), 'utf8');

    return info;
  } catch (err) {
    try {
      releaseOwnLock(lockPath, runId);
    } catch (releaseErr) {
      // 释放失败不覆盖原始错误
    }
    throw err;
  }
}

function parseRunIdTime(runId) {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-[0-9a-f]{8}$/.exec(String(runId));
  if (!match) return null;
  const date = new Date(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
  );
  const time = date.getTime();
  return Number.isFinite(time) ? time : null;
}

function normalizeRequestedOutcome(value) {
  const map = {
    pass: 'pass',
    passed: 'pass',
    fail: 'fail',
    failed: 'fail',
    timeout: 'timeout',
    aborted: 'aborted',
  };
  const key = String(value || '').toLowerCase();
  if (!map[key]) {
    throw new MeasureError('BAD-ARGS', '--outcome 必须是 pass|fail|timeout|aborted（收到：' + String(value) + '）');
  }
  return map[key];
}

export function runFinish(options) {
  const opts = options || {};
  const workspace = resolveWorkspace(opts.workspace);
  const runId = opts.run ? String(opts.run) : '';
  if (!runId) throw new MeasureError('BAD-ARGS', 'finish 需要 --run <runId>');
  const requested = normalizeRequestedOutcome(opts.outcome);

  const speedtestDir = path.join(workspace, SPEEDTEST_DIR);
  const lockPath = path.join(speedtestDir, LOCK_FILE);
  const lock = readLock(lockPath);
  if (!lock.exists) {
    throw new MeasureError('NOT-OWNER', '未找到锁，无法确认本次运行所有权：' + lockPath, { raw: null, value: null });
  }
  if (lock.corrupt || !lock.value || lock.value.runId !== runId) {
    throw new MeasureError('NOT-OWNER', '锁不属于本次运行（--run=' + runId + '）', {
      raw: lock.raw,
      value: lock.value,
      corrupt: lock.corrupt,
    });
  }

  const runDir = path.join(speedtestDir, runId);
  if (!fs.existsSync(runDir)) {
    releaseOwnLock(lockPath, runId);
    throw new MeasureError('NO-RUN-DIR', '运行目录不存在，已释放本次锁：' + runDir);
  }

  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(runDir, 'marker.json'), 'utf8'));
  } catch (err) {
    marker = null;
  }
  const markerTime = marker && isFiniteNumber(marker.markerTime)
    ? marker.markerTime
    : parseRunIdTime(runId);
  const finishTime = isFiniteNumber(opts.finishTime) ? opts.finishTime : Date.now();
  const extraNotes = [];
  if (!marker || !isFiniteNumber(markerTime)) {
    extraNotes.push('缺少 marker.json 中的 markerTime，任务开始时刻按 runID 时间近似，可能存在秒级误差。');
  }

  let logInfo;
  try {
    if (opts.sessionLog && opts.sessionLog !== true) {
      logInfo = findSessionLog({ workspace: workspace, sessionLog: opts.sessionLog });
    } else {
      // 契约：finish 时重新按 cwd + mtime 定位，当前会话日志通常就是最新的。
      logInfo = findSessionLog({ workspace: workspace, dshHome: opts.dshHome });
      if (!logInfo.path && marker && marker.sessionLog && fs.existsSync(marker.sessionLog)) {
        logInfo = { path: marker.sessionLog, source: 'marker-fallback' };
      }
    }
  } catch (err) {
    logInfo = { path: null, source: 'error', reason: err.message };
  }

  let events = [];
  let decodeInfo = null;
  let badLines = 0;
  let filtered = 0;
  let logError = null;
  if (!logInfo.path) {
    logError = logInfo.reason || '未找到会话日志';
  } else {
    try {
      const buffer = fs.readFileSync(logInfo.path);
      decodeInfo = decodeZstdFrames(buffer);
      const parsed = parseEvents(decodeInfo.text);
      events = parsed.events;
      badLines = parsed.badLines;
      filtered = parsed.filtered;
    } catch (err) {
      logError = err.message;
      events = [];
    }
  }

  const sessionHeader = decodeInfo ? parseSessionHeaderFromText(decodeInfo.text) : null;
  const analysis = analyzeEvents(events, {
    markerTime: isFiniteNumber(markerTime) ? markerTime : null,
    finishTime: finishTime,
    sessionHeader: sessionHeader,
  });
  const finishDshHome = opts.dshHome || (marker && marker.dshHome) || resolveDshHome();
  const finishEnvironment = opts.environmentSnapshot !== undefined
    ? sanitizeEnvironmentSnapshot(opts.environmentSnapshot)
    : captureEnvironmentSnapshot({
      dshHome: finishDshHome,
      profileDir: opts.profileDir,
      taskVersion: TASK_VERSION,
      agentPreset: analysis.env.agentPreset,
      toolNames: analysis.env.toolNames,
    });
  const environment = compareEnvironmentSnapshots(
    marker && marker.environmentStart ? marker.environmentStart : {},
    finishEnvironment,
    analysis.env,
  );
  const notes = analysis.notes.concat(extraNotes);
  if (logError) {
    notes.push('会话日志不可用（' + logError + '），token、缓存与首响应时间按未知处理。');
  } else {
    if (decodeInfo && decodeInfo.skipped > 0) {
      notes.push('多帧解码时跳过 ' + decodeInfo.skipped + ' 个无法解压的区段（伪魔数或未写完的尾帧）。');
    }
    if (badLines > 0) {
      notes.push('日志中有 ' + badLines + ' 行无法解析，已跳过。');
    }
  }

  const taskDir = path.join(runDir, 'task');
  const outOfScopeChanges = checkOutOfScope(taskDir, TEMPLATE_DIR);
  if (outOfScopeChanges.length > 0) {
    notes.push('越界修改：' + outOfScopeChanges.join('、') + '（只允许修改 src/summary.js）。');
  }

  const verdict = evaluateOutcome({
    requested: requested,
    elapsedMs: analysis.elapsedMs,
    outOfScopeChanges: outOfScopeChanges,
  });
  if (requested === 'pass' && verdict.outcome !== 'passed') {
    notes.push('主会话报告为通过，但按硬规则改判为' + outcomeText(verdict.outcome) + '。');
  }

  const toolsKnown = !logError && analysis.acceptanceTime !== null;
  const metrics = computeMetrics({
    requests: analysis.requests,
    tools: analysis.tools,
    incompleteSteps: analysis.incompleteSteps,
    toolsKnown: toolsKnown,
  });

  const env = {
    provider: analysis.env.provider || ENV_UNKNOWN,
    model: analysis.env.model || ENV_UNKNOWN,
    agentPreset: analysis.env.agentPreset || ENV_UNKNOWN,
    channelAlias: finishEnvironment.channelAlias,
    baseUrlHost: finishEnvironment.baseUrlHost,
    keyAlias: finishEnvironment.keyAlias,
    keyFingerprint: finishEnvironment.keyFingerprint,
    plugins: finishEnvironment.plugins,
    reasoning: finishEnvironment.reasoning,
    dshVersion: finishEnvironment.dshVersion,
    fingerprint: analysis.env.fingerprint || computeEnvFingerprint({}),
  };

  const run = {
    resultSchemaVersion: RESULT_SCHEMA_VERSION,
    metricVersion: METRIC_VERSION,
    taskVersion: TASK_VERSION,
    taskTemplateHash: marker && typeof marker.taskTemplateHash === 'string' && /^[0-9a-f]{64}$/.test(marker.taskTemplateHash)
      ? marker.taskTemplateHash
      : computeTaskTemplateHash(TEMPLATE_DIR),
    environmentFlags: environment.flags,
    environment: {
      start: environment.start,
      finish: environment.finish,
      changedFields: environment.changedFields,
      attributionInvalidFields: environment.attributionInvalidFields,
    },
    runId: runId,
    startedAt: marker && marker.startedAt ? marker.startedAt : toLocalIso(new Date(markerTime || finishTime)),
    finishedAt: toLocalIso(new Date(finishTime)),
    outcome: verdict.outcome,
    elapsedMs: analysis.elapsedMs,
    failureReason: verdict.failureReason,
    acceptanceCommand: ACCEPTANCE_COMMAND,
    outOfScopeChanges: outOfScopeChanges,
    metricsSource: logError
      ? (logInfo.path ? 'session-log-unreadable' : 'unavailable')
      : 'session-event-log',
    env: env,
    requests: analysis.requests,
    tools: analysis.tools,
    toolsKnown: toolsKnown,
    metrics: metrics,
    notes: notes,
    markerTime: markerTime,
    startTime: analysis.startTime,
    acceptanceTime: analysis.acceptanceTime,
    finishTime: finishTime,
    sessionLog: logInfo.path || null,
    sessionLogSource: logInfo.source || null,
    sessionLogError: logError,
    decode: decodeInfo ? { frames: decodeInfo.frames, skipped: decodeInfo.skipped, plain: decodeInfo.plain } : null,
    badLines: badLines,
    filteredEvents: filtered,
    incompleteSteps: analysis.incompleteSteps,
    lockPath: lockPath,
    lockReleased: false,
  };

  const resultPath = path.join(runDir, 'result.json');
  const reportPath = path.join(runDir, 'report.md');

  function writeArtifacts() {
    run.metrics = computeMetrics(run);
    const report = renderReport(run);
    fs.writeFileSync(resultPath, JSON.stringify(run, null, 2) + '\n', 'utf8');
    fs.writeFileSync(reportPath, report, 'utf8');
    return report;
  }

  let report;
  try {
    report = writeArtifacts();
  } catch (err) {
    releaseOwnLock(lockPath, runId);
    throw new MeasureError('WRITE-FAILED', '写入结果文件失败：' + err.message);
  }

  const release = releaseOwnLock(lockPath, runId);
  run.lockReleased = release.released;
  if (!release.released) {
    run.notes.push('释放锁失败：' + release.reason + '，锁保留，请人工确认。');
  }
  report = writeArtifacts();

  return {
    run: run,
    report: report,
    resultPath: resultPath,
    reportPath: reportPath,
    summary: {
      runId: run.runId,
      resultSchemaVersion: run.resultSchemaVersion,
      metricVersion: run.metricVersion,
      taskTemplateHash: run.taskTemplateHash,
      environmentFlags: run.environmentFlags,
      outcome: run.outcome,
      elapsedMs: run.elapsedMs,
      speedTps: run.metrics.speedTps,
      speedTpsStreamSpan: run.metrics.speedTpsStreamSpan,
      speedTpsChunkDeltas: run.metrics.speedTpsChunkDeltas,
      reportPath: reportPath,
      resultPath: resultPath,
      sessionLog: run.sessionLog,
      lockReleased: run.lockReleased,
      outOfScopeChanges: run.outOfScopeChanges,
      metricsSource: run.metricsSource,
    },
  };
}

// ---------------------------------------------------------------------------
// 自测（离线合成数据；不读真实会话、不联网、不发模型请求）
// ---------------------------------------------------------------------------

function makeTempRoot() {
  const candidates = [os.tmpdir(), path.join(SKILL_ROOT, '.selftest-tmp')];
  let lastError = null;
  for (const base of candidates) {
    try {
      fs.mkdirSync(base, { recursive: true });
      return fs.mkdtempSync(path.join(base, 'msl-measure-'));
    } catch (err) {
      lastError = err;
    }
  }
  throw new MeasureError('TEMP-FAILED', '无法创建临时目录：' + (lastError ? lastError.message : '未知原因'));
}

function encodeFrames(objects, options) {
  const opts = options || {};
  const frames = objects.map(function (object) {
    return zlib.zstdCompressSync(Buffer.from(JSON.stringify(object) + '\n', 'utf8'));
  });
  if (opts.garbage) {
    return Buffer.concat([ZSTD_MAGIC, Buffer.alloc(8, 7)].concat(frames));
  }
  return Buffer.concat(frames);
}

function syntheticEvents(base) {
  let seq = 0;
  const event = function (type, offset, data) {
    seq += 1;
    return { type: type, seq: seq, time: base + offset, data: data };
  };
  const usage = function (outputTokens, cacheReadTokens) {
    return {
      inputTokens: 1000,
      outputTokens: outputTokens,
      totalTokens: 1000 + outputTokens,
      cacheReadTokens: cacheReadTokens,
    };
  };
  return [
    // 工具清单故意乱序给出：环境指纹必须排序+去重后再算哈希。
    event('request/header', 500, {
      header: {
        config: { provider: 'provider-x', model: 'model-y' },
        tools: [{ name: 'write' }, { name: 'run_code' }, { name: 'read' }, { name: 'read' }],
      },
    }),
    event('step/start', 1000, { turn: 1, step: 1 }),
    event('assistant/message', 5000, {
      turn: 1,
      step: 1,
      usage: usage(600, 0),
      // 批量下发用例：dt 合计只有 200ms（旧口径 0.2s），首个内容块 1.2s、最后一个内容块结束 3.9s（跨度 2.7s）。
      // 真实的工具调用参数场景就是这样：487 段 dt 合计 203ms，首块→末块却跨了 2681ms。
      stream: [
        { type: 'reasoning-chunks', time0: base + 1200, index: 0, dt: [100, 100] },
        { type: 'tool-call-chunks', time0: base + 3900, index: 2, dt: [], id: 'tool_1', name: 'run_code' },
      ],
    }),
    event('tool/call', 5100, { turn: 1, step: 1, callId: 'c1', name: 'run_code' }),
    event('tool/result', 12000, { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false } }),
    event('step/start', 12100, { turn: 1, step: 2 }),
    event('assistant/message', 14000, {
      turn: 1,
      step: 2,
      usage: usage(200, 0),
      stream: [{ type: 'text-chunks', time0: base + 12200, index: 1, dt: [50, 50, 50, 50, 50, 50, 50, 50] }],
    }),
    event('tool/call', 14100, { turn: 1, step: 2, callId: 'c2', name: 'run_code' }),
    event('tool/result', 15000, { turn: 1, step: 2, message: { toolCallId: 'c2', isError: false } }),
    event('step/start', 16000, { turn: 1, step: 3 }),
    event('assistant/message', 17200, {
      turn: 1,
      step: 3,
      usage: usage(80, 1920),
      stream: [{ type: 'text-chunks', time0: base + 16100, index: 1, dt: [40, 40, 40, 40, 40] }],
    }),
    event('step/start', 17300, { turn: 1, step: 4 }),
    event('assistant/message', 18000, {
      turn: 1,
      step: 4,
      usage: usage(50, 1920),
      stream: [{ type: 'text-chunks', time0: base + 17400, index: 1, dt: [20] }],
    }),
    event('tool/call', 18100, { turn: 1, step: 4, callId: 'c3', name: 'run_code' }),
  ];
}

const SELFTEST_ENVIRONMENT_SNAPSHOT = sanitizeEnvironmentSnapshot({
  provider: 'provider-x',
  model: 'model-y',
  channelAlias: '渠道A',
  baseUrlHost: 'api.example.com',
  keyAlias: 'SYNTHETIC_KEY_ALIAS',
  agentPreset: 'standard',
  reasoning: { effort: 'low' },
  plugins: [{ id: 'plugin-a', version: '1.0.0' }],
  toolNames: ['read', 'run_code', 'write'],
  dshVersion: '44.7.0-test',
  taskVersion: TASK_VERSION,
});

export function runSelftest(keep) {
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

  const root = makeTempRoot();
  console.log('== measure.mjs 离线自测（' + TASK_VERSION + '）==');
  console.log('临时目录: ' + root);
  console.log('说明: 不联网、不读真实会话日志、不发起模型请求、不启动子进程');

  section('多帧 zstd 解码');
  check('三帧首尾拼接可全部解出', function () {
    const buffer = encodeFrames([{ n: 1 }, { n: 2 }, { n: 3 }]);
    const decoded = decodeZstdFrames(buffer);
    const rows = decoded.text.split('\n').filter(Boolean).map(function (line) { return JSON.parse(line); });
    assertDeepEqual(rows.map(function (row) { return row.n; }), [1, 2, 3]);
    if (decoded.frames < 3) throw new Error('应至少解出 3 帧，实际 ' + decoded.frames);
  });

  check('伪魔数前缀会被跳过，不影响后续真帧', function () {
    const buffer = encodeFrames([{ n: 1 }, { n: 2 }], { garbage: true });
    const decoded = decodeZstdFrames(buffer);
    const rows = decoded.text.split('\n').filter(Boolean).map(function (line) { return JSON.parse(line); });
    assertDeepEqual(rows.map(function (row) { return row.n; }), [1, 2]);
    if (decoded.skipped < 1) throw new Error('应至少有 1 个伪魔数偏移被跳过');
  });

  check('事件解析只保留契约允许的类型，坏行跳过', function () {
    const text = [
      JSON.stringify({ type: 'session', time: 1, data: {} }),
      JSON.stringify({ type: 'step/start', seq: 2, time: 2, data: { turn: 1, step: 1 } }),
      '{bad json',
      JSON.stringify({ type: 'tool/call', seq: 3, time: 3, data: { callId: 'c' } }),
    ].join('\n');
    const parsed = parseEvents(text);
    assertDeepEqual(parsed.events.map(function (event) { return event.type; }), ['step/start', 'tool/call']);
    if (parsed.filtered !== 1) throw new Error('filtered 应为 1');
    if (parsed.badLines !== 1) throw new Error('badLines 应为 1');
  });

  section('合成日志口径（任务开始 / 验收 / 请求 / 工具 / 环境指纹）');
  const base = 1000000;
  // agentPreset 只在会话首帧 session 头里，parseEvents 会按契约过滤掉该事件，因此单独解析后传入。
  const sessionHeaderText = JSON.stringify({
    type: 'session', version: 4, id: 'session-selftest', cwd: 'C:\\selftest', agentPreset: 'standard',
  }) + '\n';
  const sessionHeader = parseSessionHeaderFromText(sessionHeaderText);
  const analysis = analyzeEvents(syntheticEvents(base), {
    markerTime: base,
    finishTime: base + 30000,
    sessionHeader: sessionHeader,
  });
  const syntheticRun = {
    requests: analysis.requests,
    tools: analysis.tools,
    incompleteSteps: analysis.incompleteSteps,
  };
  const metrics = computeMetrics(syntheticRun);

  check('固定任务开始 = 第一个 >= markerTime 的 step/start', function () {
    if (analysis.startTime !== base + 1000) throw new Error('startTime=' + analysis.startTime);
  });

  check('验收时刻 = finish 之前最后一个 tool/result', function () {
    if (analysis.acceptanceTime !== base + 15000) throw new Error('acceptanceTime=' + analysis.acceptanceTime);
  });

  check('实际完成耗时 = 验收时刻 − 任务开始', function () {
    if (analysis.elapsedMs !== 14000) throw new Error('elapsedMs=' + analysis.elapsedMs);
  });

  check('开发请求 2 条、短总结 1 条（验收后最后一次含文本请求）', function () {
    if (metrics.devRequestCount !== 2) throw new Error('devRequestCount=' + metrics.devRequestCount);
    if (!metrics.hasSummaryRequest) throw new Error('未识别出短总结请求');
    if (metrics.summaryFirstResponseSeconds !== 0.1) throw new Error('summary ttft=' + metrics.summaryFirstResponseSeconds);
  });

  check('每请求同时给出整请求墙钟与两种对照口径，批量下发只影响 Σdt 对照', function () {
    const firstRequest = analysis.requests[0];
    if (Math.abs(firstRequest.requestWallSeconds - 4) > 1e-9) {
      throw new Error('r1 requestWallSeconds=' + firstRequest.requestWallSeconds);
    }
    if (Math.abs(firstRequest.streamSpanSeconds - 2.7) > 1e-9) {
      throw new Error('r1 streamSpanSeconds=' + firstRequest.streamSpanSeconds);
    }
    if (Math.abs(firstRequest.chunkDeltaSeconds - 0.2) > 1e-9) {
      throw new Error('r1 chunkDeltaSeconds=' + firstRequest.chunkDeltaSeconds);
    }
    if (firstRequest.chunkBatchingSuspected !== true) {
      throw new Error('chunkBatchingSuspected 应为 true（600 tokens ÷ 0.2s = 3000 tok/s > '
        + CHUNK_BATCHING_TPS_THRESHOLD + '）');
    }
    // 500 是阈值本身：200 tokens ÷ 0.4s 恰好等于 500，必须不触发（判定是 > 而不是 >=）
    const secondRequest = analysis.requests[1];
    if (Math.abs(secondRequest.requestWallSeconds - 1.9) > 1e-9) {
      throw new Error('r2 requestWallSeconds=' + secondRequest.requestWallSeconds);
    }
    if (Math.abs(secondRequest.streamSpanSeconds - 0.4) > 1e-9) {
      throw new Error('r2 streamSpanSeconds=' + secondRequest.streamSpanSeconds);
    }
    if (secondRequest.chunkBatchingSuspected !== false) {
      throw new Error('恰好 500 tok/s 不应判为批量下发');
    }
  });

  check('有效输出速度 = 800 ÷ 5.9 = 135.6 tok/s（整请求墙钟），跨度/Σdt 仅作对照', function () {
    if (metrics.outputTokens !== 800) throw new Error('outputTokens=' + metrics.outputTokens);
    if (Math.abs(metrics.requestWallSeconds - 5.9) > 1e-9) {
      throw new Error('requestWallSeconds=' + metrics.requestWallSeconds);
    }
    if (metrics.speedTps === null || Math.abs(metrics.speedTps - 800 / 5.9) > 1e-9) {
      throw new Error('speedTps=' + metrics.speedTps);
    }
    if (Math.abs(metrics.streamSpanSeconds - 3.1) > 1e-9) {
      throw new Error('streamSpanSeconds=' + metrics.streamSpanSeconds);
    }
    if (metrics.speedTpsStreamSpan === null || Math.abs(metrics.speedTpsStreamSpan - 800 / 3.1) > 1e-9) {
      throw new Error('speedTpsStreamSpan=' + metrics.speedTpsStreamSpan);
    }
    if (Math.abs(metrics.chunkDeltaSeconds - 0.6) > 1e-9) {
      throw new Error('chunkDeltaSeconds=' + metrics.chunkDeltaSeconds);
    }
    if (metrics.speedTpsChunkDeltas === null || Math.abs(metrics.speedTpsChunkDeltas - 800 / 0.6) > 1e-9) {
      throw new Error('speedTpsChunkDeltas=' + metrics.speedTpsChunkDeltas);
    }
    if (metrics.chunkBatchingSuspected !== true) throw new Error('聚合未标记批量下发');
  });

  check('缺 step/start 的请求不计入主速度：整体 unknown，跨度/Σdt 对照仍保留', function () {
    const events = syntheticEvents(base).filter(function (event) {
      return !(event.type === 'step/start' && event.data.step === 2);
    });
    const broken = analyzeEvents(events, { markerTime: base, finishTime: base + 30000, sessionHeader: sessionHeader });
    const brokenMetrics = computeMetrics({
      requests: broken.requests,
      tools: broken.tools,
      incompleteSteps: broken.incompleteSteps,
    });
    if (brokenMetrics.speedTps !== null) throw new Error('缺 step/start 不应给出主速度');
    if (brokenMetrics.speedUnknownReason !== 'time-incomplete') {
      throw new Error('reason=' + brokenMetrics.speedUnknownReason);
    }
    assertDeepEqual(brokenMetrics.speedMissingRequestIds, ['r2']);
    if (brokenMetrics.requestWallSeconds !== null) throw new Error('缺请求时不得给出部分 Σ墙钟');
    // 主速度未知不影响对照：跨度与 Σdt 仍然算得出来（只作对照，不顶替主指标）。
    if (Math.abs(brokenMetrics.streamSpanSeconds - 3.1) > 1e-9) {
      throw new Error('对照跨度=' + brokenMetrics.streamSpanSeconds);
    }
    if (Math.abs(brokenMetrics.chunkDeltaSeconds - 0.6) > 1e-9) {
      throw new Error('对照 Σdt=' + brokenMetrics.chunkDeltaSeconds);
    }
    if (brokenMetrics.speedTpsStreamSpan === null) throw new Error('对照速度应保留');
  });

  check('整请求口径优先于跨度与 Σdt：同一请求按墙钟算，绝不由对照回退', function () {
    const run = {
      requests: [{
        id: 'r1', purpose: 'dev', outputTokens: 600, usagePresent: true, requestComplete: true,
        requestWallSeconds: 4, streamSpanSeconds: 2.7, chunkDeltaSeconds: 0.2, chunkBatchingSuspected: true,
      }],
      tools: [],
      incompleteSteps: [],
    };
    const result = computeMetrics(run);
    if (Math.abs(result.speedTps - 600 / 4) > 1e-9) throw new Error('speedTps=' + result.speedTps);
    assertDeepEqual(result.speedMissingRequestIds, []);
    if (Math.abs(result.speedTpsStreamSpan - 600 / 2.7) > 1e-9) throw new Error('对照跨度速度=' + result.speedTpsStreamSpan);
    if (Math.abs(result.speedTpsChunkDeltas - 3000) > 1e-9) throw new Error('对照 Σdt 速度=' + result.speedTpsChunkDeltas);
  });

  check('环境指纹：字段齐全、工具名排序去重、哈希取 sha256 前 8 位且同输入同哈希', function () {
    if (!sessionHeader || sessionHeader.agentPreset !== 'standard') {
      throw new Error('未从会话首帧解析出 agentPreset：' + JSON.stringify(sessionHeader));
    }
    const fp = analysis.env.fingerprint;
    if (fp.provider !== 'provider-x' || fp.model !== 'model-y') {
      throw new Error('provider/model=' + JSON.stringify(fp));
    }
    if (fp.agentPreset !== 'standard') throw new Error('agentPreset=' + fp.agentPreset);
    assertDeepEqual(fp.toolNames, ['read', 'run_code', 'write']);
    if (fp.toolCount !== 3) throw new Error('toolCount=' + fp.toolCount);
    const expectedHash = crypto.createHash('sha256')
      .update('read\nrun_code\nwrite', 'utf8').digest('hex').slice(0, ENV_FINGERPRINT_HASH_LEN);
    if (fp.toolNamesHash !== expectedHash) {
      throw new Error('toolNamesHash=' + fp.toolNamesHash + '，期望 ' + expectedHash);
    }
    // 同输入同哈希：工具顺序不同、含重复项，指纹必须完全一致。
    const again = computeEnvFingerprint({
      provider: 'provider-x', model: 'model-y', agentPreset: 'standard',
      toolNames: ['write', 'read', 'run_code', 'write'],
    });
    if (again.toolNamesHash !== fp.toolNamesHash) throw new Error('同输入不同哈希');
    assertDeepEqual(again.toolNames, fp.toolNames);
    const expectedLine = expectedHash + ' · 3 个工具 · model-y · preset=standard';
    if (formatEnvFingerprint(fp) !== expectedLine) {
      throw new Error('指纹行=' + formatEnvFingerprint(fp) + '，期望 ' + expectedLine);
    }
    // 完全读不到时写「未知」，不拼出半截指纹。
    if (formatEnvFingerprint(computeEnvFingerprint({})) !== '未知') throw new Error('空指纹应写未知');
  });

  check('工具按 callId 配对：2 次 / 7.8 秒', function () {
    if (metrics.toolCount !== 2) throw new Error('toolCount=' + metrics.toolCount);
    if (metrics.toolMs !== 7800) throw new Error('toolMs=' + metrics.toolMs);
  });

  check('首次请求缓存 miss、短总结缓存 hit', function () {
    if (metrics.firstRequestCache.state !== 'miss') throw new Error('first=' + metrics.firstRequestCache.state);
    if (metrics.summaryCache.state !== 'hit' || metrics.summaryCache.cacheReadTokens !== 1920) {
      throw new Error('summary=' + JSON.stringify(metrics.summaryCache));
    }
  });

  check('provider/model 从 request/header 读取', function () {
    if (analysis.env.provider !== 'provider-x' || analysis.env.model !== 'model-y') {
      throw new Error(JSON.stringify(analysis.env));
    }
  });

  check('请求未完成时有效输出速度记未知（不估算）', function () {
    const events = syntheticEvents(base).filter(function (event) {
      return !(event.type === 'assistant/message' && event.data.step === 2);
    });
    const broken = analyzeEvents(events, { markerTime: base, finishTime: base + 30000 });
    const brokenMetrics = computeMetrics({
      requests: broken.requests,
      tools: broken.tools,
      incompleteSteps: broken.incompleteSteps,
    });
    if (brokenMetrics.speedTps !== null) throw new Error('未完成请求不应给出速度');
    if (brokenMetrics.speedUnknownReason !== 'request-incomplete') {
      throw new Error('reason=' + brokenMetrics.speedUnknownReason);
    }
  });

  section('缓存三态');
  check('hit / miss / unknown 与 cacheWriteTokens 不等于命中', function () {
    const hit = parseCacheState({ usagePresent: true, requestComplete: true, cacheSemanticsConfirmed: true, cacheReadTokens: 1920 });
    const miss = parseCacheState({ usagePresent: true, requestComplete: true, cacheSemanticsConfirmed: true, cacheReadTokens: 0, cacheWriteTokens: 4096 });
    const unknown = parseCacheState({ usagePresent: false, cacheReadTokens: 5000 });
    const writeOnly = parseCacheState({ usagePresent: true, requestComplete: true, cacheSemanticsConfirmed: true, cacheWriteTokens: 4096 });
    if (hit.state !== 'hit' || miss.state !== 'miss' || unknown.state !== 'unknown' || writeOnly.state !== 'unknown') {
      throw new Error('三态判定错误');
    }
  });

  section('越界检查与判定');
  check('模板原样时无越界，改 README / 新增文件会被发现', function () {
    const task = path.join(root, 'scope', 'task');
    fs.mkdirSync(path.dirname(task), { recursive: true });
    fs.cpSync(TEMPLATE_DIR, task, { recursive: true });
    assertDeepEqual(checkOutOfScope(task, TEMPLATE_DIR), []);
    fs.appendFileSync(path.join(task, 'README.md'), '\n越界\n');
    fs.writeFileSync(path.join(task, 'extra.txt'), 'x');
    const problems = checkOutOfScope(task, TEMPLATE_DIR);
    if (!problems.some(function (item) { return item.indexOf('README.md（被修改）') === 0; })) {
      throw new Error('未发现 README 被修改：' + problems.join(','));
    }
    if (!problems.some(function (item) { return item.indexOf('extra.txt（新增）') === 0; })) {
      throw new Error('未发现新增文件：' + problems.join(','));
    }
  });

  check('任务模板哈希稳定且覆盖需求、骨架、测试与 package.json', function () {
    const hash = computeTaskTemplateHash(TEMPLATE_DIR);
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('模板哈希应为完整 sha256');
    if (computeTaskTemplateHash(TEMPLATE_DIR) !== hash) throw new Error('同输入哈希不稳定');
    const copy = path.join(root, 'hash-template');
    fs.cpSync(TEMPLATE_DIR, copy, { recursive: true });
    for (const rel of ['README.md', 'package.json', 'src/summary.js', 'test/summary.test.js']) {
      const file = path.join(copy, rel);
      const original = fs.readFileSync(file);
      fs.appendFileSync(file, '\n// hash change\n');
      if (computeTaskTemplateHash(copy) === hash) throw new Error(rel + ' 内容变化后哈希必须变化');
      fs.writeFileSync(file, original);
    }
    if (computeTaskTemplateHash(copy) !== hash) throw new Error('恢复内容后哈希应恢复');
  });

  check('3 分钟硬上限：180000 通过、180001 超时；越界不得通过', function () {
    if (evaluateOutcome({ requested: 'pass', elapsedMs: 180000, outOfScopeChanges: [] }).outcome !== 'passed') {
      throw new Error('180000 应通过');
    }
    if (evaluateOutcome({ requested: 'pass', elapsedMs: 180001, outOfScopeChanges: [] }).outcome !== 'timeout') {
      throw new Error('180001 应超时');
    }
    if (evaluateOutcome({ requested: 'pass', elapsedMs: 1000, outOfScopeChanges: ['README.md（被修改）'] }).outcome !== 'failed') {
      throw new Error('越界不得通过');
    }
    if (evaluateOutcome({ requested: 'aborted', elapsedMs: 1000, outOfScopeChanges: [] }).outcome !== 'aborted') {
      throw new Error('aborted 应保持中断');
    }
  });

  section('start / finish / 锁');
  const wsBusy = path.join(root, 'ws-busy');
  fs.mkdirSync(wsBusy);
  const first = runStart({
    workspace: wsBusy,
    noSessionLog: true,
    environmentSnapshot: SELFTEST_ENVIRONMENT_SNAPSHOT,
  });
  check('start 创建 task、marker 与独占锁', function () {
    for (const rel of ['README.md', 'package.json', 'test/summary.test.js', 'src/summary.js']) {
      if (!fs.existsSync(path.join(first.taskDir, rel))) throw new Error('缺少 ' + rel);
    }
    if (!fs.existsSync(path.join(first.runDir, 'marker.json'))) throw new Error('缺少 marker.json');
    if (!fs.existsSync(first.lockPath)) throw new Error('缺少锁');
    const payload = JSON.parse(fs.readFileSync(first.lockPath, 'utf8'));
    if (payload.runId !== first.runId) throw new Error('锁 runId 不匹配');
    const marker = JSON.parse(fs.readFileSync(path.join(first.runDir, 'marker.json'), 'utf8'));
    if (!/^[0-9a-f]{64}$/.test(marker.taskTemplateHash)) throw new Error('marker 缺少 taskTemplateHash');
    if (!marker.environmentStart || marker.environmentStart.provider !== 'provider-x') {
      throw new Error('marker 缺少脱敏 start 环境快照');
    }
  });

  check('已有锁时 start 报 BUSY，且不覆盖原锁', function () {
    let busy = null;
    try {
      runStart({ workspace: wsBusy, noSessionLog: true });
    } catch (err) {
      busy = err;
    }
    if (!busy || busy.code !== 'BUSY') throw new Error('未报 BUSY');
    if (!busy.detail || !busy.detail.raw || busy.detail.raw.indexOf(first.runId) < 0) {
      throw new Error('BUSY 输出未包含现有锁内容');
    }
    const payload = JSON.parse(fs.readFileSync(first.lockPath, 'utf8'));
    if (payload.runId !== first.runId) throw new Error('原锁被覆盖');
  });

  check('finish 非持有者报 NOT-OWNER，且不删除锁', function () {
    let notOwner = null;
    try {
      runFinish({ workspace: wsBusy, run: 'someone-else', outcome: 'pass' });
    } catch (err) {
      notOwner = err;
    }
    if (!notOwner || notOwner.code !== 'NOT-OWNER') throw new Error('未报 NOT-OWNER');
    if (!fs.existsSync(first.lockPath)) throw new Error('不得删除别人的锁');
  });

  check('finish 写入 result.json / report.md 并释放自己的锁', function () {
    const logPath = path.join(root, 'e2e-session.zstd');
    fs.writeFileSync(logPath, encodeFrames(syntheticEvents(first.markerTime)));
    const finished = runFinish({
      workspace: wsBusy,
      run: first.runId,
      outcome: 'pass',
      sessionLog: logPath,
      finishTime: first.markerTime + 30000,
      environmentSnapshot: SELFTEST_ENVIRONMENT_SNAPSHOT,
    });
    if (finished.run.outcome !== 'passed') throw new Error('outcome=' + finished.run.outcome);
    if (finished.run.elapsedMs !== 14000) throw new Error('elapsedMs=' + finished.run.elapsedMs);
    if (!finished.run.lockReleased) throw new Error('锁未释放');
    if (fs.existsSync(first.lockPath)) throw new Error('锁文件仍在');
    for (const rel of ['result.json', 'report.md']) {
      if (!fs.existsSync(path.join(first.runDir, rel))) throw new Error('缺少 ' + rel);
    }
    if (finished.report.indexOf('| 有效输出速度 | 135.6 tok/s |') < 0) {
      throw new Error('报告缺少整请求墙钟口径的速度行');
    }
    if (finished.report.indexOf('| 模型请求耗时（含预填与思考） | 5.9 秒 |') < 0) {
      throw new Error('模型请求耗时未按 ΣrequestWallSeconds 渲染');
    }
    const expectedHash = crypto.createHash('sha256')
      .update('read\nrun_code\nwrite', 'utf8').digest('hex').slice(0, ENV_FINGERPRINT_HASH_LEN);
    // 这个合成日志没有 session 首帧，preset 只能写未知；工具清单仍然要读出来。
    if (finished.report.indexOf('- 环境指纹：' + expectedHash + ' · 3 个工具 · model-y · preset=未知') < 0) {
      throw new Error('报告缺少环境指纹行：\n' + finished.report);
    }
    if (finished.report.indexOf('对照：流式跨度口径 258.1 tok/s（受服务端缓冲影响，仅供参考）') < 0) {
      throw new Error('报告缺少跨度对照行');
    }
    if (finished.report.indexOf('对照：逐段 Σdt 口径 1333.3 tok/s（受服务端批量下发影响，仅供参考）') < 0) {
      throw new Error('报告缺少 Σdt 对照行');
    }
    if (finished.report.indexOf('对照明细：跨度合计 3.1 秒、Σdt 合计 0.6 秒') < 0) {
      throw new Error('报告缺少对照明细（跨度/Σdt 秒数）');
    }
    if (finished.report.indexOf('有请求疑似批量下发（大量 token 挤在同一个 SSE 包里），逐段 Σdt 口径会高估速度，只能作对照。') < 0) {
      throw new Error('报告缺少批量下发补充说明');
    }
    if (finished.report.indexOf('短总结命中了暖缓存') < 0) throw new Error('报告缺少通俗概括');
    if (finished.report.indexOf('| 短总结首响应时间 | 0.10 秒 |') < 0) throw new Error('报告缺少短总结首响应');
    const saved = JSON.parse(fs.readFileSync(path.join(first.runDir, 'result.json'), 'utf8'));
    if (saved.resultSchemaVersion !== 1 || saved.metricVersion !== 'v3-request-wall') {
      throw new Error('result.json 缺少结果/指标版本');
    }
    if (!/^[0-9a-f]{64}$/.test(saved.taskTemplateHash)) throw new Error('result.json 缺少模板哈希');
    if (!Array.isArray(saved.environmentFlags) || saved.environmentFlags.length !== 0) {
      throw new Error('相同快照不应产生环境异常标记：' + JSON.stringify(saved.environmentFlags));
    }
    if (!saved.environment || !saved.environment.start || !saved.environment.finish
      || !Array.isArray(saved.environment.changedFields) || !Array.isArray(saved.environment.attributionInvalidFields)) {
      throw new Error('result.json 缺少 start/finish 快照或分字段异常数组');
    }
    if (saved.env.channelAlias !== '渠道A' || saved.env.baseUrlHost !== 'api.example.com'
      || saved.env.keyAlias !== 'SYNTHETIC_KEY_ALIAS' || saved.env.dshVersion !== '44.7.0-test'
      || !Array.isArray(saved.env.plugins) || saved.env.plugins[0].version !== '1.0.0') {
      throw new Error('result.env 未保留最终脱敏环境身份：' + JSON.stringify(saved.env));
    }
    if (JSON.stringify(saved).includes('sk-') || finished.report.includes('sk-')) {
      throw new Error('结果或报告不得包含测试 Key 原文/前缀');
    }
    if (!saved.requests[0] || saved.requests[0].requestWallSeconds !== 4) {
      throw new Error('result.json 未记录逐请求 requestWallSeconds');
    }
    if (!saved.metrics || typeof saved.metrics.speedTps !== 'number') {
      throw new Error('result.json 缺少主速度 speedTps');
    }
    if (saved.metrics.speedTpsStreamSpan === undefined || saved.metrics.speedTpsChunkDeltas === undefined) {
      throw new Error('result.json 缺少对照口径字段');
    }
    if (!saved.env.fingerprint || saved.env.fingerprint.toolNamesHash !== expectedHash) {
      throw new Error('result.json 缺少 env.fingerprint 或哈希不一致');
    }
    for (const key of ['provider', 'model', 'agentPreset', 'toolCount', 'toolNamesHash', 'toolNames']) {
      if (!(key in saved.env.fingerprint)) throw new Error('env.fingerprint 缺少字段 ' + key);
    }
  });

  section('报告渲染');
  check('数据齐全时报告不出现「未知」', function () {
    const report = renderReport({
      taskVersion: TASK_VERSION,
      runId: '20261110-164304-1a2b3c4d',
      startedAt: '2026-11-10T16:43:04.000+08:00',
      outcome: 'passed',
      elapsedMs: 14000,
      env: {
        provider: 'provider-x',
        model: 'model-y',
        channelAlias: '渠道A',
        baseUrlHost: 'api.example.com',
        plugins: '插件组合A',
        reasoning: '低',
        dshVersion: '44.7.0-test',
        fingerprint: analysis.env.fingerprint,
      },
      requests: analysis.requests,
      tools: analysis.tools,
      incompleteSteps: [],
    });
    if (report.indexOf('未知') >= 0) throw new Error('完整数据不应出现未知：\n' + report);
    if (report.indexOf('| 实际完成耗时 | 14.0 秒 |') < 0) throw new Error('耗时不正确');
    if (report.indexOf('| 有效输出速度 | 135.6 tok/s |') < 0) throw new Error('主速度行不正确');
    if (report.indexOf('| 模型请求耗时（含预填与思考） | 5.9 秒 |') < 0) throw new Error('模型请求耗时行不正确');
    if (report.indexOf('- 环境指纹：') < 0) throw new Error('缺少环境指纹行');
    if (report.indexOf('对照：流式跨度口径') < 0) throw new Error('通过的报告应给出跨度对照');
  });

  check('报告分字段展示 environment-changed 与 attribution-invalid，但不回显配置值', function () {
    const report = renderReport({
      taskVersion: TASK_VERSION,
      taskTemplateHash: computeTaskTemplateHash(TEMPLATE_DIR),
      startedAt: '2026-11-10T16:43:04.000+08:00',
      outcome: 'passed',
      elapsedMs: 14000,
      environmentFlags: ['environment-changed', 'attribution-invalid'],
      environment: { changedFields: ['plugins'], attributionInvalidFields: ['model'] },
      env: {
        provider: 'provider-x', model: 'model-y', channelAlias: '渠道A', baseUrlHost: 'api.example.com',
        plugins: [{ id: 'plugin-a', version: '1.0.0' }], reasoning: { effort: 'low' }, dshVersion: '44.7.0-test',
        fingerprint: analysis.env.fingerprint,
      },
      requests: analysis.requests,
      tools: analysis.tools,
      incompleteSteps: [],
    });
    if (!report.includes('字段：plugins') || !report.includes('environment-changed')
      || !report.includes('字段：model') || !report.includes('attribution-invalid')) {
      throw new Error('报告缺少分字段环境异常标记');
    }
  });

  check('失败报告不把失败写成成功速度', function () {
    const report = renderReport({
      taskVersion: TASK_VERSION,
      startedAt: '2026-11-10T16:43:04.000+08:00',
      outcome: 'failed',
      failureReason: 'tests-not-passed',
      elapsedMs: 60000,
      env: {},
      requests: analysis.requests,
      tools: analysis.tools,
    });
    if (report.indexOf('| 任务结果 | 失败 |') < 0) throw new Error('未写失败');
    if (report.indexOf('未知（任务未通过，原始数据见 result.json）') < 0) throw new Error('失败仍给出速度');
    if (/\d+\.\d+ tok\/s/.test(report)) throw new Error('失败报告不得出现 tok/s');
  });

  check('超时报告标出 3 分钟硬上限', function () {
    const report = renderReport({
      taskVersion: TASK_VERSION,
      startedAt: '2026-11-10T16:43:04.000+08:00',
      outcome: 'timeout',
      failureReason: 'over-3-minutes',
      elapsedMs: 181000,
      env: {},
      requests: analysis.requests,
      tools: analysis.tools,
    });
    if (report.indexOf('181.0 秒（已超过 3 分钟硬上限）') < 0) throw new Error('未标出超时');
    if (/\d+\.\d+ tok\/s/.test(report)) throw new Error('超时报告不得出现 tok/s');
  });

  section('自包含检查');
  check('源码不含子进程 / 网络模块', function () {
    const source = fs.readFileSync(path.join(HERE, 'measure.mjs'), 'utf8');
    for (const bad of ['child' + '_process', 'node:' + 'http', 'node:' + 'https', 'node:' + 'net', 'fetch' + '(']) {
      if (source.indexOf(bad) >= 0) throw new Error('measure.mjs 不应包含 ' + bad);
    }
    for (const good of ["node:zlib", "node:fs", "node:path"]) {
      if (source.indexOf(good) < 0) throw new Error('measure.mjs 缺少 ' + good);
    }
  });

  console.log('');
  const total = passed + failures.length;
  console.log('== 结果：通过 ' + passed + ' / ' + total + ' ==');
  if (failures.length > 0) {
    console.log('失败项:');
    for (const item of failures) console.log('  - ' + item);
    return 1;
  }
  console.log('全部通过');
  if (keep) {
    console.log('临时目录已保留: ' + root);
    return 0;
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    console.log('清理临时目录失败（不影响结论）: ' + err.message);
  }
  return 0;
}

function assertDeepEqual(actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error('期望 ' + b + '，实际 ' + a);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  '用法：',
  '  node scripts/measure.mjs start --workspace <dir>',
  '  node scripts/measure.mjs finish --workspace <dir> --run <runId> --outcome <pass|fail|timeout|aborted> [--session-log <file>]',
  '  node scripts/measure.mjs selftest [--keep]',
].join('\n');

function main(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === 'help') {
    console.log(USAGE);
    return 2;
  }
  const args = parseArgs(argv.slice(1));

  if (command === 'start') {
    const info = runStart({ workspace: args.workspace, dshHome: args['dsh-home'], sessionLog: args['session-log'] });
    console.log(JSON.stringify(info));
    return 0;
  }

  if (command === 'finish') {
    const result = runFinish({
      workspace: args.workspace,
      run: args.run,
      outcome: args.outcome,
      sessionLog: args['session-log'],
      dshHome: args['dsh-home'],
    });
    console.log(JSON.stringify(result.summary));
    console.log('');
    console.log(result.report);
    return 0;
  }

  if (command === 'selftest') {
    return runSelftest(argv.indexOf('--keep') >= 0);
  }

  console.error('[measure] 未知子命令：' + command);
  console.error(USAGE);
  return 2;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err && err.code === 'BUSY') {
      console.log('BUSY');
      console.log(err.detail && err.detail.raw ? err.detail.raw : '(无法读取现有锁内容)');
      process.exitCode = 3;
    } else if (err && err.code === 'NOT-OWNER') {
      console.log('NOT-OWNER');
      console.log(err.detail && err.detail.raw ? err.detail.raw : '(无法读取现有锁内容)');
      process.exitCode = 4;
    } else {
      console.error('[measure] ' + (err && err.message ? err.message : String(err)));
      process.exitCode = 1;
    }
  }
}
