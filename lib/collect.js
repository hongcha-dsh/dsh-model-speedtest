/**
 * 收轮逻辑（纯逻辑）：在一轮 cwd 下挑出 `result.json`，校验版本并抽取指标。
 *
 * CONTRACT §3.4：
 * 1. 在 `<runCwd>/.speedtest/*\/result.json` 找本轮结果（排除 comparisons / batches；
 *    多个取 mtime 最新并记警告）。
 * 2. 校验 `resultSchemaVersion === 1` 且 `metricVersion === 'v3-request-wall'`；
 *    读取 outcome / elapsedMs / metrics / env / environmentFlags / runId。
 */
import { roundTo } from './stats.js'

/** 结果文件名。 */
export const RESULT_FILE_NAME = 'result.json'
/** 人类报告文件名。 */
export const REPORT_FILE_NAME = 'report.md'
/** 允许的结果 schema 版本。 */
export const RESULT_SCHEMA_VERSION = 1
/** 允许的指标版本（v3 整请求墙钟）。 */
export const METRIC_VERSION = 'v3-request-wall'
/** `result.json` 所在目录下需要排除的子目录名。 */
const EXCLUDED_DIR_NAMES = new Set(['comparisons', 'batches'])

/**
 * 判断一个相对 `<runCwd>/.speedtest/` 的路径是否属于需要排除的目录。
 * @param {string} relativePath 例如 `comparisons/x/result.json` 或 `run-abc/result.json`。
 * @returns {boolean} 是否排除。
 */
export function isExcludedResultPath(relativePath) {
  const segments = String(relativePath).split(/[\\/]+/u).filter((segment) => segment !== '')
  return segments.some((segment) => EXCLUDED_DIR_NAMES.has(segment.toLowerCase()))
}

/**
 * 在候选结果里取 mtime 最新的一个。
 * @param {Array<{ path: string, relative: string, mtimeMs: number }>} candidates 候选文件。
 * @returns {{ ok: true, path: string, mtimeMs: number, warning: string | null } | { ok: false, code: string }} 选择结果。
 */
export function selectLatestResult(candidates) {
  const usable = (Array.isArray(candidates) ? candidates : []).filter(
    (candidate) => candidate && typeof candidate.path === 'string' && !isExcludedResultPath(candidate.relative ?? ''),
  )
  if (usable.length === 0) return { ok: false, code: 'NO-REPORT' }
  const sorted = [...usable].sort((left, right) => (Number(right.mtimeMs) || 0) - (Number(left.mtimeMs) || 0))
  const latest = sorted[0]
  return {
    ok: true,
    path: latest.path,
    mtimeMs: Number(latest.mtimeMs) || 0,
    warning: usable.length > 1 ? `本轮发现 ${usable.length} 个结果文件，已取最新的一个。` : null,
  }
}

/**
 * 去掉本轮开始前就已存在的候选（历史 run 的 result.json）。
 * @param {Array<{ path: string }>} candidates 当前候选。
 * @param {Set<string> | string[] | undefined} baseline 本轮开始前已存在的路径。
 * @returns {Array<{ path: string }>} 只属于本轮的新候选。
 */
export function filterFreshCandidates(candidates, baseline) {
  const list = Array.isArray(candidates) ? candidates : []
  if (baseline === undefined || baseline === null) return list
  const known = baseline instanceof Set ? baseline : new Set(baseline)
  return list.filter((candidate) => candidate && typeof candidate.path === 'string' && !known.has(candidate.path))
}

/**
 * 校验 result.json 文档版本。
 * @param {unknown} document 解析后的 JSON。
 * @returns {{ ok: true } | { ok: false, code: string, message: string }} 校验结果。
 */
export function validateResultDocument(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { ok: false, code: 'RESULT-INVALID', message: 'result.json 不是对象。' }
  }
  if (document.resultSchemaVersion !== RESULT_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'RESULT-INVALID',
      message: `resultSchemaVersion 不受支持：${String(document.resultSchemaVersion)}（期望 ${RESULT_SCHEMA_VERSION}）。`,
    }
  }
  if (document.metricVersion !== METRIC_VERSION) {
    return {
      ok: false,
      code: 'RESULT-INVALID',
      message: `metricVersion 不受支持：${String(document.metricVersion)}（期望 ${METRIC_VERSION}）。`,
    }
  }
  return { ok: true }
}

/**
 * 把 result.json 的 outcome 映射成轮次状态。
 * @param {unknown} outcome result.outcome。
 * @returns {string} 轮次状态。
 */
export function roundStatusOf(outcome) {
  switch (outcome) {
    case 'passed':
      return 'passed'
    case 'timeout':
      return 'timeout'
    case 'aborted':
      return 'aborted'
    default:
      return 'failed'
  }
}

/**
 * 从已校验的 result.json 抽取轮次字段。
 * @param {Record<string, any>} document result.json 内容。
 * @param {{ resultPath: string, reportPath?: string | null }} files 相关文件路径。
 * @returns {Record<string, any>} 可直接并入 rounds[] 的补丁。
 */
export function roundPatchFromResult(document, files) {
  const status = roundStatusOf(document.outcome)
  const elapsedSeconds =
    Number.isFinite(document.elapsedMs) && document.elapsedMs >= 0 ? roundTo(document.elapsedMs / 1000) : null
  const metrics = document.metrics && typeof document.metrics === 'object' ? document.metrics : {}
  const speedTps = Number.isFinite(metrics.speedTps) ? roundTo(metrics.speedTps) : null
  const env = document.env && typeof document.env === 'object' ? document.env : null
  const firstCache = metrics.firstRequestCache && typeof metrics.firstRequestCache === 'object' ? metrics.firstRequestCache : null
  const summaryCache = metrics.summaryCache && typeof metrics.summaryCache === 'object' ? metrics.summaryCache : null
  return {
    runId: typeof document.runId === 'string' && document.runId !== '' ? document.runId : null,
    resultPath: files.resultPath,
    reportPath: typeof files.reportPath === 'string' ? files.reportPath : null,
    elapsedSeconds,
    speedTps,
    // 「模型请求耗时」与「流式吐字速度」：前者是 step/start→assistant/message 的墙钟之和，
    // 后者是流式跨度口径的纯吐字速度（对照口径，服务端批量下发时偏高）。
    modelRequestSeconds: Number.isFinite(metrics.requestWallSeconds) ? roundTo(metrics.requestWallSeconds) : null,
    streamSpeedTps: Number.isFinite(metrics.speedTpsStreamSpan) ? roundTo(metrics.speedTpsStreamSpan) : null,
    toolSeconds: Number.isFinite(metrics.toolMs) ? roundTo(metrics.toolMs / 1000) : null,
    // 逐轮表要展示 token 与工具次数（CONTRACT §7.3.6）；未知保持 null，不猜 0。
    tokens: Number.isFinite(metrics.outputTokens) ? metrics.outputTokens : null,
    toolCount: Number.isFinite(metrics.toolCount) ? metrics.toolCount : null,
    devRequestCount: Number.isFinite(metrics.devRequestCount) ? metrics.devRequestCount : null,
    // 缓存命中：首请求与固定短总结请求各记一次（命中/未命中/未知 + 读到的缓存 token）。
    cacheHit: firstCache !== null && typeof firstCache.state === 'string' ? firstCache.state : null,
    cacheReadTokens: firstCache !== null && Number.isFinite(firstCache.cacheReadTokens) ? firstCache.cacheReadTokens : null,
    summaryCacheHit: summaryCache !== null && typeof summaryCache.state === 'string' ? summaryCache.state : null,
    taskVersion: typeof document.taskVersion === 'string' && document.taskVersion !== '' ? document.taskVersion : null,
    status,
    error:
      status === 'passed'
        ? null
        : typeof document.failureReason === 'string' && document.failureReason !== ''
          ? document.failureReason
          : `本轮结果为 ${String(document.outcome)}`,
    // 只保留批次级别的“环境是否变化”信号与身份对比所需的最小字段。
    _environmentFlags: Array.isArray(document.environmentFlags) ? document.environmentFlags.slice(0, 5) : [],
    _envIdentity: env === null ? null : { provider: env.provider ?? null, model: env.model ?? null },
  }
}

/**
 * 对比本轮 env 与批次 env，返回需要写进 notes 的警告文本（无异常时为空数组）。
 * @param {{ provider?: string | null, model?: string | null } | null} roundEnv 本轮 env。
 * @param {{ provider?: string | null, model?: string | null }} batchEnv 批次 env。
 * @param {number} index 轮次序号。
 * @param {string[]} flags 本轮 environmentFlags。
 * @returns {string[]} 警告文本列表。
 */
export function environmentWarnings(roundEnv, batchEnv, index, flags) {
  const warnings = []
  if (roundEnv !== null && roundEnv !== undefined) {
    for (const field of ['provider', 'model']) {
      const actual = roundEnv[field]
      const expected = batchEnv?.[field]
      if (typeof actual === 'string' && actual !== '' && typeof expected === 'string' && expected !== '') {
        if (actual !== expected) warnings.push(`第 ${index} 轮实际 ${field}=${actual} 与批次快照 ${expected} 不一致。`)
      }
    }
  }
  if (Array.isArray(flags) && flags.length > 0) {
    warnings.push(`第 ${index} 轮环境标记：${flags.join(', ')}。`)
  }
  return warnings
}
