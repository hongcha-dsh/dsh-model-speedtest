# model-speedtest 插件实现契约（v1）

本文件是 Host 半侧与 Client 半侧并行实现的唯一接口依据。改动接口先改本文件并通知 Lead。

## 0. 产品边界

- 插件包名：`@local/model-speedtest`，目录：`D:\ai工作区\技术专家\model-speedtest-plugin`。
- 测量内核：`D:\DSH-Home\skills\model-speed-load`（下称 skill）。插件不重写 `measure.mjs`，不解析会话日志，不改单轮报告。
- 一次批次 = 同一环境串行 N 轮。每轮是全新 DSH 会话、独立 run。
- 每轮会话的 cwd 固定为**所选工作区**（DSH 按 session 头 cwd 归组；子目录会被算进“未分类”工作区）。
  每轮真正的独立工作目录由 skill 在工作区 `.speedtest/<runId>` 下创建，轮与轮之间不共享任务文件。
- 插件**不注册模型可见工具**（避免改变被测环境的工具清单）。触发方式只有：`/speedtest` 命令 + 客户端按钮/面板。
- 不修改全局 provider/model/Key/preset/插件配置；不自动 A/B；不自动重试失败的轮次。

## 1. 包清单

`package.json` 必须包含：

```json
{
  "name": "@local/model-speedtest",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "icon": "./icon.svg",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "client.js", "lib", "cordis.patch.yml", "locale/*.json", "icon.svg", "MANUAL.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  },
  "peerDependencies": {
    "@deepseek-ai/dsh-agent": "^0.2.0-rc.1",
    "@deepseek-ai/dsh-home-paths": "^0.2.0-rc.1"
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: model-speedtest
      name: '@local/model-speedtest'
```

## 2. Host 入口

`index.js` 导出：

```js
export const name = 'model-speedtest'
export const inject = ['connection', 'agents', 'sessions', 'commands']
export const Config = /* schemastery 或普通 schema，见 §3 */
export function apply(ctx, config) { /* 装配 service、routes、command */ }
```

- `agentPresets` / `permissionPresets` 用 `ctx.get(...)` 可选读取，不写进 `inject`。
- 所有注册走 `ctx.effect`；卸载时取消活跃批次、dispose 已创建 agent、释放锁。
- 允许 import `@deepseek-ai/dsh-agent` 的 `installModelSelection`、`@deepseek-ai/dsh-home-paths` 的 `dshHomePath`。

### 2.1 Config

```js
workspaceRoot: ''        // 空 = 控制会话 cwd；非空必须是绝对路径或可展开的 ~ 路径
defaultRounds: 3
maxRounds: 9
runTimeoutMinutes: 10
```

## 3. Host 服务行为

### 3.1 环境快照（批次开始时一次）

- provider/model/reasoningEffort：`controlAgent.model.current()`。
- agentPreset：`ctx.get('agentPresets')?.presetForSession(controlSession)`。
- permissionPreset：`ctx.get('permissionPresets')?.current(controlSession)`。
- 默认工作区：Config.workspaceRoot（非空）否则 `controlSession.header.cwd`。
- skill 目录：`dshHomePath('skills/model-speed-load')`；记录 `skillHash`（SKILL.md + scripts/measure.mjs 的 sha256 前 16 位）和 `taskVersion`（若可读）。

### 3.2 前置检查（失败不启动，返回明确错误）

| code | 条件 |
| --- | --- |
| `SESSION-NOT-FOUND` | 控制会话/agent 不存在 |
| `NO-MODEL` | `agent.model.current()` 无 provider+model |
| `SKILL-MISSING` | skill 目录或 measure.mjs 不存在 |
| `BAD-ROUNDS` | rounds < 2 或 > maxRounds |
| `WORKSPACE-INVALID` | 工作区无法创建/不可写 |
| `BUSY` | 同一 workspaceRoot 已有活跃批次锁 |

### 3.3 建会话（每轮）

```js
const composition = await composePreset(agentPreset) // resolve + mount + installModelSelection
const handle = await ctx.agents.create({
  sessionId: 'session-' + randomUUID(),
  agentOptions: { provider, model, reasoningEffort },
  meta: { cwd: workspaceRoot, ...(agentPreset ? { agentPreset } : {}) }, // 会话归到所选工作区
// 本轮 run 目录由 skill 的 measure.mjs start 在工作区 .speedtest/<runId> 下创建
  setup: composition.setup,
})
// 创建后尝试继承权限预设；custom/auto/服务缺失时记录警告，不阻断
await ctx.get('permissionPresets')?.set(handle.agent.session, permissionPreset)
handle.agent.followup({ content: [{ type: 'text', text: FIXED_PROMPT }], source: { kind: 'model-speedtest' } })
await waitIdle(handle.agent, runTimeoutMinutes * 60_000) // 超时 cancel({kind:'user'})
```

`FIXED_PROMPT` 必须逐字一致：

```text
用测速功能帮我测速。这是自动批量测速的一轮：只执行本轮，不要向我提问，不要创建子代理，按 model-speed-load skill 的流程一次跑完。
```

### 3.4 收轮

1. 在 `<workspaceRoot>/.speedtest/*/result.json` 找本轮结果（排除 `comparisons`、`batches`）；
   本轮开始前先快照已存在的 result.json，收轮只认**新出现**的那一个，避免把历史 run 的结果算进本轮；
   同一轮仍出现多个新结果时取 mtime 最新并记警告。
2. 校验 `resultSchemaVersion === 1` 且 `metricVersion === 'v3-request-wall'`；读 `outcome`、`elapsedMs`、`metrics`、`env`、`environmentFlags`、`runId`。
3. `ctx.sessions.flush(handle.agent.session)` 后 `handle.dispose()`。
4. 原子更新 `batch.json`。
5. 失败不自动重试；连续 2 轮 `no-report` 中止整个批次。
6. 批次结束（无论 done/aborted/failed/interrupted）后自动清理：删除每轮 run 目录（result/report/task 等产物），
   归档该批次的测速会话（`workspaceRegistry.archiveSession`），只保留批次目录下的
   `batch.json` / `repeat.json` / `summary.md` 记录；在 `batch.json` 写 `artifactsRemoved` / `artifactsRemovedAt`
   并把清理结果记进 `notes`。清理失败只记警告，不影响批次状态。

## 4. HTTP 路由（全部走 `ctx.connection.fetch.register`）

统一响应：成功 `{ "ok": true, ... }`；失败 `{ "ok": false, "error": { "code": "...", "message": "..." } }`，状态码 400/404/409/500。路径全部为精确路径，不用动态段。

### 4.1 `GET /api/speedtest/context?sessionId=...`

```json
{
  "ok": true,
  "context": {
    "sessionId": "session-...",
    "cwd": "D:\\ai工作区\\技术专家",
    "env": { "provider": "...", "model": "...", "reasoningEffort": "high", "agentPreset": "standard", "permissionPreset": "workspace-write" },
    "defaults": { "rounds": 3, "maxRounds": 9, "workspaceRoot": "D:\\ai工作区\\技术专家", "runTimeoutMinutes": 10 },
    "skill": { "dir": "D:\\DSH-Home\\skills\\model-speed-load", "skillHash": "...", "taskVersion": "dev-short-v1" },
    "activeBatch": null
  }
}
```

`activeBatch` 非空时：`{ "batchId": "...", "status": "running", "currentRound": 1, "rounds": 3 }`。

### 4.2 `POST /api/speedtest/batches`

请求：`{ "sessionId": "...", "rounds": 3, "workspaceRoot": "D:\\...", "permissionPreset": "workspace-write" }`（后三项可选）。
响应 202：`{ "ok": true, "batchId": "...", "batchDir": "...", "rounds": 3, "env": { ... } }`。
启动后立即返回；批次在后台串行执行。

### 4.3 `GET /api/speedtest/index?limit=20`

```json
{ "ok": true, "batches": [
  { "batchId": "...", "dir": "...", "createdAt": "...", "status": "done",
    "env": { "provider": "...", "model": "...", "agentPreset": "..." },
    "rounds": 3, "passed": 2, "medians": { "elapsedSeconds": 96.0, "speedTps": 12.3 } }
] }
```

索引文件：`$DSH_HOME/speedtest/index.json`，原子写；损坏时返回空列表并记录警告，不阻断。

### 4.4 `GET /api/speedtest/batch?id=<batchId>`

```json
{ "ok": true, "batch": { /* batch.json 全文 */ }, "live": { "status": "running", "currentRound": 2, "totalRounds": 3, "phase": "running" } }
```

`live` 可为 null（历史批次）。batch.json 不存在返回 404。

### 4.5 `POST /api/speedtest/batch/cancel`

请求 `{ "batchId": "..." }`；响应 `{ "ok": true }`。取消当前轮（`agent.cancel({kind:'user'})`），标记 `aborted`，释放锁。

### 4.6 `POST /api/speedtest/unlock`

请求 `{ "workspaceRoot": "...", "confirm": true }`。仅当无活跃批次且锁存在时释放；`confirm !== true` 返回 400。响应 `{ "ok": true }`。

### 4.7 `GET /api/speedtest/status`

插件详情页没有会话上下文，用它读默认轮数与活跃批次。

```json
{
  "ok": true,
  "defaults": { "rounds": 3, "maxRounds": 9, "runTimeoutMinutes": 10 },
  "skill": { "dir": "...", "skillHash": "...", "taskVersion": "dev-short-v1" },
  "activeBatch": null
}
```

`activeBatch` 非空时：`{ "batchId","status","currentRound","rounds","workspaceRoot" }`。

### 4.8 `POST /api/speedtest/batch/rename`

请求 `{ "batchId": "st-...", "name": "火山 k3.1 对比" }`；名称 trim 后 1–80 字符、不含控制字符。
允许对运行中的批次重命名（只改显示名）。写 `batch.json` 的 `name`/`nameUpdatedAt` 与全局索引，返回 `{ "ok": true, "batchId", "name" }`。
不存在 → 404 `BATCH-NOT-FOUND`；名称非法 → 400 `BAD-NAME`。

### 4.9 `POST /api/speedtest/batch/delete`

请求 `{ "batchId": "st-...", "confirm": true }`。`confirm !== true` → 400 `CONFIRM-REQUIRED`；
queued/running → 409 `BATCH-ACTIVE`。路径校验（basename=batchId、父目录=<workspaceRoot>/.speedtest/batches、
batch.json 存在且 batchId 一致）失败 → 409 `DELETE-UNSAFE`；`fs.rm` 失败 → 500 `DELETE-FAILED`（索引不动）。
成功返回 `{ "ok": true, "batchId", "filesRemoved": true }`；目录已不存在时仍移除索引条目并返回 `filesRemoved: false`。

### 4.10 统一错误码补充

`BAD-NAME` 400、`BATCH-ACTIVE` 409、`DELETE-UNSAFE` 409、`DELETE-FAILED` 500、`CONFIRM-REQUIRED` 400。

## 5. 数据模型

### 5.1 `batch.json`（原子写，`<batchDir>/batch.json`）

```json
{
  "schemaVersion": 1,
  "batchId": "st-20261111-120000-ab12",
  "createdAt": "2026-11-11T12:00:00.000+08:00",
  "name": "火山 k3.1 对比",
  "nameUpdatedAt": "2026-11-11T12:05:00.000+08:00",
  "updatedAt": "2026-11-11T12:05:00.000+08:00",
  "status": "running",
  "controlSessionId": "session-...",
  "workspaceRoot": "D:\\...",
  "batchDir": "D:\\...\\.speedtest\\batches\\st-...",
  "env": { "provider": "...", "model": "...", "reasoningEffort": "...", "agentPreset": "...", "permissionPreset": "..." },
  "skill": { "dir": "...", "skillHash": "...", "taskVersion": "dev-short-v1" },
  "rounds": [
    { "index": 1, "sessionId": "session-...", "runCwd": "...", "status": "passed",
      "runId": "...", "resultPath": "...", "reportPath": "...",
      "elapsedSeconds": 96.0, "speedTps": 12.3,
      "tokens": 1422, "toolCount": 2, "devRequestCount": 2,
      "cacheHit": "hit", "cacheReadTokens": 34176, "summaryCacheHit": "hit",
      "taskVersion": "dev-short-v1", "error": null }
  ],
  "summary": { "total": 3, "passed": 2, "failed": 1, "timeout": 0, "aborted": 0, "noReport": 0,
    "stats": { "elapsedSeconds": { "n": 2, "median": 96.0, "min": 92.0, "max": 100.0, "range": 8.0, "mad": 4.0 } } },
  "artifactsRemoved": true,
  "artifactsRemovedAt": "2026-11-11T12:06:00.000+08:00",
  "notes": ["已清理 3 个轮次产物目录、归档 3 个测速会话；仅保留本存档记录。"]
}
```

`name` / `nameUpdatedAt` 可选：只有用户重命名才写入；缺失时按 DESIGN §6.2 派生显示名（不写回旧文件）。

`status` 取值：`queued` | `running` | `done` | `aborted` | `failed` | `interrupted`。
`rounds[].status` 取值：`queued` | `running` | `passed` | `failed` | `timeout` | `aborted` | `no-report`。

### 5.2 目录

```
<workspaceRoot>/.speedtest/batches/
  .lock                         # JSON: { batchId, pid, startedAt }
  <batchId>/
    batch.json
    repeat.json                 # repeat.mjs 产出
    summary.md                  # repeat.mjs 产出的人类报告
    (轮内 run 目录不在批次目录下)
  工作区/.speedtest/<runId>/   # 每轮由 skill 创建的独立 run 目录
      task/ test/ ...
    r2/ ...
```

### 5.3 全局索引 `$DSH_HOME/speedtest/index.json`

```json
{ "schemaVersion": 1, "batches": [ { "batchId": "...", "dir": "...", "createdAt": "...", "name": "火山 k3.1 对比", "status": "done", "env": {...}, "rounds": 3, "passed": 2, "medians": { "elapsedSeconds": 96.0, "speedTps": 12.3 } } ] }
```

只保留最近 200 条；不存 Key/URL 凭据/完整提示词。

## 6. Skill 侧接口（Lead 负责实现）

`D:\DSH-Home\skills\model-speed-load\scripts\repeat.mjs` 导出：

```js
export async function runRepeat({ workspace, runs, outDir, rounds }) // → { ok, repeat, markdown, jsonPath, mdPath }
```

- `runs`：`result.json` 绝对路径数组（只含已有结果的轮次，按轮次顺序）。
- `rounds`：可选，`[{ index, status, error }]`，**只传没有 result.json 的轮次**，用于把 no-report/超时轮次追加进报告；不要重复传已有 result 的轮次。
- 写 `<outDir>/repeat.json` 与 `<outDir>/summary.md`；只读原 run，不联网、不调用模型。
- N=1 时写逐轮表并注明“样本不足”；N>=2 时计算中位数/MAD，并做环境一致性检查。
- 环境不一致（provider/model/agentPreset/工具哈希）→ `environmentMismatch: true`，拒绝合并中位数。

Host 通过动态 import 调用：

```js
const { runRepeat } = await import(pathToFileURL(path.join(skillDir, 'scripts', 'repeat.mjs')).href)
```

## 7. Client 半侧

### 7.1 模块形态

`client.js` 必须用：

```js
window.__ModuleLoader__.load({
  id: '@local/model-speedtest',
  factory(require) {
    const React = require('react')
    return { inject: ['slots', 'locale'], apply(ctx) { /* ... */ } }
  },
})
```

- 不 require `@deepseek-ai/dsh-client-ui-primitives` 或其他 DSH Client 包。
- 样式只用 `--dsw-alias-*` / `--dsw-radius-*` token；类名统一 `mst-` 前缀。
- 文案走 `ctx.locale.register('model-speedtest', DICTS)` + `ctx.locale.bind('model-speedtest')`。

### 7.2 Slot 与入口

> 插件页的长详情由 DSH 插件管理器读取包根 README.md 渲染；本插件把说明放在 `MANUAL.md`，
> 因此插件页不显示长文档（详细说明留给 GitHub）。

**不在对话输入区注册任何按钮**（测速不是高频操作）。唯一可见入口：

```js
ctx.slots.inject('plugins.detail.section', () =>
  ctx.slots.register({ name: 'plugins.detail.section', id: 'model-speedtest-archives', order: 60,
    label: () => t('section.title') }, SpeedtestSection),
)
```

- `plugins.detail.section` 会在每个插件详情页渲染；组件必须用 `subject.pkg.name === '@local/model-speedtest'`
  判断（`subject.kind` 为 `bundle` 或 `row`），否则返回 `null`。
- 不再注册 `conversation.input.right` 与 `shell.overlay`。

### 7.3 启动流程（DESIGN v2）

1. 区块里「开始 N 轮」→ `ctx.get('uiWorkspace').startSession(undefined, { prompt: '/speedtest N', whenDraftExists: 'append' })`：
   新建一个对话并把提示词预填进输入框（只填不发），UI 自动跳到该对话。
2. 用户在该对话里选好 provider / model / reasoningEffort / 权限 / agentPreset，点发送。
3. `/speedtest` 命令以该会话的环境快照启动批次（Host 既有逻辑，见 §3）。
4. 插件在模块作用域轮询 `GET /api/speedtest/index`（2s，点击后 10 分钟内有效），发现新批次且
   `rounds[].sessionId` 就绪后调用 `uiWorkspace.openSession(sessionId)` 跳到第 1 轮会话；只跳一次，之后不再自动切换。
5. `uiWorkspace` 缺失时不崩：显示「当前页面没有可用的工作区服务」并保留存档管理功能。

### 7.4 存档视图

- 状态：`view = 'list' | 'detail'` + `selectedBatchId`，存模块级 store（离开插件页再回来仍保留）。
- 列表：轮数输入 + 「开始 N 轮」；活跃批次进度卡（轮次/状态/取消）；存档按创建时间倒序，
  用带表头的表格显示：名称 / 状态 / 轮数·通过 / 中位耗时 / 中位速度 / 创建时间 / 模型，整行可点。
- 详情：返回、名称（可 inline 重命名）、状态、批次 id、批次环境、逐轮表（轮/结果/缓存/任务/耗时/有效速度/
  token/工具/错误）、底部统计表（完成耗时/有效速度/输出 token/工具次数 × n/中位数/最小/最大/MAD）、
  失败轮次、批次目录（复制）；底部「删除存档」→ 二次确认文案「将删除该批次目录及其中所有轮次产物，不可恢复。」
- 索引有条目但目录丢失：详情显示「文件已丢失」，允许从列表移除条目（调用 delete，`filesRemoved:false`）。
- 重命名失败保留输入并显示错误行；删除失败不关闭详情、不清空列表；删除运行中批次提示先取消。

### 7.5 轮询与错误

- `GET /api/speedtest/status` 每 1.5s 一次（仅区块挂载时）；详情页对该批次轮询到终态为止。
- 所有 fetch 用 `{ cache: 'no-store', credentials: 'same-origin' }`；401/403 显示「会话未通过鉴权，请刷新页面」。

## 8. 测试要求

- 所有 JS 文件过 `node --check`。
- Host 纯逻辑（命令解析、路径解析、批次状态机、结果收集、索引裁剪）用 `node --test` 覆盖；不要在测试里 import `@deepseek-ai/*` 裸包。
- Client：`node --check` + `test/client-smoke.test.js`（自带口袋 React / 假 fetch，覆盖：非本插件页返回 null、
  列表渲染名称、开始按钮调用 startSession({prompt:'/speedtest N'})、进详情、重命名、删除二次确认后调用并回列表）。
- 不改 `package.json`/`cordis.patch.yml` 以外的 profile 文件；不运行 pnpm；不安装插件（安装由 Lead 做）。

## 9. 写作用域

- Host 负责人：`model-speedtest-plugin/index.js`、`model-speedtest-plugin/lib/**`、`model-speedtest-plugin/test/**`。
- Client 负责人：`model-speedtest-plugin/client.js`、`model-speedtest-plugin/locale/**`、`model-speedtest-plugin/icon.svg`、`model-speedtest-plugin/README.md`。
- Lead：`package.json`、`cordis.patch.yml`、`CONTRACT.md`、skill 侧文件、安装与 E2E。
- 不要改对方作用域内的文件；需要接口变更先改本文件并通知 Lead。