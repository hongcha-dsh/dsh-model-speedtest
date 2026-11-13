# 批量测速模式（batch-v1）

本文件是 `model-speed-load` 的批处理契约。单轮测量仍以 `SKILL.md` 与 `MEASUREMENT-CONTRACT.md` 为准；本文件只规定“一次批次 = 同一环境串行 N 轮”时，谁负责什么、什么能合并、什么必须如实记录。

## 0. 一句话

用户显式发起的一个批次包含 N 个互相独立的 run：每轮全新会话、全新 cwd、独立 runID、独立报告；插件负责编排、收集与同环境汇总，skill 仍是单轮测量内核。

## 1. 触发与授权

- 只有用户显式发送 `/speedtest [轮数]`，或在测速面板点击“开始 N 轮”，才算批次指令。
- 插件不得自动开批次、不得定时后台跑、不得在单轮里擅自加轮。
- 每轮仍严格执行 `SKILL.md` 第 4 节：`start` → 做任务 → 验收 → 固定短总结 → `finish`。
- 单轮规则 1–8 全部继续有效；批次只是把“用户手动重复开对话”变成“用户一次显式指令”。

## 2. 环境

- 批次开始时从控制会话快照：provider、model、reasoningEffort、agentPreset、permissionPreset。
- 批次内固定，不切换、不修改任何全局模型/provider/Key/插件/工作区配置。
- 换环境 = 用户换好配置后开新批次；旧批次保留，不做自动排名。
- 批次不自动 A/B；A/B 仍按 `SKILL.md` 第 8 节由用户显式选择 run。

## 3. 每轮

- 新建根级会话（不设 parentAgent），cwd 为批次目录下的独立子目录；不得复用上一轮会话或 cwd。
- 固定提示词逐字为：

  ```text
  用测速功能帮我测速。这是自动批量测速的一轮：只执行本轮，不要向我提问，不要创建子代理，按 model-speed-load skill 的流程一次跑完。
  ```

- 每轮只执行一次；不重跑、不补样本、不创建子代理、不联网、不安装依赖。
- 180 秒硬上限仍由 skill 判定；插件另有单轮看门狗，超时则取消该轮并记 `timeout`。
- 插件必须在读取本轮结果后 flush 会话并 dispose agent；会话日志只读，不删除。

## 4. 失败与中止

| 情况 | 处理 |
| --- | --- |
| 测试失败 / 越界修改 | 记 `failed`，保留原始产物，不进入成功统计 |
| 超过 180 秒 | 记 `timeout` |
| 用户取消 | 记 `aborted`，释放锁 |
| 本轮结束但没有 result.json | 记 `no-report`，附错误原因 |
| 连续 2 轮 no-report | 插件中止批次，避免继续消耗 token |
| 插件卸载 / DSH 重启 | 批次标 `interrupted`，不自动续跑 |
| 任何失败 | 不自动重试；下一轮继续或按上一条中止 |

## 5. 汇总

- 只读 `result.json`，不改写单轮报告，不复制会话日志。
- 只统计 `outcome === 'passed'` 且未被并发污染、计时完整的轮次；失败/超时/中断/无报告只计数并列出。
- 环境一致性必须检查：provider、model、agentPreset、推理设置、插件列表、工具清单哈希、DSH 版本、渠道复合身份。
  - 全部相同 → 可合并；
  - 全部未知 → 记 `shared-unknown` 警告，可继续但结论以“这些字段未变化”为前提；
  - 部分已知部分未知，或已知值不同 → 拒绝合并中位数，只列逐轮值。
- 通过轮次 < 2 → 不计算中位数，明确写“样本不足”。
- 指标：`elapsedSeconds`、`speedTps`（主）、`requestWallSeconds`、`toolSeconds`、`outputTokens`、`devRequestCount`、`toolCount`；给出 n、中位数、最小值、最大值、range、MAD。
- 报告必须写明：同环境描述统计，不是 A/B，不是总体估计；n 小、时段/缓存/服务端状态会漂移；不能据此做跨环境排名。
- 本批次汇总不与 `SKILL.md` 第 8 节 A/B 混用。

## 6. 产物

```text
<workspaceRoot>/.speedtest/batches/
  .lock
  <batchId>/
    batch.json        # 插件写：环境快照、逐轮状态、路径
    repeat.json       # repeat.mjs 写：结构化统计
    summary.md        # repeat.mjs 写：人类报告
    r1/.speedtest/<runId>/{task,marker.json,result.json,report.md,node-test.log}
    r2/...
```

- `repeat.mjs` 只读 result.json；`batch.json` 与全局索引由插件原子写。
- 不写 API Key、令牌、完整提示词或敏感代码；渠道只保留归因所需别名/主机名。

## 7. 插件职责边界

插件负责：环境快照、建独立会话、固定提示词、超时/取消、收集结果、调 `repeat.mjs`、写批次档案与索引、面板展示。

插件不负责：测量口径、日志解析、单轮判定、单轮报告、A/B 结论、自动切换配置、自动重试。

## 8. 已知限制

- 批次串行，3 轮约 3–9 分钟；并发会污染缓存与服务端状态，不提供。
- 批次会话默认不挂侧边栏；进度看面板，产物看目录。
- 权限预设若需要人工审批且无人应答，单轮会失败；插件提前警告，不伪造成功。
- 模型可能不按固定提示执行；失败如实记录，不重试。
