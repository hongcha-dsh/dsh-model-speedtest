# 固定任务 dev-short-v1：数组统计摘要

这是「模型测速（短开发任务版）」使用的固定开发任务。模板内容与任务版本必须保持原样，
测速过程中不得修改需求、测试或验收标准。

## 你要做的事

只修改 `src/summary.js`，实现并导出函数 `summarize(values)`。

返回值必须是**只含四个字段**的普通对象（不要多加字段）：

| 字段 | 含义 |
| --- | --- |
| `count` | 元素个数 |
| `min` | 最小值 |
| `max` | 最大值 |
| `median` | 中位数 |

## 精确规格

1. `values` 不是数组（`Array.isArray(values)` 为 false）→ 抛出 `TypeError`。
2. `values` 是数组，但任一元素不是有限数值（`typeof x !== 'number'` 或 `Number.isFinite(x)` 为 false）→ 抛出 `TypeError`。
3. 空数组 → `{ count: 0, min: null, max: null, median: null }`。
4. 元素个数为奇数 → `median` 取排序后正中间那个数。
5. 元素个数为偶数 → `median` 取排序后中间两个数的平均值。
6. 不得修改入参数组（不得原地排序、不得增删元素、不得改元素）。
7. 不安装任何依赖、不联网、不引入第三方库。
8. 只允许修改 `src/summary.js`；`README.md`、`test/summary.test.js`、`package.json` 不得改动。

## 验收

在当前目录运行：

```bash
node --test --test-isolation=none
```

该模式只使用 Node 内置测试运行器，不启动子进程管道（DSH 沙箱下 `node --test` 会因 `spawn EPERM` 失败）。
验收语义不变：退出码 0 = 全部测试通过。

全部测试通过，且没有越界修改，任务才算通过。
测试文件就是验收标准，不要为了让测试通过而修改测试。
