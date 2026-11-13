在插件详情页启动 N 轮同环境测速：点「开始 N 轮」会新开一个对话并预填测速提示词，你选好 provider / model / 预设后发送，插件串行跑完并汇总中位数。

- 口径：同一 provider / model / 推理强度 / 权限 / 插件组合下串行 N 轮，每轮一个全新会话；测的是真实开发速度（完成耗时、有效输出速度、缓存命中），不是纯生成 tok/s。
- 结果：逐轮表（缓存、耗时、token、工具次数）+ 中位数 / 最小 / 最大 / MAD；环境不一致或样本不足会明确标注，不硬凑结论。
- 存档：批次可重命名 / 删除；数据落在所选工作区的 `.speedtest/` 和 `$DSH_HOME/speedtest/index.json`。
- 自带测量 skill：本机缺 `model-speed-load` skill 时，插件会自动把自带副本装到 `$DSH_HOME/skills/model-speed-load`（已存在则不覆盖）。
