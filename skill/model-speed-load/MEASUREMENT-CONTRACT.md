# 测量数据源契约（主代理实测确认，2026-11-10）

本文件是实施依据，实施 scripts/ 时必须严格遵循。其中会话日志事件与 v3 指标公式来自真实日志实测；
结果版本、start/finish 环境快照和跨 run 汇总是 2026-11-10 人工 A/B 设计新增的契约，不代表旧结果已经具备这些字段。
任何配置或日志中无法可靠确认的字段都必须写 `unknown`（结构化字段可用 `null`，报告写「未知」），不得猜测或补造。

**指标版本 `metricVersion = "v3-request-wall"`（2026-11-10）**：主指标为「整请求墙钟口径」的有效输出速度，
跨度与逐段 Σdt 仅作对照。本次新增版本与环境身份字段不改变第 3.2 节公式；旧口径报告不可与新报告直接比较。

## 0. 结果版本与跨 run 兼容门槛

每份新 `result.json` 顶层必须包含：

```json
{
  "resultSchemaVersion": 1,
  "metricVersion": "v3-request-wall",
  "taskTemplateHash": "<64 位十六进制 SHA-256>",
  "taskVersion": "dev-short-v1",
  "acceptanceCommand": "node --test --test-isolation=none"
}
```

- `resultSchemaVersion` 标识结果结构，`metricVersion` 标识指标口径；两者缺一不可，它们与 `taskTemplateHash` 都必须在单次报告中展示。
- `taskTemplateHash` / `taskVersion` / `acceptanceCommand` 用于确认比较的是同一道固定编程题与同一验收标准，
  必须由测量端真实写入，汇总端不得代补。哈希的生成范围与编码由测量端和汇总端共同保持固定；本契约不把未知哈希伪装成有效值。
- 汇总器只接受 `resultSchemaVersion === 1` 且 `metricVersion === "v3-request-wall"`，并要求上述三个任务字段全部存在且一致。
  无版本旧报告、v1/v2 指标报告、未知新版本、任务哈希/版本或验收命令不一致 → 拒绝主比较；不得自动迁移、估算或按数值相近混算。
- 版本门槛只决定能否比较，不改变单次测量判定，也不把失败/超时 run 变成成功样本。

## 1. 会话日志定位

- 目录：`%DSH_HOME%\sessions\<工作区编码目录>\<sessionId>\session.v4.jsonl.zstd`
- 本机 DSH_HOME = `D:\DSH-Home`（运行时读环境变量 DSH_HOME；没有则回退到候选目录探测）。
- 不推算“工作区编码目录”规则，直接枚举 `%DSH_HOME%\sessions\*\*\session.v4.jsonl.zstd`。
- 只解第一帧得到 session 头记录（`{"type":"session","version":4,"id":...,"cwd":...}`），取 `cwd` 与当前工作区相同且 mtime 最大的日志文件。
- 支持 `--session-log <path>` 手动覆盖。

## 2. 多帧 zstd 解码

- 日志文件是**多个 zstd 帧首尾拼接**。实测当前会话文件 468661 字节，`zstdDecompressSync` 一次只解出 200 字节（第一帧）。
- 必须按帧魔数 `28 B5 2F FD` 找所有偏移，逐段解压；某段解压抛错说明该魔数是压缩数据中的伪魔数，把区间延伸到下一个魔数边界再试。
- 解出的每行是一个 JSON 事件：`{type, seq, time, data, surfaceOp?}`，`time` 为 Unix 毫秒。

## 3. 事件与指标

| 事件 | 关键字段 | 用途 |
|---|---|---|
| `step/start` | `data.turn`, `data.step`；`time` | 该 step 模型请求开始时刻 |
| `assistant/message` | `data.turn/step`, `data.usage`, `data.stream`；`time` | 一次模型请求完成；usage 与流式分块 |
| `tool/call` | `data.callId`, `data.name`, `data.arguments`；`time` | 工具发起时刻 |
| `tool/result` | `data.toolCallId`, `data.message`, `data.isError`；`time` | 工具返回时刻 |
| `request/header` | `data.header.config.provider/model`、`data.header.tools[].name` | provider/model、环境指纹的工具清单 |
| `request/context` / `model/selection` | `data.provider`, `data.model` | provider/model 备选来源 |

### 3.1 usage

`assistant/message.data.usage` = `{inputTokens, outputTokens, totalTokens, cacheReadTokens}`（实测 51 条消息全部存在）。
回退路径：`data.stream[*].chunk.usage`（同值）、`data.message.source.replayState.response.usage`（字段名为 `input/output/cacheRead/cacheWrite/totalTokens`）。

### 3.2 主指标：整请求墙钟（有效输出速度来源）

对每个 `assistant/message`，用 `data.turn/step` 找到同一 step 的 `step/start`：

```text
requestWallMs      = assistant/message.time − 对应 step/start.time
requestWallSeconds = requestWallMs / 1000
```

- 含预填、排队、思考与吐字；工具执行发生在 `assistant/message` 之后（`tool/call.time >= message.time`），
  所以不含工具时间。`message.time` 早于 `step/start.time` 或两者任一缺失 → `requestWallMs = null`。
- **主指标**：`speedTps = Σ outputTokens ÷ Σ requestWallSeconds`（只统计 `purpose = dev` 的请求）。
- 任一开发请求缺 usage 或缺 `step/start`（拿不到 `requestWallSeconds`）→ 该请求不计入 ∑，
  整体速度记 `unknown`（`speedUnknownReason = time-incomplete` / `token-incomplete`），
  **不估算、不回退到跨度或 Σdt**；缺主口径的请求 id 写入 `metrics.speedMissingRequestIds`。
- 任务窗口内存在未完成请求（`step/start` 无对应 `assistant/message`）→ `speedUnknownReason = request-incomplete`。
- 报告表格行「模型请求耗时（含预填与思考）」= `Σ requestWallSeconds`；任一开发请求缺失时该行写「未知」。

### 3.3 对照口径：stream 分块组（跨度 / 逐段 Σdt）

`data.stream` 是数组，元素两类：

```json
{"type":"chunk","time":<ms>,"chunk":{"type":"block-start|block-end|usage|finish", ...}}
{"type":"reasoning-chunks","time0":<ms>,"index":0,"dt":[ms,ms,...],"texts":[...]}
{"type":"text-chunks","time0":<ms>,"index":1,"dt":[...],"texts":[...]}
{"type":"tool-call-chunks","time0":<ms>,"index":2,"dt":[...],"id":"tool_...","name":"run_code","args":[...]}
```

- `dt` 是相邻 token 的间隔毫秒；`time0` 是该组首个 token 时刻。只统计**带 `dt` 数组**的分块组
  （reasoning-chunks / text-chunks / tool-call-chunks）；块结束、usage、finish 等 chunk 不计。
- **对照 1｜流式跨度（streamSpanSeconds）**：

  ```text
  streamSpanSeconds = (max(group.time0 + Σgroup.dt) − min(group.time0)) / 1000
  speedTpsStreamSpan = Σ outputTokens ÷ Σ streamSpanSeconds
  ```

  即首个内容块到最后一个内容块结束的墙钟跨度。reasoning、正文、工具调用参数都计入；首块到末块之间的空档
  算在跨度里；不含工具执行时间。没有 `time0` 的组无法参与聚合，该请求记入
  `metrics.streamSpanMissingRequestIds`，聚合值写 `null`（未知），不混算。
- **对照 2｜逐段间隔之和（chunkDeltaSeconds）**：

  ```text
  chunkDeltaSeconds = Σ(Σgroup.dt) / 1000
  speedTpsChunkDeltas = Σ outputTokens ÷ Σ chunkDeltaSeconds
  ```

- **这两个口径只作对照**：只出现在 `result.json` 与报告「补充说明」里，任何情况下都不顶替主速度。
  报告可通过时给：
  「对照：流式跨度口径 X tok/s（受服务端缓冲影响，仅供参考）」、
  「对照：逐段 Σdt 口径 Y tok/s（受服务端批量下发影响，仅供参考）」、
  「对照明细：跨度合计 A 秒、Σdt 合计 B 秒（同一批请求，均不参与结论）。」
  失败/超时报告不出现任何 tok/s。
- **为什么不用跨度**：跨度不含预填、排队与首响应等待，且被服务端「先想后吐 / 边想边吐」的交付形态扭曲。
  实测同一模型 802 tokens 的三次请求 TTFT 2.52/3.16/2.26 秒、流式阶段只花 0.90/0.93/0.49 秒，
  跨度口径报 345.8 tok/s；同模型另一轮「边想边吐」（reasoning 计入跨度）8.11 秒只算 162 tok/s，差 2 倍。
- **为什么不用 `Σdt`**：服务端会把工具调用参数（代码）这类输出批量塞进一个 SSE 包下发，`dt` 被压平。
  实测某请求 583 个 outputTokens、487 段 dt 合计只有 203ms（0.4ms/token），首块到末块真实跨度 2681ms；
  按 `Σdt` 会算出 1400 tok/s 的假速度。
- **批量下发标记**：`chunkDeltaSeconds > 0` 且 `outputTokens / chunkDeltaSeconds > 500` →
  `chunkBatchingSuspected = true`（阈值 `CHUNK_BATCHING_TPS_THRESHOLD = 500`，判定为严格大于）。
  报告补充说明写「有请求疑似批量下发（大量 token 挤在同一个 SSE 包里），逐段 Σdt 口径会高估速度，只能作对照。」
- **字段（不向后兼容，旧报告不可混比）**：
  逐请求 `requestWallMs` / `requestWallSeconds` / `streamSpanMs` / `streamSpanSeconds` /
  `chunkDeltaMs` / `chunkDeltaSeconds` / `chunkBatchingSuspected`；
  聚合 `metrics.requestWallSeconds` / `metrics.speedTps`（主）/ `metrics.speedTpsStreamSpan` /
  `metrics.streamSpanSeconds` / `metrics.speedTpsChunkDeltas` / `metrics.chunkDeltaSeconds` /
  `metrics.speedMissingRequestIds` / `metrics.streamSpanMissingRequestIds` /
  `metrics.chunkDeltaMissingRequestIds` / `metrics.chunkBatchingRequestIds` / `metrics.chunkBatchingSuspected`。
  旧字段 `streamMs` / `streamSeconds` / `streamSecondsChunkDeltas` / `streamFallbackRequestIds` 已移除。
- **TTFT** = 首个分块组 `time0` − 该 step 的 `step/start.time`（口径不变）。
- `outputTokens` 已包含 reasoning 与工具调用参数（DSH 口径）。

### 3.4 环境身份：日志指纹与 start/finish 快照

#### 3.4.1 日志实际身份与工具指纹

同一模型在不同 preset 或工具组合下速度不同，报告必须能标注「这次测的是哪套环境」。

| 字段 | 来源 | 说明 |
|---|---|---|
| `provider` / `model` | `request/header.data.header.config`（回退 `request/context`、`model/selection` 的 `data.provider` / `data.model`） | 取任务开始前最后一个可用事件 |
| `agentPreset` | 会话首帧 session 头（`{"type":"session",...}`，日志第一行）的 `agentPreset` | 读不到依次回退 `preset` / `agent.preset` / `meta.agentPreset` |
| `toolNames` / `toolCount` | `request/header.data.header.tools` 的 `name` 列表 | 排序 + 去重；工具定义可为字符串或 `{name}` |
| `toolNamesHash` | `sha256(sortedToolNames.join("\n"))` 的十六进制前 8 位 | 常量 `ENV_FINGERPRINT_HASH_LEN = 8`；同输入必同哈希 |

- 工具名不含敏感信息，完整 `toolNames` 写入 `result.json`，报告同时展示完整工具清单、哈希与数量。
- 日志读不到 → `result.env` 中对应身份字段统一为英文 `"unknown"`，报告写「未知」；四段全读不到时整行写「未知」。
- 报告行格式：`- 环境指纹：a1b2c3d4 · 12 个工具 · deepseek-v4.1-flash · preset=standard`。
- `result.json`：`env.fingerprint = {provider, model, agentPreset, toolCount, toolNamesHash, toolNames}`。

#### 3.4.2 start/finish 配置快照与异常标记

`measure.mjs start` 和 `finish` 分别只读获取一次配置快照；现有 `result.env` 继续表示会话日志确认的**实际请求身份与指纹**，
不得被配置快照替代。新增结构：

```text
result.environment = {
  start: Snapshot,
  finish: Snapshot,
  changedFields: string[],
  attributionInvalidFields: string[]
}
result.environmentFlags = []  // 可含 environment-changed、attribution-invalid
```

`Snapshot` 是扁平对象，字段如下：

| 字段 | 含义与约束 |
|---|---|
| `provider` / `model` | 配置声明的 provider/model；结束时的实际请求身份仍以日志 `env` 为准 |
| `channelAlias` | 用户已有渠道别名；不是 URL 或凭据原文 |
| `baseUrlHost` | 只保留 baseURL 主机名，不保留路径中的凭据、敏感查询参数或完整 URL |
| `keyAlias` / `keyFingerprint` | 优先记录已有 Key 别名；没有别名时只记录不可逆指纹，绝不记录 Key/令牌/secret 原文 |
| `agentPreset` / `reasoning` | agent preset 与可可靠读取的推理设置 |
| `plugins` | 启用插件的 `[{id, version}]`；只有确认没有启用插件时才可用空数组，读取失败不得伪装成空配置 |
| `toolCount` / `toolNames` / `toolNamesHash` | 工具数量、排序去重后的完整清单与哈希；完整清单写入结果 JSON，并在报告中与数量、哈希一起展示 |
| `dshVersion` / `taskVersion` | DSH 版本与固定任务模板版本 |

- 快照中任何无法可靠取得的值写 `"unknown"`；不得把缺失值猜成默认渠道、默认 preset、无插件或某个版本。
- `changedFields` 记录 start/finish 快照值发生变化的字段名；只要存在变化，就在顶层 `environmentFlags` 加入
  `"environment-changed"`。该 run 保留数据，但后续能否进入目标归因由汇总器判断。
- `attributionInvalidFields` 记录 finish 配置声明与日志实际身份**双方均已知但不一致**的 `provider` / `model` 字段名；
  发现此类冲突时在 `environmentFlags` 加入 `"attribution-invalid"`。任一方为 `unknown` 时不得虚构冲突。
- 两类标记可以同时存在；不得因为存在标记而删除原始结果，也不得由单次测量脚本自行猜测比较目标。
- 单次报告展示可得的快照身份与两类标记。配置和日志均只读，不写回；所有输出遵守第 6 节的安全约束。

### 3.5 工具耗时

按 `callId` 配对 `tool/call.time` → `tool/result.time`，差值即工具执行耗时；未配对的记 unknown。

## 4. 时间口径

- **固定任务开始**：`start` 子命令创建目录/模板/锁后记录 markerTime；测量取日志中第一个 `time >= markerTime` 的 `step/start.time`。
- **验收通过时刻**：`finish` 子命令记录 finishTime；取日志中 `finishTime` 之前最后一个 `tool/result.time`。这样不把 finish 调用本身的模型生成计入。
- **实际完成耗时** = 验收通过时刻 − 固定任务开始（口径未变，且与「模型请求耗时」不是同一个量：
  后者逐请求累加 `step/start → assistant/message`，不含工具执行与请求之间的空档）。
- 找不到对应事件 → 写 `unknown` 并说明原因，禁止估算。

## 5. 缓存三态

- `hit`：可靠 usage 且 `cacheReadTokens > 0`；报告保留原始 token 数。
- `miss`：可靠 usage 且 `cacheReadTokens === 0` 且该请求的缓存字段语义已确认。
- `unknown`：usage 缺失、字段语义不明、请求未完成或日志不足。
- `cacheWriteTokens` ≠ 命中。

## 6. 硬约束

- 测量脚本只用 Node 内置模块（`node:zlib`、`node:fs`、`node:path`），不安装依赖、不联网。
- 日志只读，绝不写回会话目录。
- 只读 `step/start`、`assistant/message`、`tool/call`、`tool/result`、`request/header`、`request/context`、`model/selection`；忽略其他类型。
- selftest 用合成事件与 `zstdCompressSync` 造多帧文件验证解码与口径，不得使用真实会话内容。
- 不修改已确认口径：完成耗时 = 第一个 `>=` markerTime 的 `step/start` → `finish` 前最后一个 `tool/result`；
  缓存三态；180 秒硬上限；越界检查；串行锁。
- 配置快照和会话日志均只读；报告与 JSON 不记录 API Key、令牌或 secret 原文，Key 只用已有别名或不可逆指纹，
  baseURL 只保留归因所需的主机名和别名。无法确认写 `unknown`，不得用空值或默认值冒充已确认环境。

## 7. 显式 run 汇总契约

### 7.1 输入与只读边界

命令行接口：

```powershell
node scripts/summarize.mjs `
  --workspace "<测试工作区>" `
  --target "<plugin:<插件ID>|channel|preset>" `
  --run "<runId 或 result.json路径>" `
  --run "<下一个 runId 或 result.json路径>"
```

- 必须显式给出完整 `--run` 列表和比较目标；每个 `--run` 只接受一个 runId 或对应 `result.json` 路径。
  参数顺序就是实际执行顺序，用于相邻配对和 AB/BA 交替检查。
- 不得默认取最近 N 次、自动扩选或扫描无关会话；runId 重复、文件不存在或 JSON 无法解析时停止并指出具体项。
- 汇总只读已选 run，不重新执行测速、不修改原始 run、不联网；汇总脚本不调用模型，只用 Node 内置模块。
- 每次单次测量仍由用户在新独立 DSH 任务中发送 `用测速功能帮我测速`。汇总器不得自动创建对话或切换模型、渠道、Key、插件、preset。

### 7.2 资格、分组与配对

1. 先执行第 0 节版本与任务一致性门槛；不合规时拒绝主比较，不用旧报告补数。
2. 主速度统计只纳入验收通过且相应指标完整的 run；失败、超时、越界 run 计入失败清单，不进入成功耗时/速度统计。
3. 按目标字段分 A/B，报告必须写明 A/B 各代表什么。插件目标为 `plugin:<id>`，另两类目标为 `channel` / `preset`。
4. 比较插件时，模型、渠道、Key、preset 和非目标插件应一致，只允许目标插件状态及其直接工具差异变化；
   比较渠道时只有目标渠道/Key/baseURL 允许不同；比较 preset 时只允许 preset 及其直接请求差异变化。
5. `environment-changed` / `attribution-invalid`、多个非目标差异或环境身份缺失时，保留可得描述结果；
   无法确认分组或控制变量则写「归因数据不足」，多因素变化只能写「两套混合环境的描述性结果」，不得单因素归因。

### 7.2.1 关键身份与共享未知

- 必须已知，否则拒绝归因：每轮 `provider`、`model`；目标分组；`plugin` 目标的 `agentPreset`；作为控制变量的工具清单与哈希。
- 渠道复合身份 = `channelAlias + baseURL 主机 + Key 身份`，用于内部稳定分组。`plugin` / `preset` 目标下要求
  每轮至少一个组成项已知且各轮组成一致；`channel` 目标允许复合值变化，因此同渠道只换 Key 也能分组。
  报告只显示安全别名/主机，Key 指纹仅用于内部比较，绝不写入产物。
- 次要控制字段（`reasoning`、DSH 版本、渠道组成项）在所有入选 run 中同样未知时，记录 `sharedUnknownControls` 警告，
  并写明「结论以这些字段未变化为前提」，不因此直接判无效；一部分已知、一部分未知仍为归因不足。
- 插件按 ID/启用状态/版本逐项比较：数组整体未知 → 归因不足；ID/启用状态不同或已知版本冲突 → 混合环境；
  ID 与启用状态一致且版本全部未知 → 记录 `pluginVersionUnknown` 后可继续；同一插件部分 run 版本已知 → 归因不足。
- 上述警告必须原样写入 `comparison.json` 与 `comparison.md`；带前提的结论不得写成确定因果。
6. 并发污染、日志不完整或计时口径不完整时，相应指标不参与判断，不估算补齐。
7. 按用户给定顺序每两个相邻 run 尝试成对；一对必须包含一个有效 A 和一个有效 B，否则标为未配对且不进入配对统计。
   推荐 AB/BA/AB；未交替不阻止汇总，但必须提示时段漂移风险。

### 7.3 必输出统计与结论等级

- 对完成耗时及可得分解指标分别输出 A/B 样本数、成功数、失败数，中位数、最小值、最大值、MAD（中位数绝对偏差），
  每对耗时与 `A / B` 比值、配对比值中位数及方向是否一致；并对照请求轮数、模型请求耗时、工具耗时、输出 token 和缓存状态。
- 原始耗时统一为秒；完成耗时 `A / B < 1` 表示 A 更快。不得把不同固定题或不同指标版本的原始耗时合并。
- 结论按**完整有效对数**分级：一到两对为「样本不足」，其中一对必须标「单对观察，不能据此判定稳定差异」；
  至少三对才可写「初步描述」，展示中位数、波动和每对方向，方向不一致时明确写出；
  至少六对才额外给配对 `log(A/B)` 中位数的 bootstrap 95% 区间，并标为本次样本的探索性区间。
- 少于六对不得输出 bootstrap 或小样本显著性结论。区间跨过 0 写「当前样本无法判定方向」；未跨过 0 也只能写
  「本次实验支持存在该方向的差异」。不得使用永久固定的 40% 判定线，不得宣称普遍显著性或确定因果。

### 7.4 汇总产物与安全

```text
.speedtest/comparisons/<comparisonId>/comparison.json
.speedtest/comparisons/<comparisonId>/comparison.md
```

- `comparison.md` 包含比较目标、A/B 含义、生成时间、入选 run 清单与顺序、环境摘要、结果与是否进入统计、
  环境差异和资格检查、统计表、样本充分性、交替顺序与限制，以及一句客观结论；证据不足直接写无法判断。
- `comparison.json` 保存结构化统计和入选 run 引用，不复制整段请求或会话日志。两类产物均遵守 secret、Key 和 baseURL 脱敏规则。
- 输出失败不得修改原始 run；已写出的不完整文件不得标记为成功。用户选择的 run 完全不属于目标 A/B 时拒绝生成误导性结论。
