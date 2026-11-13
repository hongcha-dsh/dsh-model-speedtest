/**
 * model-speedtest Host 半侧的错误模型。
 *
 * 所有面向用户的失败都收敛成带稳定 code 的 SpeedtestError：
 * - 路由层把 code 映射成 HTTP 状态码与 `{ ok:false, error:{code,message} }`；
 * - 命令层把 code + message 组合成一句可读错误文本。
 *
 * 本模块只依赖标准库，可被 `node --test` 直接覆盖。
 */

/** 业务错误码 → HTTP 状态码。未列出的码按 500 处理。 */
const STATUS_BY_CODE = Object.freeze({
  'BAD-REQUEST': 400,
  'BAD-ROUNDS': 400,
  'NO-MODEL': 400,
  'WORKSPACE-INVALID': 400,
  'CONFIRM-REQUIRED': 400,
  'BAD-NAME': 400,
  'SESSION-NOT-FOUND': 404,
  'BATCH-NOT-FOUND': 404,
  'LOCK-NOT-FOUND': 404,
  'BUSY': 409,
  'BATCH-ACTIVE': 409,
  'NO-WORKSPACE': 409,
  'DELETE-UNSAFE': 409,
  'SKILL-MISSING': 500,
  'DELETE-FAILED': 500,
  'INTERNAL': 500,
})

/**
 * 面向用户的测速错误。
 */
export class SpeedtestError extends Error {
  /**
   * @param {string} code 稳定错误码（见 CONTRACT §3.2 与路由约定）
   * @param {string} message 面向用户的中文说明
   * @param {Record<string, unknown>} [extra] 附加字段（例如 BUSY 时的 batchId）
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'SpeedtestError'
    this.code = code
    this.extra = extra
  }
}

/**
 * 把错误码映射成 HTTP 状态码。
 * @param {string} code 业务错误码。
 * @returns {number} HTTP 状态码。
 */
export function statusOfCode(code) {
  return STATUS_BY_CODE[code] ?? 500
}

/**
 * 把任意抛出值转换成一段可读文本（不含堆栈，避免把内部路径暴露给界面）。
 * @param {unknown} error 抛出值。
 * @returns {string} 可读文本。
 */
export function messageOf(error) {
  if (error === undefined || error === null) return '未知错误'
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * 把任意抛出值归一成 SpeedtestError。
 * @param {unknown} error 抛出值。
 * @param {string} [fallbackCode] 非 SpeedtestError 时使用的错误码。
 * @returns {SpeedtestError} 归一化错误。
 */
export function toSpeedtestError(error, fallbackCode = 'INTERNAL') {
  if (error instanceof SpeedtestError) return error
  return new SpeedtestError(fallbackCode, messageOf(error), { cause: error })
}
