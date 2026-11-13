---
name: model-speed-load
description: "模型测速（短开发任务版）。当用户说“用测速功能帮我测速”，或要比较当前对话所用模型、渠道/Key、preset 与插件组合下的真实开发速度（真实完成时间、有效输出速度、工具耗时、缓存命中）时使用；固定 1–3 分钟 JavaScript 小任务 + Node 内置测试验收，单次只测当前环境并产出单份报告；需要 A/B 时由用户手动打开独立 DSH 任务逐轮测量，再显式选择 run 做只读汇总，不自动切换配置、不自动取最近 N 次、不做全局排名。"
---

# 模型测速 · 短开发任务版（dev-short-v1）

## 0. 一句话

在**当前会话、当前环境**里，让被测模型做同一道 1–3 分钟的 JavaScript 小任务，用 Node 内置测试验收，
再由 `scripts/measure.mjs` 从本会话日志算出「实际完成耗时 / 有效输出速度 / 工具耗时 / 缓存状态」，
并附一行环境指纹（provider/model、agentPreset、工具清单哈希）。
测的是日常开发的真实体感，不是固定文本的纯生成 tok/s。

## 1. 边界（硬规则，先看这张表）

| # | 规则 | 落地要求 |
| --- | --- | --- |
| 1 | 单环境单次测量 | 只测当前对话正在用的模型、渠道/Key、插件组合；不切换、不修改任何模型/provider/Key/插件/工作区配置 |
| 2 | 单次不自动 A/B | 一次运行只跑一个环境；不并发、不在同一轮里换环境；跨 run 比较必须由用户另行显式发起并选择 run，不自动读别的报告做排名或判优劣 |
| 3 | 只测一次 | 一个 runID、一份报告；不重跑整个任务凑样本、不补造数据、不放宽验收 |
| 4 | 模板固定 | `assets/dev-short-v1` 内容一字不改；被测模型只允许改 `task/src/summary.js` |
| 5 | 3 分钟硬超时 | 从 `markerTime`（固定任务开始）计，超过 180 秒立即记「超时」并停止 |
| 6 | 失败必须可见 | 失败/超时/越界/锁冲突/日志不可读 → 如实写，绝不当成「成功完成速度」上报 |
| 7 | 被测任务禁子代理 | 由当前主会话直接执行；任务内不联网、不装依赖；不新开对话 |
| 8 | 只写可确认的值 | 拿不到就写「未知」；不写 Key 值、不写完整提示词、不写敏感代码 |

补充两条：

- 本 skill **文件本身**的维护可以交给子代理做，与规则 7（被测任务禁子代理）不冲突。
- **允许人工分任务比较**：同一个 `dev-short-v1`、同一套口径的多轮结果可以按第 8 节显式汇总；但每次运行的时段、
  缓存状态、工具调用次数都不同，差异不一定来自被比较的环境因素。单对只能观察，样本量和波动决定可判断性，
  不使用永久固定的「只有超过多少才算快/慢」阈值。
- **批处理例外（batch-v1）**：由 `model-speedtest` 插件发起、用户显式发送 `/speedtest` 或点击面板“开始”的批次，包含 N 个互相独立的 run；每个 run 仍遵守规则 1–8，单轮只跑一次。批次只测同一环境、串行执行、不自动切换配置、不自动 A/B；批次汇总只做同环境描述统计，契约见 `BATCH-MODE.md`。

## 2. 触发方式

用户只做两件事：在测试工作区新开一个对话、进入前选好本次要测的环境；然后发一句：

> 用测速功能帮我测速

其余全部由你完成：前置检查、建运行目录、抢锁、复制模板、执行任务、跑验收、固定短总结、
调用 `finish` 生成报告并释放锁。用户不需要建目录、跑命令、改配置，也不需要再发消息。

批量测速由插件入口触发：发送 `/speedtest [轮数]` 或点击输入区“测速”。被测 agent 每轮只收到固定提示，只执行本轮，不自行重跑或创建子代理。

如果目标是 A/B 比较，仍由用户在每个独立 DSH 任务里分别发送同一句触发语；每次只走一次第 3–7 节主流程。
不要在单次测速中擅自增加第二轮或切换环境。全部所需轮次完成后，只有用户明确给出比较目标和 run 列表时，
才进入第 8 节的只读汇总流程。

## 3. 前置检查（开始前做，失败就不开始）

1. **Node 可用**：运行 `node --version`。没有 node 时可用 DSH 自带运行时
   （通常是 `%DSH_HOME%\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，路径以本机实际为准）。
   两者都没有 → 停止，告诉用户「未开始测量：没有可用的 Node」。
2. **工作区可写**：当前对话的工作区必须能创建 `.speedtest`。不可写 → 停止，不写任何成功数据。
3. **串行锁**：不要手工检查或删除锁，直接由 `measure.mjs start` 用独占创建抢锁。
   `start` 以退出码 3 报 `BUSY` 时，说明已有测速在跑：打印现有锁内容，停止，不排队、不清理。
4. **会话日志**：`start` 会在输出里给 `sessionLogHint`。自动定位失败不阻断开始，
   但要记住：finish 时相关字段会按「未知」处理；不要为了拿到日志去改 DSH 配置或写会话目录。

前置检查全部通过后，才进入第 4 节。

## 4. 执行流程（start → 做任务 → 验收 → 固定短总结 → finish）

设：

- `$workspace` = 当前测试工作区（当前对话的 cwd）。
- `$skill` = 本 SKILL.md 所在目录（安装后通常是 `%DSH_HOME%\skills\model-speed-load`）。
- `$node` = 第 3 节确认过的 node 可执行文件。

### 4.1 开始：调用 `measure.mjs start`

```powershell
& $node "$skill\scripts\measure.mjs" start --workspace "$workspace"
```

`start` 会原子地完成：生成唯一 runID、创建 `.speedtest\<runID>\task`（整份复制 `assets/dev-short-v1`）、
写入 `markerTime`、用 `wx` 独占创建 `.speedtest\.lock`，并按测量契约只读获取 start 环境快照；无法可靠取得的字段写 `unknown`。
成功时 stdout 只有一行 JSON：

```json
{"runId":"...","runDir":"...","taskDir":"...","markerTime":1794300000000,"lockPath":"...","dshHome":"...","sessionLogHint":"..."}
```

记下 `runId`、`runDir`、`taskDir`、`markerTime`。**不要**自己再建目录、复制模板或写锁。

**start 必须独立成一步**：发起 `start` 的这个 step，其模型请求在 `markerTime` 之前就开始了，不算任务窗口起点；
真正的任务开始时刻是下一个 `step/start`。因此不要在同一 step 里既 `start` 又写代码、跑测试，
否则窗口内没有任何模型请求，有效输出速度与缓存会全部记「未知」。

- 退出码 3（`BUSY`）：本轮直接停止，向用户说明「已有测速在跑（runID=…）」；不要删除、不要覆盖、不要排队。
- 退出码 1：按 stderr 的原因停止，明确告知「未开始测量」。

### 4.2 做任务：只改 task/src/summary.js

1. 读 `$taskDir\README.md`，按其中的精确规格实现 `summarize(values)`。
2. **只允许修改 `$taskDir\src\summary.js`**。不要改 `README.md`、`test/summary.test.js`、`package.json`，
   不要在 `task` 下新增任何文件（测试日志写到 `$runDir`，不要写进 `task`）。
3. 不启动子代理、不新开对话、不联网、不安装依赖、不引用第三方库。
4. 自己计时：从 `markerTime` 起算，硬上限 180000 ms。到点立即停手，不再「改一版试试」，转 4.5 记超时。

### 4.3 验收：单进程模式的内置测试

在 `task` 目录运行，并把输出留在运行目录：

```powershell
Push-Location $taskDir
& $node --test --test-isolation=none *> (Join-Path $runDir 'node-test.log')
$acceptanceExit = $LASTEXITCODE
Pop-Location
```

- **必须使用 `node --test --test-isolation=none`**。默认测试模式会为每个测试文件启动子进程管道，
  在 DSH 沙箱下会 `spawn EPERM`；单进程模式验收语义相同：退出码 0 = 全部通过。
- 不要改测试、改 README、改断言来「让它过」；测试文件就是验收标准。
- 若单进程模式仍报 `spawn EPERM` 或测试器无法启动，如实记失败并停止，不要换别的命令硬凑通过。
- 允许在 180 秒内根据失败信息修 `src/summary.js` 后重跑测试；**不重跑整个任务**、不另开样本凑数。

### 4.4 固定短总结（同一主会话，自动，不需要用户发言）

验收测试返回后，**下一步直接做固定短总结**。这一步的指令逐字为：

> 不要修改文件，简要说明你刚才改了什么。

要求：

- 把它当作这一步的唯一任务：只写几句简短总结，说明你刚才改了 `src/summary.js` 的什么；
  不改文件、不启动子代理、不联网、不做新的开发。
- **测试返回后不要再调用任何其它工具**（不要再读文件、不要 ls、不要重跑测试）。
  验收时刻取的是 `finish` 之前最后一个 `tool/result`；中间多一次工具调用会把实际完成耗时算长、把工具次数算多。
- 短总结文字和 `finish` 调用放在**同一条助手消息**里：先写短总结，紧接着调用 4.5 的 `finish`。
  这样固定短总结请求就是本次运行的最后一次模型请求，暖缓存与首响应时间才有明确归属。
- 如果确实无法产生独立的短总结请求（例如会话机制不允许），不要拿别的请求顶替：
  照常 finish，并让报告把短总结字段记为「未知」，在补充说明里写明原因。

### 4.5 结束：调用 `measure.mjs finish`

```powershell
& $node "$skill\scripts\measure.mjs" finish --workspace "$workspace" --run "<runId>" --outcome <pass|fail|timeout|aborted>
```

`--outcome` 由你按第 6 节判定后传入：

| 值 | 什么时候用 |
| --- | --- |
| `pass` | 测试退出码 0，且你确认没有越界修改，且用时未超过 180 秒 |
| `fail` | 测试未全绿、或存在越界修改、或验收无法完成 |
| `timeout` | 从 `markerTime` 起已超过 180 秒 |
| `aborted` | 测量被中断（环境异常、无法继续、用户叫停） |

`finish` 会做这些事（不要手工替代）：

1. 只释放 `runId` 匹配的那把锁；不匹配时打印 `NOT-OWNER` 并以退出码 4 结束，**不删别人的锁**。
2. 按契约定位本会话日志（`DSH_HOME` 环境变量 → `D:\DSH-Home` → 用户目录下的 `.dsh` 等候选，
   候选必须同时含 `sessions` 与 `skills`）；可用 `--session-log <文件>` 覆盖。
3. 按 zstd 魔数 `28 B5 2F FD` 逐帧解压多帧日志，只解析 step/assistant/tool/request/model 这几类事件。
4. 算实际完成耗时、逐请求 outputTokens 与整请求墙钟（step/start → assistant/message）、
   有效输出速度、TTFT、工具耗时与次数、首请求缓存三态、短总结暖缓存与首响应时间；
   同时给出流式跨度与逐段 Σdt 两个对照口径，并从日志只读取环境指纹（provider/model、agentPreset、
   工具清单与哈希）。
5. 只读获取 finish 环境快照并与 start 快照比较；有变化标 `environment-changed`，配置声明与实际请求身份冲突标
   `attribution-invalid`。保留数据与未知字段，不在单次测量中猜测比较目标。
6. 把 `task` 下的 `README.md`、`test/summary.test.js`、`package.json` 与模板原件逐字节比对；
   并检查 `task` 下有没有模板之外的新增文件。任何不一致都记「越界修改」，且绝不报通过。
7. 写 `$runDir\result.json` 与 `$runDir\report.md`，释放自己的锁，stdout 打印一行 JSON 摘要 + 报告全文。

拿到输出后，把报告里的结果表、通俗概括和 `runDir` 路径展示给用户。完整内容以 `report.md` 为准，不要手改数字。

## 5. 计时与指标口径

主指标是**整请求墙钟口径的有效输出速度**：从该 step 的 `step/start` 到对应 `assistant/message`，
把这一个请求从开始到结束的整段时间都算进去。

| 指标 | 口径 |
| --- | --- |
| 任务结果 | 固定测试全部通过且没有越界修改为「通过」，否则按实际情况记为失败、超时或中断 |
| 实际完成耗时 | 日志中第一个 `time >= markerTime` 的 `step/start` 到 `finish` 之前最后一个 `tool/result` 的墙钟差；不含建目录、前置检查、报告生成 |
| **有效输出速度（主指标）** | 任务内所有有效开发请求的 `Σ outputTokens ÷ Σ requestWallSeconds`。任一请求缺 usage 或缺 `step/start` → 该请求不计入，整体速度记「未知」，不估算、不回退到跨度或 Σdt |
| **模型请求耗时（含预填与思考）** | `requestWallSeconds = (assistant/message.time − 对应 step/start.time) / 1000`，各开发请求求和。含预填、排队、思考与吐字；工具执行发生在消息结束之后，天然不计入 |
| 对照：流式跨度口径 | `streamSpanSeconds = (max(time0 + Σdt) − min(time0)) / 1000`；`speedTpsStreamSpan = Σ outputTokens ÷ Σ streamSpanSeconds`。只写进 result.json 与报告补充说明 |
| 对照：逐段 Σdt 口径 | `chunkDeltaSeconds = Σ(Σdt) / 1000`；`speedTpsChunkDeltas = Σ outputTokens ÷ Σ chunkDeltaSeconds`。只写进 result.json 与报告补充说明 |
| 工具执行耗时与次数 | 按 `callId` 配对 `tool/call` 与 `tool/result` 的时间差；未配对记「未知」，次数仍如实统计 |
| 任务首次请求缓存 | 任务内第一条开发请求的缓存三态 + 原始 `cacheReadTokens` |
| 短总结暖缓存 | 验收后最后一次含文本的模型请求的缓存三态 + 原始 `cacheReadTokens` |
| 短总结首响应时间 | 该短总结请求的 `step/start` 到首个流式分块 `time0` 的差值 |
| 环境指纹 | 只读提取 provider/model、会话首帧的 `agentPreset`、`request/header` 里的工具名列表（排序去重）；记录 `toolCount`、`toolNamesHash`（sha256 前 8 位）与完整 `toolNames`。日志读不到就写「未知」 |

```text
requestWallSeconds = (assistant/message.time − 对应 step/start.time) / 1000
有效输出速度       = Σ outputTokens ÷ Σ requestWallSeconds                     # 主指标
对照·流式跨度      = Σ outputTokens ÷ Σ (max(time0 + Σdt) − min(time0))        # 仅供参考
对照·逐段 Σdt      = Σ outputTokens ÷ Σ(Σdt)                                   # 仅供参考
```

- `outputTokens` 是 DSH usage 口径，已包含推理、可见正文与工具调用参数；不是纯正文解码速度。
- **为什么不用流式跨度**：跨度只覆盖「首个内容块 → 最后一个内容块结束」，不含预填、排队和首响应等待，
  还会被服务端「先想后吐 / 边想边吐」的交付形态扭曲。实测同一模型 802 tokens 的三次请求，
  TTFT 2.52/3.16/2.26 秒、流式阶段只花 0.90/0.93/0.49 秒，跨度口径报出 345.8 tok/s；
  而同一模型另一轮「边想边吐」（reasoning 分块也计入跨度）8.11 秒只算 162 tok/s——同一个模型差 2 倍。
  跨度对「先想后吐」只算吐字段、对「边想边吐」把思考也算进来，两种形态不可比。
- **为什么不用 `Σdt`**：服务端会把工具调用参数（代码）这类输出批量塞进一个 SSE 包下发，`dt` 被压平。
  实测某请求 583 个 outputTokens、487 段 dt 合计只有 203ms（0.4ms/token），按 `Σdt` 会算出 1400 tok/s 的假速度。
- **为什么整请求墙钟可信**：不管服务端怎么安排流式交付，`step/start → assistant/message` 都是用户真实等待的
  那段时间；工具执行在消息结束之后才发生，所以不会把工具耗时混进来。
- 对照字段：逐请求 `requestWallSeconds`、`streamSpanSeconds`、`chunkDeltaSeconds`；聚合 `metrics.requestWallSeconds`、
  `metrics.speedTps`（主）、`metrics.speedTpsStreamSpan`、`metrics.streamSpanSeconds`、`metrics.speedTpsChunkDeltas`、
  `metrics.chunkDeltaSeconds`。缺主口径的请求 id 记在 `metrics.speedMissingRequestIds`。
- 报告可通过时，补充说明至少给一行「对照：流式跨度口径 X tok/s（受服务端缓冲影响，仅供参考）」；
  有 Σdt 值时再加一行「对照：逐段 Σdt 口径 Y tok/s（受服务端批量下发影响，仅供参考）」与一行对照明细
  （跨度合计 / Σdt 合计秒数）。失败/超时报告不写任何 tok/s 数字。
- 单请求 `outputTokens ÷ Σdt > 500` 时置 `chunkBatchingSuspected = true`，报告补充说明写明「该口径会高估速度，只能作对照」。
- 任一开发请求缺 token 或整请求墙钟，或任务窗口内存在未完成请求 → 有效输出速度写「未知」，不估算补齐。
- 缓存只允许三态：`hit`（`cacheReadTokens > 0`）、`miss`（`cacheReadTokens = 0` 且语义已确认）、
  `unknown`（usage 缺失、请求未完成、语义不明）。`cacheWriteTokens` 不等于命中。
- 所有数字来自 `measure.mjs` 对会话日志的读取；拿不到就是「未知」，不按字符数估 token，不拿整段任务墙钟当生成时间。

## 6. 判定与 3 分钟硬超时

```text
elapsed > 180000 ms              → 超时（优先，直接停）
测试退出码 != 0                   → 失败
越界修改（含新增文件）             → 失败
aborted                          → 中断
其余                              → 通过
```

- 180 秒是硬上限，从 `markerTime` 起算；跑过 180 秒立即停止，不允许「再改一版试试」。
- 允许在时限内根据失败信息修复并重跑测试，但**不重跑整个任务**、不另开样本凑数。
- 即使你传了 `--outcome pass`，`finish` 也会按日志复核：超过 180 秒改判超时，越界改判失败。
- 失败或超时可以保留已观察到的耗时与 token 原始数据，但不得标记为成功完成速度。

## 7. 产物与报告

```text
<工作区>/
└─ .speedtest/
   ├─ .lock                       # 串行锁（JSON，finish 只释放自己那把）
   └─ <runID>/
      ├─ task/                    # 固定模板副本；只有 src/summary.js 允许改
      ├─ marker.json              # runID / markerTime / startedAt / 日志提示
      ├─ node-test.log            # 验收输出（如果按 4.3 重定向）
      ├─ result.json              # 逐请求 / 逐工具原始数据
      └─ report.md                # 简单报告
```

`report.md` 固定结构：

1. 标题「当前环境测速报告」。
2. 时间、`resultSchemaVersion = 1`、`metricVersion = v3-request-wall`、`taskTemplateHash`、provider/实际解析 model、环境指纹、
   渠道别名与 baseURL 主机名、Key 别名或不可逆指纹、agentPreset/推理设置、启用插件 ID 与版本、
   工具数量、完整工具清单与工具清单哈希、DSH 版本、任务模板版本。
   环境指纹形如 `a1b2c3d4 · 12 个工具 · deepseek-v4.1-flash · preset=standard`；读不到的部分写 `unknown`/「未知」，
   全都读不到就整行写「未知」。start/finish 快照发生变化或配置声明与实际请求身份冲突时，分别明确标为
   `environment-changed` / `attribution-invalid`，单次测量不得自行猜测比较目标。
3. 一张结果表：任务结果、实际完成耗时、**有效输出速度**、**模型请求耗时（含预填与思考）**、
   工具执行耗时与次数、任务首次请求缓存、短总结暖缓存、短总结首响应时间。
4. 补充说明：报告可通过时至少含一行「对照：流式跨度口径 X tok/s（受服务端缓冲影响，仅供参考）」
   （有 Σdt 值时再加一行「对照：逐段 Σdt 口径 Y tok/s（受服务端批量下发影响，仅供参考）」与一行对照明细）；
   有失败、超时、数据缺失、越界、疑似批量下发时再追加对应说明。
5. 最后一句通俗概括，例如「本次任务通过，用时 96.0 秒，其中工具运行占 18.0 秒；短总结命中了暖缓存。」

报告纪律：

- 渠道/Key 别名、baseURL 主机名、插件组合及版本、推理设置、DSH 版本等无法从配置或日志可靠确认的字段一律写 `unknown`/「未知」，不猜。
- 失败/超时时有效输出速度写「未知（任务未通过/超时，原始数据见 result.json）」，不写数字，
  也不给流式跨度/Σdt 的对照数字（失败报告不给任何 tok/s）。
- **新旧报告不可混比**：旧版「综合生成速度」是流式跨度口径，新版「有效输出速度」是整请求墙钟口径，
  两者分母不同（新版还含预填、排队与首响应等待），数值天然不可直接比较；只允许同期同口径的人工近似比较。
- 单次测量不自动引用其他运行报告，不做渠道/插件排名，不给「哪套环境更好」的结论；只有用户按第 8 节
  显式选择 run 后，才可生成限定于本批次的描述性比较。
- 不写 API Key、令牌或 secret 原文，不写完整提示词、敏感代码；Key 只保留用户已有别名或不可逆指纹，
  baseURL 只保留归因所需的主机名和别名，不保留 URL 中可能存在的凭据或敏感查询参数。

## 8. 人工独立任务 A/B 与显式 run 汇总

单次报告完成后**不要自动汇总**。只有用户另行明确指定比较目标和本批次 run 时，才使用本节；单次测量的
`start → 做任务 → 验收 → 固定短总结 → finish` 主流程不变。

### 8.1 用户手动完成各轮测量

> 同环境重复批次的汇总走 `scripts/repeat.mjs`，契约见 `BATCH-MODE.md`；它只做描述统计，不与本节 A/B 混用。

1. 先明确 A/B 含义和唯一比较目标：插件用 `plugin:<插件ID>`，渠道用 `channel`，preset 用 `preset`。
   例如比较某插件时，可定义 A=插件关、B=插件开，并把插件 ID 写入汇总请求。
2. 每轮都由**用户手动设置当前环境并打开一个新的独立 DSH 任务**，再发送：
   > 用测速功能帮我测速
   每轮只测当时环境，产生独立 runId、`result.json` 和 `report.md`。不得自动创建多个对话，不得自动修改或切换
   模型、渠道、Key、插件、preset 或工作区配置。
3. 所有轮次必须使用同一版本的 `dev-short-v1` 固定编程题、相同测试与验收命令；不得拿不同题目或不同指标口径
   的原始耗时混比。A/B 不要求写出相同实现、工具路径或 token 数，这些差异是实测表现的一部分。
4. 除比较目标及其直接影响外，其余环境应保持一致：比较插件时保持模型、渠道、Key、preset 和非目标插件一致；
   比较渠道时保持模型、preset、插件与工具组合一致；比较 preset 时保持模型、渠道和插件组合一致。
   无法保持一致或无法确认时仍保留结果，但结论必须写「归因数据不足」或「两套混合环境的描述性结果」，不得单因素归因。
5. 记录每轮实际执行顺序。推荐三对采用 **AB/BA/AB**，以插件为例：

   ```text
   第一对：A（插件关）→ B（插件开）
   第二对：B（插件开）→ A（插件关）
   第三对：A（插件关）→ B（插件开）
   ```

   六个 run 都是用户手动打开的独立 DSH 任务。按执行顺序每两个相邻 run 尝试组成一对；一对必须各有一个有效 A/B，
   否则标为未配对。允许只跑一对，但只能作为观察；未交替不阻止汇总，必须提示时段漂移风险。

### 8.2 只有显式选择 run 才能汇总

用户完成所需轮次后，可提供按实际执行顺序排列的 runId 或对应 `result.json` 路径，并说
「汇总这些测速结果，比较插件 X」。每个 `--run` 接受一个 runId 或一份 `result.json` 路径，路径也只代表该次显式选择。
比较目标必须是 `plugin:<插件ID>` / `channel` / `preset` 之一。缺少完整 run 列表、顺序或目标时先请用户补齐；
**不得默认取最近 N 次，不得自行扩选、扫描或混入其它 run**。

命令行接口（`$workspace` 为当前测试工作区，`$skill` 为本 SKILL.md 所在目录，`$node` 为第 3 节确认的 Node；
仅做汇总时先确认这三个值，但不要进入 `start` / `finish`）：

```powershell
& $node "$skill\scripts\summarize.mjs" `
  --workspace "$workspace" `
  --target "plugin:<插件ID>" `
  --run "<按执行顺序排列的runId-1>" `
  --run "<runId-2>" `
  --run "<runId-3>"
```

比较渠道或 preset 时分别把 `--target` 改为 `channel` 或 `preset`。重复 `--run` 的顺序就是实际执行顺序，
用于分组、相邻配对和交替检查；参数值可以是 runId 或对应的 `result.json` 路径。汇总只读已有 run，不重新执行测速、
不修改原始结果、不联网；汇总脚本自身不调用模型。
产物写入：

```text
.speedtest/comparisons/<comparisonId>/comparison.json
.speedtest/comparisons/<comparisonId>/comparison.md
```

若汇总脚本或必要输入尚不可用，明确说明无法完成；不得伪造汇总产物、补造未知字段或把人工估算写成脚本结果。

### 8.3 先检查比较资格，再输出描述统计

- runId 重复、文件不存在或 JSON 无法解析时停止并指出具体项。
- 所有入选 run 顶层的 `taskTemplateHash`、`taskVersion`、`acceptanceCommand` 必须存在且一致。只接受
  顶层 `resultSchemaVersion = 1` 且 `metricVersion = v3-request-wall`；无版本旧报告、v1/v2 或未知新版本均拒绝主比较，
  不得因数值相近而混算。
- 用于主速度比较的 run 必须验收通过。失败、超时、越界 run 单独列出，不计入成功耗时/速度统计，也不能因耗时短被判为更快。
- `environment-changed` / `attribution-invalid` run 保留数据，由汇总器结合比较目标检查能否归因；单次脚本不自行判断目标。
  环境身份缺失到无法确认 A/B 或关键控制变量时写「归因数据不足」。并发污染、日志或计时口径不完整时，相应指标不参与判断，不估算补齐。
- **必须已知（缺失即拒绝归因）**：每轮 `provider`、`model`；目标分组本身；`plugin` 目标时的 `agentPreset`；
  工具作为控制变量时的工具清单与哈希。`plugin` / `preset` 目标下，渠道复合身份要求每轮至少一个组成项已知且各轮组成一致。
- **渠道复合身份**：分组按 `channelAlias + baseURL 主机 + Key 身份` 的稳定组合，仅用于内部判断；同渠道、同主机只换 Key
  也会分成 A/B，但报告只显示安全别名/主机，绝不显示 Key 指纹。比较 `channel` 时允许该复合值变化。
- **可审计的共享未知（警告但可继续）**：`reasoning`、DSH 版本、渠道组成项等次要控制字段在所有入选 run 中**同样未知**时，
  不直接判无效，但要记录 `sharedUnknownControls` 警告，并在报告明确写「结论以这些字段未变化为前提」。
- **部分未知仍然阻断**：同一控制字段一部分 run 已知、另一部分未知时，归因数据不足。
- **插件版本逐项比较**：插件数组整体未知 → 归因不足；ID/启用状态不同或已知版本冲突 → 混合环境；
  ID 与启用状态一致、版本在全部 run 中共同未知 → 可继续，但记录 `pluginVersionUnknown` 与同样的前提说明；
  同一插件仅部分 run 版本已知 → 归因不足。
- 汇总报告必须原样列出上述警告；不得因为「警告不算错误」就在报告里隐去，也不得把带前提的结论写成确定因果。
- 汇总报告必须写明比较目标、A/B 含义、生成时间、入选 run 顺序与环境摘要、是否进入统计、环境差异及资格检查。
- 完成耗时与可得的分解指标分别给出：A/B 样本数、成功数和失败数，中位数、最小值、最大值、MAD（中位数绝对偏差），
  每对耗时与比值、配对比值中位数及方向是否一致，并对照请求轮数、模型请求耗时、工具耗时、输出 token 和缓存状态。
  原始耗时统一用秒，比值统一为 `A / B`；完成耗时比值小于 1 表示 A 更快。
- 存在多个无法由目标解释的环境差异时，只能展示「两套混合环境的描述性结果」；证据不足时直接写无法判断，不做全局排名。

### 8.4 结论等级（按完整有效对数，不按 run 总数）

| 完整有效样本 | 可用结论 | 禁止越界 |
| --- | --- | --- |
| 1 对 | **单对观察**，展示本次差异 | 必须写「单对观察，不能据此判定稳定差异」 |
| 2 对 | **样本不足**，只展示本次差异与波动 | 不写「稳定更快」或「可信差异」 |
| 至少 3 对 | **初步描述**，展示中位数、波动和每对方向 | 三对不代表统计显著；方向不一致时明确写「不同轮次方向不一致」 |
| 至少 6 对 | 在初步描述上增加**探索性区间** | 区间只描述本次样本，不宣称普遍显著性 |

- 只有至少六对完整有效样本时，才额外给出配对 `log(A/B)` 中位数的 bootstrap 95% 区间；少于六对不得用 bootstrap
  或小样本公式制造看似精确的显著性结论。
- 区间跨过 0 时写「当前样本无法判定方向」；未跨过 0 也只能写「本次实验支持存在该方向的差异」。
- 不使用永久固定的「只有超过 40% 才能判」规则；可判断性取决于本次样本数、波动和区间。

### 8.5 汇总安全与隐私

- DSH 配置和会话日志只读，不写回；汇总只读取用户显式选择的 run，不扫描无关会话内容。
- `comparison.json` 只保存结构化统计与入选 run 引用，不复制整段请求或会话日志；不得修改原始 run。
- 报告和 JSON 均不得记录 API Key、令牌或 secret 原文。Key 优先用已有别名，否则只用不可逆指纹判断是否为同一凭据；
  baseURL 仅保留归因所需的主机名和别名，去掉凭据与敏感查询参数。
- 自动切换配置、自动创建对话、自动取最近 N 次和自动排名均不属于本流程。

## 9. 异常处理（都要显式可见）

| 情况 | 处理 |
| --- | --- |
| 工作区不可写 / 建目录失败 | 停止，明确告知「未开始测量」；不写任何成功数据 |
| 锁冲突（`BUSY`，退出码 3） | 打印现有锁内容与已有 runID，停止；不并发、不排队、不删锁 |
| 陈旧锁 | 无法确认对应任务已结束 → 停止交用户判断；用户明确确认后才可把锁改名归档，绝不直接删除 |
| 锁不属于自己（`NOT-OWNER`，退出码 4） | 不删锁、不改锁，告知用户人工确认 |
| 会话日志不可读 / 未找到 | token、缓存、首响应等字段记「未知」，任务结果与其它可确认数据照常出；在补充说明写明原因 |
| 测试失败 | 记失败；保留原始耗时与 token，不当成功速度 |
| 超过 180 秒 | 立即停止，记超时 |
| 越界修改 | 记失败，列出被修改/新增的文件；不得报通过 |
| 短总结请求缺失 | 暖缓存与首响应时间记「未知」，主指标不受影响 |
| `finish` 写文件失败 | 报告失败原因；锁由脚本在失败路径释放，仍无法释放时提示用户人工确认 |

## 10. 数据来源与只读约束

`measure.mjs` 只使用 Node 内置模块（`node:fs`、`node:path`、`node:zlib`、`node:crypto`、`node:os`），
**不使用 `child_process`**（DSH 沙箱禁止子进程管道），不联网、不安装依赖。

- 日志位置：`%DSH_HOME%\sessions\<工作区编码目录>\<sessionId>\session.v4.jsonl.zstd`；
  不推算编码目录规则，直接枚举 `sessions\*\*\session.v4.jsonl.zstd`，取解出的 session 头 `cwd` 与当前工作区一致、
  且 mtime 最大的文件。DSH_HOME 探测顺序：环境变量 `DSH_HOME` → `D:\DSH-Home` → `%USERPROFILE%\.dsh` 等，
  候选必须同时包含 `sessions` 与 `skills`。
- 日志是多个 zstd 帧首尾拼接：按魔数 `28 B5 2F FD` 找偏移逐段解压；某段解压失败说明是压缩数据里的伪魔数，
  把区间延伸到下一个魔数边界再试。
- 只读事件：`step/start`、`assistant/message`、`tool/call`、`tool/result`、`request/header`、
  `request/context`、`model/selection`；其它事件忽略。日志只读，绝不写回会话目录。
- 环境指纹只读提取：`request/header.data.header.config` 的 `provider`/`model`（回退 `request/context`
  与 `model/selection`）；会话首帧 session 头的 `agentPreset`；`request/header.data.header.tools` 的
  `name` 列表（排序去重）。工具名不含敏感信息，完整列表写入 `result.json` 的 `env.fingerprint.toolNames`，
  报告同时展示完整工具清单、哈希与数量。
- 现有 `result.env` 仍表示日志确认的实际请求身份；start/finish 配置快照另存为
  `result.environment = {start, finish, changedFields, attributionInvalidFields}`，异常标记放在顶层 `environmentFlags`。
  字段结构、unknown 与脱敏规则以 `MEASUREMENT-CONTRACT.md` 第 3.4 节为准，不用配置声明覆盖日志实际身份。
- 自动定位可能选错会话（同一工作区有多个活跃对话）时，用 `--session-log <文件>` 明确指定本会话日志。

## 11. 自检（离线，不联网、不发模型请求）

改动本 skill 后先跑：

```bash
node scripts/measure.mjs selftest
node scripts/selftest.mjs
node scripts/environment-selftest.mjs
node scripts/summarize-selftest.mjs
node scripts/repeat-selftest.mjs
```

- `measure.mjs selftest`：多帧 zstd 解码（含伪魔数）、事件解析、任务/验收/请求/工具口径、
  整请求墙钟主口径（含缺 step/start 记未知）、跨度与 Σdt 对照口径、环境指纹（字段/哈希稳定）、缓存三态、
  越界检查、180 秒判定、start/finish/锁、报告渲染、自包含检查。
- `selftest.mjs`：模板「参考实现全绿 / 骨架失败」、指标聚合（整请求口径优先 / 缺墙钟记未知 / 对照并存）、
  环境指纹哈希与报告行、runID 与锁、判定、报告、SKILL 文案与测量脚本存在性。
- `environment-selftest.mjs`：结果版本、start/finish 环境快照、身份冲突与变化标记、unknown 处理和 secret 脱敏。
- `summarize-selftest.mjs`：显式 run 与目标解析、版本拒绝、环境归因、AB/BA 配对、失败排除、未配对、方向不一致、
  单对/三对/六对结论边界、探索性区间、只读与输出失败处理。

## 12. 局限（写报告时可以照实说）

- 单次、单环境采样，样本量 n=1，噪声大；跨 run 也只允许同任务、同 `v3-request-wall` 口径的显式选择结果进入比较。
- 即使采用 AB/BA/AB，时段、缓存与服务端状态仍可能漂移；初步描述和探索性区间都不是普遍显著性或确定因果结论。
- 任务含模型自主的工具选择，工具次数不同会直接改变完成耗时。
- token、缓存和环境身份依赖可读的日志与配置快照；拿不到就是 `unknown`/「未知」，此时相应速度或归因结论不可给出。
- 不做跨渠道、跨插件的全局自动排名，不自动切换 Key、模型、插件或 preset；汇总结论仅限用户选择的批次和比较目标。
