/**
 * 存档名称：派生、校验、显示名（DESIGN §6）。
 *
 * 纯逻辑，只依赖标准库：
 * - 派生名只用于显示与索引，不回写旧 batch.json（DESIGN §6.2）；
 * - 只有用户重命名才写入 `name` / `nameUpdatedAt`（DESIGN §6.1）。
 */

/** 名称最大长度（DESIGN §6.1）。 */
export const NAME_MAX_LENGTH = 80

/** 控制字符（DESIGN §6.1：不允许控制字符）。 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/u

/** 两位补零。 */
function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * 校验用户提交的名称：trim 后 1–80 个字符、不含控制字符。
 * @param {unknown} raw 请求体里的 name。
 * @returns {{ ok: true, name: string } | { ok: false, code: string, message: string }} 校验结果。
 */
export function validateBatchName(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, code: 'BAD-NAME', message: '名称必须是字符串。' }
  }
  const name = raw.trim()
  if (name === '') {
    return { ok: false, code: 'BAD-NAME', message: '名称不能为空。' }
  }
  if (CONTROL_CHARS.test(name)) {
    return { ok: false, code: 'BAD-NAME', message: '名称不能包含控制字符（换行、制表符等）。' }
  }
  if ([...name].length > NAME_MAX_LENGTH) {
    return { ok: false, code: 'BAD-NAME', message: `名称最多 ${NAME_MAX_LENGTH} 个字符。` }
  }
  return { ok: true, name }
}

/**
 * 从 createdAt 里取出「MM-DD HH:mm」。
 *
 * createdAt 是本插件自己写的带偏移本地 ISO（CONTRACT §5.1），直接读字面量
 * 才能保证显示的就是记录时的本地时间，不受运行机器时区影响。
 * @param {unknown} createdAt 批次创建时间。
 * @returns {string} `MM-DD HH:mm`；无法解析时为空串。
 */
export function monthDayTimeOf(createdAt) {
  if (typeof createdAt !== 'string' || createdAt === '') return ''
  const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(createdAt)
  if (matched !== null) return `${matched[2]}-${matched[3]} ${matched[4]}:${matched[5]}`
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ''
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/**
 * 派生默认名称（DESIGN §6.2）：
 * - model 已知：`<model> · <MM-DD HH:mm>`
 * - model 未知（或时间无法解析）：`批次 <batchId 前 8 位>`
 * @param {{ model?: unknown, createdAt?: unknown, batchId?: unknown }} input 批次信息。
 * @returns {string} 派生名称。
 */
export function deriveBatchName(input) {
  const model = typeof input?.model === 'string' ? input.model.trim() : ''
  const batchId = typeof input?.batchId === 'string' ? input.batchId : ''
  const time = monthDayTimeOf(input?.createdAt)
  if (model !== '' && time !== '') return `${model} · ${time}`
  const prefix = batchId.slice(0, 8)
  return prefix === '' ? '未命名批次' : `批次 ${prefix}`
}

/**
 * 一条存档/索引条目的显示名：优先已保存的 name，否则按派生规则显示。
 * @param {Record<string, any>} batch batch.json 或索引条目。
 * @returns {string} 显示名。
 */
export function displayNameOf(batch) {
  const stored = typeof batch?.name === 'string' ? batch.name.trim() : ''
  if (stored !== '' && !CONTROL_CHARS.test(stored) && [...stored].length <= NAME_MAX_LENGTH) return stored
  return deriveBatchName({
    model: batch?.env?.model,
    createdAt: batch?.createdAt,
    batchId: batch?.batchId,
  })
}
