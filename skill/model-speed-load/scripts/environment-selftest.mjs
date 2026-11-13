#!/usr/bin/env node
// environment.mjs 离线自测：全部使用临时合成配置，不读真实 DSH 配置、不联网、不发请求。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  UNKNOWN,
  captureEnvironmentSnapshot,
  sanitizeEnvironmentSnapshot,
  compareEnvironmentSnapshots,
  extractBaseUrlHost,
  fingerprintSecret,
  parseSimpleYaml,
} from './environment.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'msl-environment-'));
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  [ok]   ' + name);
  } catch (err) {
    failures.push(name + ' -> ' + err.message);
    console.log('  [FAIL] ' + name);
    console.log(err.stack || err.message);
  }
}

function makeConfig() {
  const profileDir = path.join(root, 'profile');
  fs.mkdirSync(path.join(profileDir, 'node_modules', 'plugin-on'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'node_modules', 'plugin-on', 'package.json'), JSON.stringify({
    name: 'plugin-on', version: '1.2.3',
  }));
  const base = [
    '- id: providers',
    '  name: llm-pi-ai',
    '  config:',
    '    providers:',
    '      route-a:',
    '        displayName: 渠道 A',
    '        apiKeyEnv: SYNTHETIC_KEY_ALIAS',
    '        baseURL: "https://user:password@api.example.com/v1?apiKey=sk-url-secret-123456"',
    '- id: plugin-off',
    '  name: plugin-off',
    '  config:',
    '    enabled: true',
    '',
  ].join('\n');
  const patch = [
    '- id: selection',
    '  name: model-selection',
    '  config:',
    '    provider: route-a',
    '    model: model-a',
    '    reasoningEffort: high',
    '- id: providers',
    '  name: llm-pi-ai',
    '  config:',
    '    providers:',
    '      route-a:',
    '        displayName: 渠道 A2 # patch 深度合并',
    '- id: plugin-off',
    '  name: plugin-off',
    '  config:',
    '    enabled: false',
    '- id: plugin-on',
    '  name: plugin-on',
    '  config: {}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(profileDir, 'cordis.yml'), base);
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch);
  return { profileDir: profileDir, base: base, patch: patch };
}

console.log('== environment.mjs 离线自测 ==');
console.log('临时目录: ' + root);
console.log('说明: 不读真实 DSH 配置、不联网、不发起模型请求、不启动子进程');

check('Cordis block YAML 可解析数组、嵌套 map、布尔、注释与 URL 标量', function () {
  const parsed = parseSimpleYaml('- id: one\n  config:\n    enabled: true\n    url: https://example.com/a?b=c#d\n');
  assert.equal(parsed[0].id, 'one');
  assert.equal(parsed[0].config.enabled, true);
  assert.equal(parsed[0].config.url, 'https://example.com/a?b=c#d');
  assert.deepEqual(parseSimpleYaml('[] # 空配置\n'), []);
});

check('配置快照提取 provider/model、渠道、主机、Key 别名、preset、插件版本、工具与版本', function () {
  const config = makeConfig();
  const before = fs.readFileSync(path.join(config.profileDir, 'cordis.patch.yml'), 'utf8');
  const snapshot = captureEnvironmentSnapshot({
    profileDir: config.profileDir,
    env: {},
    dshVersionFile: path.join(root, 'missing-version'),
    dshVersion: '44.7.0-test',
    taskVersion: 'dev-short-v1',
    agentPreset: 'standard',
    toolNames: ['write', 'read', 'write'],
  });
  assert.equal(snapshot.provider, 'route-a');
  assert.equal(snapshot.model, 'model-a');
  assert.equal(snapshot.channelAlias, '渠道 A2');
  assert.equal(snapshot.baseUrlHost, 'api.example.com');
  assert.equal(snapshot.keyAlias, 'SYNTHETIC_KEY_ALIAS');
  assert.equal(snapshot.keyFingerprint, UNKNOWN);
  assert.equal(snapshot.agentPreset, 'standard');
  assert.equal(snapshot.reasoning, 'high');
  assert.equal(snapshot.dshVersion, '44.7.0-test');
  assert.equal(snapshot.taskVersion, 'dev-short-v1');
  assert.deepEqual(snapshot.toolNames, ['read', 'write']);
  assert.equal(snapshot.toolCount, 2);
  assert.match(snapshot.toolNamesHash, /^[0-9a-f]{8}$/);
  const plugin = snapshot.plugins.find(function (item) { return item.id === 'plugin-on'; });
  assert.equal(plugin.version, '1.2.3');
  assert.ok(!snapshot.plugins.some(function (item) { return item.id === 'plugin-off'; }), '禁用插件不得列入');
  assert.equal(fs.readFileSync(path.join(config.profileDir, 'cordis.patch.yml'), 'utf8'), before, '配置只能只读');
});

check('baseURL 仅保留 hostname，不保留端口、路径、userinfo 或查询参数', function () {
  assert.equal(extractBaseUrlHost('https://alice:secret@Example.COM:8443/v1?token=abc'), 'example.com');
  assert.equal(extractBaseUrlHost('not a url'), UNKNOWN);
  assert.equal(extractBaseUrlHost('file:///tmp/secret'), UNKNOWN);
});

check('无 Key 别名时只写不可逆 SHA-256 指纹，secret 原文不进入 JSON', function () {
  const secret = 'sk-direct-secret-0123456789abcdef';
  const snapshot = captureEnvironmentSnapshot({
    configEntries: [
      { id: 'selection', config: { provider: 'route-a', model: 'model-a' } },
      { id: 'providers', config: { providers: { 'route-a': {
        baseURL: 'https://api.example.com/v1', apiKey: secret,
      } } } },
    ],
    env: {},
    dshVersion: 'test',
    taskVersion: 'dev-short-v1',
  });
  const expected = 'sha256:' + crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
  assert.equal(snapshot.keyFingerprint, expected);
  assert.equal(snapshot.keyAlias, UNKNOWN);
  assert.equal(fingerprintSecret(secret), expected);
  assert.ok(!JSON.stringify(snapshot).includes(secret));
  assert.ok(!JSON.stringify(snapshot).includes('0123456789abcdef'));
});

check('严格白名单与通用掩码：配置对象、secret 字段和插件额外字段不会外泄', function () {
  const secret = 'sk-sensitive-abcdefghijklmnop';
  const snapshot = sanitizeEnvironmentSnapshot({
    provider: 'route-a', model: 'model-a', channelAlias: secret,
    keyAlias: 'token=' + secret,
    reasoning: { effort: 'high', apiKey: secret, nested: { secret: secret } },
    plugins: [{ id: 'p', version: '1.0.0', config: { apiKey: secret } }],
    toolNames: ['read'], apiKey: secret,
  });
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('abcdefghijklmnop'));
  assert.ok(!serialized.includes('nested'));
  assert.deepEqual(snapshot.reasoning, { effort: 'high' });
  assert.deepEqual(snapshot.plugins, [{ id: 'p', version: '1.0.0' }]);
  assert.ok(!Object.prototype.hasOwnProperty.call(snapshot, 'apiKey'));
});

check('完全不可读时所有字段为 unknown；unknown 不会伪装成空插件或空工具清单', function () {
  const snapshot = captureEnvironmentSnapshot({ profileDir: path.join(root, 'missing'), env: {}, dshVersion: UNKNOWN });
  for (const field of Object.keys(snapshot)) assert.equal(snapshot[field], UNKNOWN, field);
});

check('start/finish 变化按字段列出并设置 environment-changed', function () {
  const start = sanitizeEnvironmentSnapshot({ provider: 'p', model: 'm', toolNames: ['read'] });
  const finish = sanitizeEnvironmentSnapshot({ provider: 'p', model: 'm2', toolNames: ['read', 'write'] });
  const result = compareEnvironmentSnapshots(start, finish, { provider: 'p', model: 'm2' });
  assert.deepEqual(result.changedFields, ['model', 'toolCount', 'toolNames', 'toolNamesHash']);
  assert.deepEqual(result.attributionInvalidFields, []);
  assert.deepEqual(result.flags, ['environment-changed']);
});

check('配置声明与日志实际身份冲突按 provider/model 分字段标记', function () {
  const snapshot = sanitizeEnvironmentSnapshot({ provider: 'configured-p', model: 'configured-m' });
  const result = compareEnvironmentSnapshots(snapshot, snapshot, { provider: 'actual-p', model: 'configured-m' });
  assert.deepEqual(result.changedFields, []);
  assert.deepEqual(result.attributionInvalidFields, ['provider']);
  assert.deepEqual(result.flags, ['attribution-invalid']);
});

check('unknown 不参与身份冲突判断，两类异常可同时存在', function () {
  const start = sanitizeEnvironmentSnapshot({ provider: UNKNOWN, model: 'm1' });
  const finish = sanitizeEnvironmentSnapshot({ provider: UNKNOWN, model: 'm2' });
  const result = compareEnvironmentSnapshots(start, finish, { provider: 'actual-p', model: 'actual-m' });
  assert.deepEqual(result.attributionInvalidFields, ['model']);
  assert.deepEqual(result.flags, ['environment-changed', 'attribution-invalid']);
  const noActual = compareEnvironmentSnapshots(snapshotWithUnknown(), snapshotWithUnknown(), { provider: UNKNOWN, model: UNKNOWN });
  assert.deepEqual(noActual.attributionInvalidFields, []);
});

function snapshotWithUnknown() {
  return sanitizeEnvironmentSnapshot({ provider: UNKNOWN, model: UNKNOWN });
}

console.log('');
console.log('== 结果：通过 ' + passed + ' / ' + (passed + failures.length) + ' ==');
if (failures.length > 0) {
  for (const failure of failures) console.log('  - ' + failure);
}
try {
  if (!process.argv.includes('--keep')) fs.rmSync(root, { recursive: true, force: true });
  else console.log('临时目录已保留: ' + root);
} catch (err) {
  console.log('清理临时目录失败（不影响结论）: ' + err.message);
}
process.exitCode = failures.length > 0 ? 1 : 0;
