/**
 * `/speedtest` 命令解析（纯逻辑）。
 *
 * 支持：
 * - `/speedtest`           → 使用配置的默认轮数
 * - `/speedtest 3`         → 指定轮数
 * - `/speedtest rounds=3`  → 指定轮数（等价写法）
 * - `/speedtest help`      → 输出用法
 *
 * CONTRACT §3.2：rounds < 2 或 > maxRounds 返回 `BAD-ROUNDS`。
 */

/** 命令用法文本（成功/错误结果共用）。 */
export const SPEEDTEST_USAGE =
  '用法：/speedtest [轮数|rounds=N|help]，轮数 2 到 9（默认 3），例：/speedtest 3'

/** 解析结果类型常量。 */
export const COMMAND_KIND = Object.freeze({ START: 'start', HELP: 'help', ERROR: 'error' })

/**
 * 解析命令输入。
 * @param {string} rawInput `/speedtest` 之后的原始输入。
 * @param {{ defaultRounds: number, maxRounds: number }} limits 轮数上限配置。
 * @returns {{ kind: 'start', rounds: number } | { kind: 'help' } | { kind: 'error', code: string, message: string }} 解析结果。
 */
export function parseSpeedtestCommand(rawInput, limits) {
  const defaultRounds = Math.trunc(Number(limits?.defaultRounds))
  const maxRounds = Math.trunc(Number(limits?.maxRounds))
  const safeDefault = Number.isFinite(defaultRounds) && defaultRounds >= 2 ? defaultRounds : 3
  const safeMax = Number.isFinite(maxRounds) && maxRounds >= 2 ? maxRounds : 9
  const input = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (input === '') {
    if (safeDefault > safeMax) {
      return badRounds(`默认轮数配置 ${safeDefault} 超过上限 ${safeMax}，请调整插件配置。`)
    }
    return { kind: COMMAND_KIND.START, rounds: safeDefault }
  }
  const lower = input.toLowerCase()
  if (lower === 'help' || lower === '--help' || lower === '-h') return { kind: COMMAND_KIND.HELP }
  const match = /^(?:rounds\s*[=:]\s*)?(\d+)$/iu.exec(input)
  if (match === null) {
    return {
      kind: COMMAND_KIND.ERROR,
      code: 'BAD-REQUEST',
      message: `无法识别的参数：“${input}”。\n${SPEEDTEST_USAGE}`,
    }
  }
  const rounds = Number(match[1])
  if (!Number.isSafeInteger(rounds) || rounds < 2 || rounds > safeMax) {
    return badRounds(`轮数必须是 2 到 ${safeMax} 之间的整数，收到 ${match[1]}。`)
  }
  return { kind: COMMAND_KIND.START, rounds }
}

/** 构造 BAD-ROUNDS 解析错误。 */
function badRounds(message) {
  return { kind: COMMAND_KIND.ERROR, code: 'BAD-ROUNDS', message: `${message} ${SPEEDTEST_USAGE}` }
}

/**
 * 校验 HTTP 请求里的 rounds（缺省用默认值）。
 * @param {unknown} value 请求体中的 rounds。
 * @param {{ defaultRounds: number, maxRounds: number }} limits 配置。
 * @returns {{ ok: true, rounds: number } | { ok: false, code: string, message: string }} 校验结果。
 */
export function normalizeRounds(value, limits) {
  const maxRounds = Math.trunc(Number(limits?.maxRounds))
  const safeMax = Number.isFinite(maxRounds) && maxRounds >= 2 ? maxRounds : 9
  const defaultRounds = Math.trunc(Number(limits?.defaultRounds))
  const safeDefault = Number.isFinite(defaultRounds) && defaultRounds >= 2 ? defaultRounds : 3
  if (value === undefined || value === null || value === '') {
    return safeDefault > safeMax
      ? { ok: false, code: 'BAD-ROUNDS', message: `默认轮数配置 ${safeDefault} 超过上限 ${safeMax}。` }
      : { ok: true, rounds: safeDefault }
  }
  const rounds = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isSafeInteger(rounds) || rounds < 2 || rounds > safeMax) {
    return { ok: false, code: 'BAD-ROUNDS', message: `轮数必须是 2 到 ${safeMax} 之间的整数。` }
  }
  return { ok: true, rounds }
}
