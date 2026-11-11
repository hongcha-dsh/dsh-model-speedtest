# model-speedtest（模型测速批次）

DSH 插件：在同一个环境里**串行跑 N 轮 `model-speed-load` 测速**，逐轮留档并汇总中位数 / MAD，用来回答「我当前这套 provider / model / Key / 权限 / 插件组合，真实干活到底多快、稳不稳」。

入口在「设置 → 插件 → 模型测速批次」详情页里的「模型测速」区块：点「开始 N 轮」会新开一个对话并预填测速提示词，你在该对话里选好要测的配置再发送即可；跑完形成一个存档，可重命名/删除。

一次批次 = 同一环境串行 N 轮；每轮是**全新 DSH 会话、独立 run**。每轮会话的 cwd 固定为**你选的工作区**（这样测速会话会归到这个工作区，而不是“未分类”），每轮真正的独立任务目录由 skill 在工作区 `.speedtest/<runId>` 下创建。插件不注册任何模型可见工具，因此不会改变被测环境的工具清单。

> 本地插件，非 DeepSeek 官方产品。

## 安装

本目录就是一个完整的插件 bundle（`package.json` + `cordis.patch.yml` + `client.js` + `index.js` + `locale/` + `icon.svg`），不需要构建、不需要 `pnpm install`。

在 DSH 会话里让助手执行：

```text
plugin_manager install_bundle  target = D:\ai工作区\技术专家\model-speedtest-plugin
```

等价的 CLI 形式（若你的 profile 走命令行）：

```bash
dsh plugin --profile <profile> add <本目录绝对路径>
```

装完按提示**重启 DSH / 刷新页面**，再到「插件」页确认 `模型测速批次` 一行已启用。卸载用 `plugin_manager remove_bundle`。

依赖：测量内核 `D:\DSH-Home\skills\model-speed-load`（即 `$DSH_HOME/skills/model-speed-load`）。它缺失时批次会以 `SKILL-MISSING` 拒绝启动，不会静默降级。

## 入口

- **插件详情页区块**：设置 → 插件 → 模型测速批次 → 页面里的「模型测速」区块。这里只有测速，不在对话输入区加按钮。
- **启动**：点「开始 N 轮」→ 新开一个对话并把 `/speedtest N` 预填进输入框（只填不发），界面自动跳过去；
  你在那个对话里选好 provider / model / 推理强度 / 权限 / 预设，点发送，批次就按这套配置串行跑 N 轮。
- **跳转**：批次开始后自动跳到第 1 轮测速会话（只跳一次，后续轮次不打断你）。
- **斜杠命令**：任何对话里直接输入 `/speedtest [轮数]` 也能启动；`/speedtest help` 看用法。
- **存档**：区块里用带表头的表格按创建时间倒序列出批次（名称、状态、轮数/通过、中位耗时、中位速度、时间、模型）；
  点进去看环境、逐轮表（含缓存命中与 runId）、底部统计表（耗时/速度/token/工具次数的 n、中位数、最小、最大、MAD）、批次目录，可重命名/删除（删除会连目录一起删，二次确认）。

## 数据位置

都在磁盘上，可直接看/归档：

```text
<workspaceRoot>/.speedtest/
  batches/
    .lock                      # 活跃批次锁：{ batchId, pid, startedAt }
    <batchId>/
      batch.json               # 逐轮状态 + 汇总（原子写，插件自己也读它）
      repeat.json              # 同环境汇总器产出（中位数/MAD/环境一致性）
      summary.md               # 人类可读报告
      (轮内 run 目录不在批次目录下，跑完自动清理)
  工作区/.speedtest/<runId>/    # 每轮由 skill 创建的独立 run 目录（task/、test/、report.md、result.json）
```

全局索引：

```text
$DSH_HOME/speedtest/index.json     # 最近 200 个批次：batchId/dir/createdAt/status/env/rounds/passed/medians
```

索引只存批次元信息，**不存 Key / URL 凭据 / 完整提示词**。删掉某个 `<batchId>/` 目录不影响其它批次，索引里那条会退化为加载失败提示。

`<workspaceRoot>` 默认是控制会话的 cwd；插件配置里可以把 `workspaceRoot` 固定成绝对路径。

## 行为与限制

- **串行，不并发**：同一工作区同时只允许一个批次（`BUSY`），不会自动排队。确有残留锁时可调用只读辅助接口
  `POST /api/speedtest/unlock`（`{"workspaceRoot":"...","confirm":true}`）手工释放。
- **不自动 A/B**：一次批次只测一个环境；要对比就分两次批次跑，再自己看历史。
- **失败不自动重试**：某轮失败就记失败；连续 2 轮 `no-report` 会中止整批，避免烧时间。
- **跑完自动清理**：批次结束（完成/取消/失败/中断）后自动删除每轮的 run 目录（result/report/task 等产物），
  并把该批次的测速会话归档，只在存档里留下 `batch.json` / `repeat.json` / `summary.md`。
  所以侧边栏不会残留测速对话，也不用关心它们被归到哪个工作区；想留原始产物就在清理前自行备份。
- **中位数/MAD 有前提**：样本 n≥2 且各轮环境一致（provider/model/preset/工具哈希）。n=1 时报告注明「样本不足」；环境不一致时 `repeat.json` 会标 `environmentMismatch` 并拒绝合并中位数。
- **轮数与超时**：轮数 2–maxRounds（默认上限 9）；单轮默认 10 分钟超时，超时会 `cancel` 该轮并记 `timeout`。
- **权限预设**：`custom` / `auto` 下测速轮次可能需要人工审批，面板会给警告但仍允许开始——这时候批次大概率会卡在审批上。
- **逐轮表列**：轮 / 结果 / 缓存（首请求命中状态 + 读到的缓存 token）/ 任务（runId）/ 耗时 / 有效速度 / token / 工具次数 / 错误；
  字段来自单轮 `result.json`，缺失时显示「—」或「未知」，不猜 0。
- **平台**：`dsh.client.platform = web`，只有 Web GUI 有这块 UI；桌面端没有独立面板。
- 只读辅助接口：`POST /api/speedtest/unlock`（`{"workspaceRoot":"...","confirm":true}`）用于手工释放残留锁，面板只在 `BUSY` 且确认无活跃批次时调用它。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半侧：路由、批次状态机、会话创建与收轮、索引 |
| `lib/name.js` | 存档显示名派生与校验（1–80 字符、禁控制字符） |
| `lib/archive.js` | 删除前的路径安全判定（basename / 父目录 / batch.json 一致性） |
| `lib/archive-ops.js` | 重命名/删除/索引补名的纯 Node 实现（可被 `node --test` 直接覆盖） |
| `lib/**` | Host 纯逻辑（store / runner / routes / summary / collect / name / archive / archive-ops） |
| `test/**` | `node --test` 覆盖（Host 纯逻辑 + Client 冒烟，共 83 条） |
| `client.js` | 浏览器半侧：插件详情页区块（React，手写 `__ModuleLoader__` 工厂；列表/详情/重命名/删除 + 新对话预填启动） |
| `locale/zh.json`、`locale/en.json` | 插件列表里的 `meta.title` / `meta.description` |
| `icon.svg` | 插件图标（原创秒表图形） |
| `CONTRACT.md` | Host / Client 两侧实现的唯一接口依据 |

## 与 skill 的关系

测量口径完全沿用 `$DSH_HOME/skills/model-speed-load`：插件不重写 `measure.mjs`、不解析会话日志、不改单轮报告，只负责「按同一环境串行跑 N 轮 + 收轮 + 汇总 + 留档」。skill 侧新增的批量入口是 `scripts/repeat.mjs` 的 `runRepeat()`，Host 通过动态 import 调用。