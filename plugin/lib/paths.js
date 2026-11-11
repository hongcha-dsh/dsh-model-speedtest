/**
 * 测速批次的路径解析（纯逻辑，不 import 任何 @deepseek-ai 包）。
 *
 * 目录约定见 CONTRACT §5.2：
 * ```
 * <workspaceRoot>/.speedtest/batches/
 *   .lock
 *   <batchId>/
 *     batch.json
 *     repeat.json
 *     summary.md
 *     r1/ r2/ ...
 * ```
 * 全局索引固定在 `$DSH_HOME/speedtest/index.json`（见 CONTRACT §5.3）。
 */
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve } from 'node:path'

/** 工作区内的测速根目录名。 */
export const SPEEDTEST_DIR_NAME = '.speedtest'
/** 批次目录名。 */
export const BATCHES_DIR_NAME = 'batches'
/** 锁文件名。 */
export const LOCK_FILE_NAME = '.lock'
/** 批次状态文件名。 */
export const BATCH_FILE_NAME = 'batch.json'

/**
 * 展开 `~` / `~/` / `~\` 前缀；其余原样返回（含空串）。
 * @param {string} value 用户填写的路径。
 * @param {string} [home] 家目录，测试可注入。
 * @returns {string} 展开后的路径或空串。
 */
export function expandHomePath(value, home = homedir()) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (trimmed === '') return ''
  if (trimmed === '~') return home
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return trimmed
}

/**
 * 解析批次工作区：配置优先，其次控制会话 cwd；非空时必须是绝对路径。
 * @param {{ configured?: string, sessionCwd?: string, home?: string }} input 输入。
 * @returns {{ ok: true, workspaceRoot: string } | { ok: false, code: string, message: string }} 解析结果。
 */
export function resolveWorkspaceRoot({ configured = '', sessionCwd = '', home = homedir() } = {}) {
  const configuredPath = expandHomePath(configured, home)
  const candidate = configuredPath !== '' ? configuredPath : expandHomePath(sessionCwd, home)
  if (candidate === '') {
    return {
      ok: false,
      code: 'WORKSPACE-INVALID',
      message: '无法确定测速工作区：请填写工作区路径，或在带有 cwd 的会话里启动测速。',
    }
  }
  if (!isAbsolute(candidate)) {
    return {
      ok: false,
      code: 'WORKSPACE-INVALID',
      message: `工作区必须是绝对路径：${candidate}`,
    }
  }
  return { ok: true, workspaceRoot: normalize(resolve(candidate)) }
}

/**
 * `<workspaceRoot>/.speedtest`。
 * @param {string} workspaceRoot 工作区绝对路径。
 * @returns {string} 测速根目录。
 */
export function speedtestRoot(workspaceRoot) {
  return join(workspaceRoot, SPEEDTEST_DIR_NAME)
}

/**
 * `<workspaceRoot>/.speedtest/batches`。
 * @param {string} workspaceRoot 工作区绝对路径。
 * @returns {string} 批次根目录。
 */
export function batchesDir(workspaceRoot) {
  return join(speedtestRoot(workspaceRoot), BATCHES_DIR_NAME)
}

/**
 * 批次锁文件路径。
 * @param {string} workspaceRoot 工作区绝对路径。
 * @returns {string} 锁文件路径。
 */
export function lockPath(workspaceRoot) {
  return join(batchesDir(workspaceRoot), LOCK_FILE_NAME)
}

/**
 * 单个批次目录。
 * @param {string} workspaceRoot 工作区绝对路径。
 * @param {string} batchId 批次 ID。
 * @returns {string} 批次目录。
 */
export function batchDir(workspaceRoot, batchId) {
  return join(batchesDir(workspaceRoot), batchId)
}

/**
 * 单个批次的 batch.json 路径。
 * @param {string} dir 批次目录。
 * @returns {string} batch.json 路径。
 */
export function batchJsonPath(dir) {
  return join(dir, BATCH_FILE_NAME)
}

/**
 * 某一轮的 cwd：`<batchDir>/r<index>`。
 * @param {string} dir 批次目录。
 * @param {number} index 轮次序号（从 1 开始）。
 * @returns {string} 本轮工作目录。
 */
export function roundCwd(dir, index) {
  return join(dir, `r${index}`)
}

/**
 * 全局索引路径 `$DSH_HOME/speedtest/index.json`。
 * @param {string} dshHome DSH 用户目录。
 * @returns {string} 索引文件路径。
 */
export function globalIndexPath(dshHome) {
  return join(dshHome, 'speedtest', 'index.json')
}

/** 两位补零。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 本地时间 ISO 字符串（带时区偏移），例如 `2026-11-11T12:00:00.000+08:00`。
 * @param {Date} date 时间。
 * @param {number} [offsetMinutes] 相对 UTC 的分钟偏移；默认取运行时本地时区。
 * @returns {string} 带偏移的 ISO 文本。
 */
export function formatLocalIso(date, offsetMinutes = -date.getTimezoneOffset()) {
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMinutes)
  const local = new Date(date.getTime() + offsetMinutes * 60_000)
  return [
    `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`,
    `T${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}`,
    `.${String(local.getUTCMilliseconds()).padStart(3, '0')}`,
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`,
  ].join('')
}

/**
 * 生成批次 ID：`st-YYYYMMDD-HHMMSS-xxxx`（本地时间 + 4 位随机后缀）。
 * @param {Date} now 批次开始时间。
 * @param {string} suffix 4 位小写字母数字随机后缀。
 * @param {number} [offsetMinutes] 本地时区偏移，测试可注入。
 * @returns {string} 批次 ID。
 */
export function makeBatchId(now = new Date(), suffix = '0000', offsetMinutes = -now.getTimezoneOffset()) {
  const local = new Date(now.getTime() + offsetMinutes * 60_000)
  const day = `${local.getUTCFullYear()}${pad2(local.getUTCMonth() + 1)}${pad2(local.getUTCDate())}`
  const time = `${pad2(local.getUTCHours())}${pad2(local.getUTCMinutes())}${pad2(local.getUTCSeconds())}`
  const safeSuffix = String(suffix).toLowerCase().replace(/[^0-9a-z]/gu, '').slice(0, 8) || '0000'
  return `st-${day}-${time}-${safeSuffix}`
}

/**
 * 校验批次 ID 的形态（用于路由参数防御）。
 * @param {unknown} value 候选值。
 * @returns {boolean} 是否形如批次 ID。
 */
export function isBatchId(value) {
  return typeof value === 'string' && /^st-\d{8}-\d{6}-[0-9a-zA-Z]{4,8}$/u.test(value)
}
