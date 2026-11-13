#!/usr/bin/env node
// model-speed-load · 环境身份快照（只读、离线、严格脱敏）
//
// 只用 Node 内置模块。配置值不会整体复制到结果中；只保留固定白名单字段。
// API Key / token 等原文的唯一可能出口是不可逆 SHA-256 指纹，且优先使用已有别名。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const UNKNOWN = 'unknown';
export const ENVIRONMENT_CHANGED = 'environment-changed';
export const ATTRIBUTION_INVALID = 'attribution-invalid';
export const ENVIRONMENT_SNAPSHOT_FIELDS = Object.freeze([
  'provider',
  'model',
  'channelAlias',
  'baseUrlHost',
  'keyAlias',
  'keyFingerprint',
  'agentPreset',
  'reasoning',
  'plugins',
  'toolCount',
  'toolNames',
  'toolNamesHash',
  'dshVersion',
  'taskVersion',
]);

const SECRET_PATTERNS = [
  /(sk-)[A-Za-z0-9_-]{6,}/gi,
  /(ak-)[A-Za-z0-9_-]{6,}/gi,
  /(Bearer\s+)[A-Za-z0-9._-]{6,}/gi,
  /(api[_-]?key|token|password|secret)(\s*[:=]\s*)[^\s,;]+/gi,
  /(eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})/g,
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null;
  let text = String(value).trim();
  if (!text) return null;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '$1***');
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, 300);
}

function known(value) {
  return value !== null && value !== undefined && value !== UNKNOWN;
}

function unknownSnapshot() {
  return {
    provider: UNKNOWN,
    model: UNKNOWN,
    channelAlias: UNKNOWN,
    baseUrlHost: UNKNOWN,
    keyAlias: UNKNOWN,
    keyFingerprint: UNKNOWN,
    agentPreset: UNKNOWN,
    reasoning: UNKNOWN,
    plugins: UNKNOWN,
    toolCount: UNKNOWN,
    toolNames: UNKNOWN,
    toolNamesHash: UNKNOWN,
    dshVersion: UNKNOWN,
    taskVersion: UNKNOWN,
  };
}

export function extractBaseUrlHost(value) {
  if (typeof value !== 'string' || !value.trim()) return UNKNOWN;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return UNKNOWN;
    return parsed.hostname ? parsed.hostname.toLowerCase() : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

export function fingerprintSecret(value) {
  if (typeof value !== 'string' || !value.trim()) return UNKNOWN;
  const secret = value.trim();
  if (/^(?:<redacted>|\[redacted\]|\*+|unknown)$/i.test(secret)) return UNKNOWN;
  return 'sha256:' + crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function normalizeReasoning(value, depth) {
  if (value === null || value === undefined) return UNKNOWN;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return cleanText(value) || UNKNOWN;
  }
  if (!isObject(value) || (depth || 0) >= 2) return UNKNOWN;
  const allowed = new Set([
    'enabled', 'effort', 'reasoningEffort', 'mode', 'temperature', 'topP',
    'maxTokens', 'maxOutputTokens', 'budgetTokens',
  ]);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) continue;
    const item = value[key];
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') continue;
    const safe = cleanText(item);
    if (safe !== null) out[key] = safe;
  }
  return Object.keys(out).length > 0 ? out : UNKNOWN;
}

function normalizePlugins(value) {
  if (!Array.isArray(value)) return UNKNOWN;
  const byId = new Map();
  for (const item of value) {
    if (!isObject(item)) continue;
    const id = cleanText(item.id) || cleanText(item.name) || UNKNOWN;
    const version = cleanText(item.version) || UNKNOWN;
    byId.set(id, { id: id, version: version });
  }
  return Array.from(byId.values()).sort(function (a, b) { return a.id.localeCompare(b.id); });
}

function normalizeTools(toolNames) {
  if (!Array.isArray(toolNames)) {
    return { toolCount: UNKNOWN, toolNames: UNKNOWN, toolNamesHash: UNKNOWN };
  }
  const seen = new Set();
  for (const item of toolNames) {
    const raw = isObject(item) ? item.name : item;
    const name = cleanText(raw);
    if (name) seen.add(name);
  }
  const names = Array.from(seen).sort();
  return {
    toolCount: names.length,
    toolNames: names,
    toolNamesHash: crypto.createHash('sha256').update(names.join('\n'), 'utf8').digest('hex').slice(0, 8),
  };
}

export function sanitizeEnvironmentSnapshot(input) {
  const source = isObject(input) ? input : {};
  const out = unknownSnapshot();
  for (const key of ['provider', 'model', 'channelAlias', 'baseUrlHost', 'keyAlias', 'agentPreset', 'dshVersion', 'taskVersion']) {
    out[key] = cleanText(source[key]) || UNKNOWN;
  }
  out.baseUrlHost = known(source.baseUrlHost) ? extractBaseUrlHost('http://' + String(source.baseUrlHost)) : UNKNOWN;
  out.keyFingerprint = typeof source.keyFingerprint === 'string'
    && /^sha256:[0-9a-f]{64}$/i.test(source.keyFingerprint)
    ? source.keyFingerprint.toLowerCase()
    : UNKNOWN;
  out.reasoning = normalizeReasoning(source.reasoning, 0);
  out.plugins = normalizePlugins(source.plugins);
  Object.assign(out, normalizeTools(source.toolNames));
  if (source.toolNamesHash === UNKNOWN && source.toolNames === UNKNOWN) out.toolNamesHash = UNKNOWN;
  return out;
}

// ---------------------------------------------------------------------------
// 小型 YAML 读取器：仅支持 Cordis 配置实际使用的 block map / array / 标量。
// 不支持的多行、锚点、标签等直接失败；调用方会把配置字段记为 unknown，而不是猜测。
// ---------------------------------------------------------------------------

function stripYamlComment(text) {
  let single = false;
  let double = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single && text[i - 1] !== '\\') double = !double;
    else if (ch === '#' && !single && !double && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text;
}

function parseScalar(text) {
  const value = text.trim();
  if (value === '') return null;
  if (/^(?:\||>|[&*!])/.test(value)) throw new Error('unsupported YAML scalar');
  if (value.startsWith('"')) {
    const parsed = JSON.parse(value);
    if (typeof parsed !== 'string') throw new Error('invalid YAML string');
    return parsed;
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error('invalid YAML string');
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === 'null' || value === 'Null' || value === 'NULL' || value === '~') return null;
  if (/^(?:true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function splitMapping(text) {
  let single = false;
  let double = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !double) single = !single;
    else if (ch === '"' && !single && text[i - 1] !== '\\') double = !double;
    else if (ch === ':' && !single && !double && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      let key = text.slice(0, i).trim();
      if (!key) return null;
      if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
        key = key.slice(1, -1);
      }
      return { key: key, value: text.slice(i + 1).trim() };
    }
  }
  return null;
}

export function parseSimpleYaml(text) {
  const tokens = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    if (/^\s*(?:#|$)/.test(raw) || /^\s*(?:---|\.\.\.)\s*$/.test(raw)) continue;
    if (/^\s*\t/.test(raw)) throw new Error('tabs are not supported');
    const indent = raw.match(/^ */)[0].length;
    const content = stripYamlComment(raw.slice(indent));
    if (content.trim()) tokens.push({ indent: indent, text: content.trim() });
  }
  if (tokens.length === 0) return null;
  // 空配置常写成一行 []；单行 flow scalar 也属于合法配置。
  if (tokens.length === 1 && !/^-(?:\s|$)/.test(tokens[0].text) && !splitMapping(tokens[0].text)) {
    return parseScalar(tokens[0].text);
  }

  function parsePair(pair, indent, index) {
    if (!pair) throw new Error('invalid YAML mapping');
    if (pair.value !== '') return { value: parseScalar(pair.value), index: index };
    if (index < tokens.length && tokens[index].indent > indent) return parseBlock(index, tokens[index].indent);
    return { value: null, index: index };
  }

  function parseMap(index, indent) {
    const out = {};
    while (index < tokens.length && tokens[index].indent === indent && !/^-(?:\s|$)/.test(tokens[index].text)) {
      const pair = splitMapping(tokens[index].text);
      const parsed = parsePair(pair, indent, index + 1);
      out[pair.key] = parsed.value;
      index = parsed.index;
    }
    return { value: out, index: index };
  }

  function parseArray(index, indent) {
    const out = [];
    while (index < tokens.length && tokens[index].indent === indent && /^-(?:\s|$)/.test(tokens[index].text)) {
      const rest = tokens[index].text.replace(/^-(?:\s|$)/, '');
      index += 1;
      if (!rest) {
        if (index < tokens.length && tokens[index].indent > indent) {
          const parsed = parseBlock(index, tokens[index].indent);
          out.push(parsed.value);
          index = parsed.index;
        } else out.push(null);
        continue;
      }
      const pair = splitMapping(rest);
      if (!pair) {
        out.push(parseScalar(rest));
        continue;
      }
      const itemIndent = indent + 2;
      const item = {};
      const first = parsePair(pair, itemIndent, index);
      item[pair.key] = first.value;
      index = first.index;
      if (index < tokens.length && tokens[index].indent === itemIndent && !/^-(?:\s|$)/.test(tokens[index].text)) {
        const remaining = parseMap(index, itemIndent);
        Object.assign(item, remaining.value);
        index = remaining.index;
      }
      out.push(item);
    }
    return { value: out, index: index };
  }

  function parseBlock(index, indent) {
    return /^-(?:\s|$)/.test(tokens[index].text) ? parseArray(index, indent) : parseMap(index, indent);
  }

  const parsed = parseBlock(0, tokens[0].indent);
  if (parsed.index !== tokens.length) throw new Error('unsupported YAML indentation');
  return parsed.value;
}

function readConfigFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (/^\s*[\[{]/.test(text)) return JSON.parse(text);
  return parseSimpleYaml(text);
}

function mergeValues(base, patch) {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out = Object.assign({}, base);
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(base[key]) ? mergeValues(base[key], value) : value;
  }
  return out;
}

function mergeEntries(base, patch) {
  const byId = new Map();
  for (const entry of (Array.isArray(base) ? base : []).concat(Array.isArray(patch) ? patch : [])) {
    if (!isObject(entry)) continue;
    const id = cleanText(entry.id) || cleanText(entry.name);
    if (!id) continue;
    byId.set(id, byId.has(id) ? mergeValues(byId.get(id), entry) : entry);
  }
  return Array.from(byId.values());
}

function resolveProfileDir(options, env) {
  if (options.profileDir) return path.resolve(String(options.profileDir));
  if (env.DSH_PROFILE_DIR) return path.resolve(String(env.DSH_PROFILE_DIR));
  const dshHome = options.dshHome || env.DSH_HOME;
  if (!dshHome) return null;
  return path.join(path.resolve(String(dshHome)), 'profiles', String(env.DSH_PROFILE || 'desktop'));
}

function loadEntries(profileDir) {
  if (!profileDir) return null;
  let found = false;
  let entries = [];
  for (const name of ['cordis.yml', 'cordis.yaml', 'cordis.patch.yml', 'cordis.patch.yaml']) {
    const file = path.join(profileDir, name);
    if (!fs.existsSync(file)) continue;
    found = true;
    const parsed = readConfigFile(file);
    if (!Array.isArray(parsed)) throw new Error('Cordis config is not an array');
    entries = mergeEntries(entries, parsed);
  }
  return found ? entries : null;
}

function findSelection(entries) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const config = entries[i] && entries[i].config;
    if (isObject(config) && cleanText(config.provider) && cleanText(config.model)) return config;
  }
  return {};
}

function findProvider(entries, provider) {
  if (!provider) return {};
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const config = entry && entry.config;
    if (!isObject(config)) continue;
    if (isObject(config.providers) && isObject(config.providers[provider])) return config.providers[provider];
    if ((cleanText(entry.id) === provider || cleanText(config.provider) === provider)
      && (config.baseURL !== undefined || config.baseUrl !== undefined || config.apiKeyEnv !== undefined)) return config;
  }
  return {};
}

function pluginVersion(profileDir, name) {
  if (!profileDir || typeof name !== 'string') return UNKNOWN;
  const trimmed = name.trim();
  if (!/^(?:@[^/\\]+\/)?[^/\\]+$/.test(trimmed) || trimmed.includes('..')) return UNKNOWN;
  try {
    const file = path.join(profileDir, 'node_modules', ...trimmed.split('/'), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cleanText(pkg.version) || UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

function enabledPlugins(entries, profileDir) {
  if (!Array.isArray(entries)) return UNKNOWN;
  return entries.filter(function (entry) {
    return isObject(entry) && !(isObject(entry.config) && entry.config.enabled === false);
  }).map(function (entry) {
    return {
      id: cleanText(entry.id) || cleanText(entry.name) || UNKNOWN,
      version: pluginVersion(profileDir, entry.name),
    };
  });
}

function readDshVersion(options, env) {
  const direct = cleanText(options.dshVersion || env.DSH_VERSION || env.DSH_APP_VERSION);
  if (direct) return direct;
  const candidates = [];
  if (options.dshVersionFile) candidates.push(String(options.dshVersionFile));
  if (env.DSH_INSTALL_DIR) candidates.push(path.join(String(env.DSH_INSTALL_DIR), 'version'));
  if (process.platform === 'win32') {
    candidates.push('D:\\DeepSeek Harness\\version');
    if (env.LOCALAPPDATA) candidates.push(path.join(String(env.LOCALAPPDATA), 'Programs', 'DeepSeek Harness', 'version'));
  }
  for (const file of candidates) {
    try {
      if (!fs.statSync(file).isFile()) continue;
      const value = fs.readFileSync(file, 'utf8').trim();
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) return value;
    } catch {
      // 版本不可得就是 unknown。
    }
  }
  return UNKNOWN;
}

export function captureEnvironmentSnapshot(options) {
  const opts = isObject(options) ? options : {};
  const env = opts.env || process.env || {};
  const profileDir = resolveProfileDir(opts, env);
  let entries = null;
  if (Array.isArray(opts.configEntries)) entries = opts.configEntries;
  else {
    try { entries = loadEntries(profileDir); } catch { entries = null; }
  }

  const selection = entries ? findSelection(entries) : {};
  const providerName = cleanText(selection.provider);
  const provider = entries ? findProvider(entries, providerName) : {};
  const keyAlias = cleanText(provider.apiKeyEnv || provider.apiKeyRef || provider.keyAlias || provider.credentialAlias);
  const directSecret = typeof provider.apiKey === 'string'
    ? provider.apiKey
    : (typeof provider.token === 'string' ? provider.token : null);
  const reasoning = selection.reasoning !== undefined ? selection.reasoning
    : (selection.reasoningEffort !== undefined ? selection.reasoningEffort
      : (provider.reasoning !== undefined ? provider.reasoning : provider.reasoningEffort));

  return sanitizeEnvironmentSnapshot({
    provider: providerName || UNKNOWN,
    model: cleanText(selection.model) || UNKNOWN,
    channelAlias: cleanText(provider.displayName || provider.channelAlias) || providerName || UNKNOWN,
    baseUrlHost: extractBaseUrlHost(provider.baseURL || provider.baseUrl),
    keyAlias: keyAlias || UNKNOWN,
    keyFingerprint: keyAlias ? UNKNOWN : fingerprintSecret(directSecret),
    agentPreset: cleanText(opts.agentPreset) || UNKNOWN,
    reasoning: reasoning,
    plugins: enabledPlugins(entries, profileDir),
    toolNames: opts.toolNames,
    dshVersion: readDshVersion(opts, env),
    taskVersion: cleanText(opts.taskVersion) || UNKNOWN,
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function compareEnvironmentSnapshots(startInput, finishInput, actualInput) {
  const start = sanitizeEnvironmentSnapshot(startInput);
  const finish = sanitizeEnvironmentSnapshot(finishInput);
  const actual = isObject(actualInput) ? actualInput : {};
  const changedFields = ENVIRONMENT_SNAPSHOT_FIELDS.filter(function (field) {
    return stableStringify(start[field]) !== stableStringify(finish[field]);
  });
  const attributionInvalidFields = [];
  for (const field of ['provider', 'model']) {
    const declared = cleanText(finish[field]);
    const actualValue = cleanText(actual[field]);
    if (declared && declared !== UNKNOWN && actualValue && actualValue !== UNKNOWN && declared !== actualValue) {
      attributionInvalidFields.push(field);
    }
  }
  const flags = [];
  if (changedFields.length > 0) flags.push(ENVIRONMENT_CHANGED);
  if (attributionInvalidFields.length > 0) flags.push(ATTRIBUTION_INVALID);
  return {
    start: start,
    finish: finish,
    changedFields: changedFields,
    attributionInvalidFields: attributionInvalidFields,
    flags: flags,
  };
}
