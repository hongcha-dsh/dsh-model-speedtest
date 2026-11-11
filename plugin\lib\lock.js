/**
 * 批次锁内容与解锁判定（纯逻辑）。
 *
 * CONTRACT §5.2：`<workspaceRoot>/.speedtest/batches/.lock` 内容为
 * `{ batchId, pid, startedAt }`；CONTRACT §4.6：`/api/speedtest/unlock`
 * 只在无活跃批次且锁存在时释放，且必须 `confirm === true`。
 */

/** 锁记录的字段白名单（不写多余字段，避免锁文件里出现凭据/提示词）。 */
const LOCK_FIELDS = ['batchId', 'pid', 'startedAt']

/**
 * 构造锁内容。
 * @param {{ batchId: string, pid: number, startedAt: string }} input 锁信息。
 * @returns {{ batchId: string, pid: number, startedAt: string }} 锁内容。
 */
export function buildLock(input) {
  return { batchId: input.batchId, pid: input.pid, startedAt: input.startedAt }
}

/**
 * 解析锁文件文本。
 * @param {string} text 锁文件内容。
 * @returns {{ ok: true, lock: { batchId: string, pid: number, startedAt: string } } | { ok: false, reason: string }} 解析结果。
 */
export function parseLockText(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text))
  } catch {
    return { ok: false, reason: '锁文件不是合法 JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: '锁文件不是 JSON 对象' }
  }
  for (const field of LOCK_FIELDS) {
    if (!(field in parsed)) return { ok: false, reason: `锁文件缺少字段 ${field}` }
  }
  if (typeof parsed.batchId !== 'string' || parsed.batchId === '') {
    return { ok: false, reason: '锁文件 batchId 无效' }
  }
  if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
    return { ok: false, reason: '锁文件 pid 无效' }
  }
  if (typeof parsed.startedAt !== 'string' || parsed.startedAt === '') {
    return { ok: false, reason: '锁文件 startedAt 无效' }
  }
  return { ok: true, lock: { batchId: parsed.batchId, pid: parsed.pid, startedAt: parsed.startedAt } }
}

/**
 * 判断工作区当前是否被锁占用（BUSY 判定）。
 * @param {{ exists: boolean, text?: string | null }} input 锁文件读取结果。
 * @returns {{ busy: false } | { busy: true, batchId: string | null, corrupt: boolean, message: string }} 判定结果。
 */
export function assessLock(input) {
  if (input?.exists !== true) return { busy: false }
  const parsed = parseLockText(input.text ?? '')
  if (!parsed.ok) {
    return {
      busy: true,
      batchId: null,
      corrupt: true,
      message: `工作区已存在测速锁，但内容无法解析（${parsed.reason}）；确认没有批次在跑后可解锁。`,
    }
  }
  return {
    busy: true,
    batchId: parsed.lock.batchId,
    corrupt: false,
    message: `工作区已有测速批次锁：${parsed.lock.batchId}（pid ${parsed.lock.pid}）。`,
  }
}

/**
 * 解除锁的准入判定（CONTRACT §4.6）。
 * @param {{ confirm?: unknown, activeBatchId?: string | null, lockExists: boolean }} input 请求与现状。
 * @returns {{ ok: true } | { ok: false, code: string, message: string, extra?: Record<string, unknown> }} 判定结果。
 */
export function unlockVerdict(input) {
  if (input?.confirm !== true) {
    return {
      ok: false,
      code: 'CONFIRM-REQUIRED',
      message: '解锁需要显式确认：请求体必须带 "confirm": true。',
    }
  }
  if (typeof input.activeBatchId === 'string' && input.activeBatchId !== '') {
    return {
      ok: false,
      code: 'BUSY',
      message: `仍有活跃批次 ${input.activeBatchId}，不能解锁；请先取消或等待其完成。`,
      extra: { batchId: input.activeBatchId },
    }
  }
  if (input.lockExists !== true) {
    return { ok: false, code: 'LOCK-NOT-FOUND', message: '当前没有可释放的锁。' }
  }
  return { ok: true }
}
