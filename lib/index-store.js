/**
 * 全局索引（`$DSH_HOME/speedtest/index.json`）的纯逻辑（CONTRACT §4.3 / §5.3）。
 *
 * - 只保留最近 200 条；
 * - 只存环境身份摘要与统计结果，不存 Key / URL 凭据 / 完整提示词；
 * - 文件损坏时返回空列表并记录警告，不阻断。
 */

/** 索引 schema 版本。 */
export const INDEX_SCHEMA_VERSION = 1
/** 索引最多保留条数。 */
export const INDEX_LIMIT = 200

/**
 * 空索引。
 * @returns {{ schemaVersion: number, batches: Array<Record<string, any>> }} 空索引。
 */
export function emptyIndex() {
  return { schemaVersion: INDEX_SCHEMA_VERSION, batches: [] }
}

/** 索引条目至少要有字符串 batchId。 */
function isEntryLike(value) {
  return value !== null && typeof value === 'object' && typeof value.batchId === 'string' && value.batchId !== ''
}

/**
 * 解析索引文件文本。
 * @param {string} text 文件内容。
 * @returns {{ ok: boolean, index: { schemaVersion: number, batches: Array<Record<string, any>> }, warning: string | null }} 解析结果。
 */
export function parseIndexText(text) {
  let parsed
  try {
    parsed = JSON.parse(String(text))
  } catch {
    return { ok: false, index: emptyIndex(), warning: '全局索引文件无法解析，已按空列表处理。' }
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.batches)) {
    return { ok: false, index: emptyIndex(), warning: '全局索引文件结构不符合预期，已按空列表处理。' }
  }
  return {
    ok: true,
    index: { schemaVersion: INDEX_SCHEMA_VERSION, batches: parsed.batches.filter(isEntryLike) },
    warning: null,
  }
}

/**
 * 按条数上限裁剪索引（保持顺序）。
 * @param {{ schemaVersion: number, batches: Array<Record<string, any>> }} index 索引。
 * @param {number} [limit] 上限，默认 200。
 * @returns {{ schemaVersion: number, batches: Array<Record<string, any>> }} 裁剪后的索引。
 */
export function trimIndex(index, limit = INDEX_LIMIT) {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : INDEX_LIMIT
  const batches = Array.isArray(index?.batches) ? index.batches : []
  return { schemaVersion: INDEX_SCHEMA_VERSION, batches: batches.slice(0, safeLimit) }
}

/**
 * 写入/更新一条索引条目：同 batchId 旧的被替换，新条目排在最前，最后裁剪。
 * @param {{ schemaVersion: number, batches: Array<Record<string, any>> }} index 索引。
 * @param {Record<string, any>} entry 新条目。
 * @param {number} [limit] 上限。
 * @returns {{ schemaVersion: number, batches: Array<Record<string, any>> }} 新索引。
 */
/**
 * 从索引里移除一条（删除存档用，DESIGN §7.2）。
 * @param {{ schemaVersion: number, batches: Array<Record<string, any>> }} index 索引。
 * @param {string} batchId 批次 ID。
 * @returns {{ schemaVersion: number, batches: Array<Record<string, any>> }} 新索引。
 */
export function removeIndexEntry(index, batchId) {
  if (typeof batchId !== 'string' || batchId === '') return trimIndex(index)
  const batches = (Array.isArray(index?.batches) ? index.batches : []).filter(
    (existing) => existing.batchId !== batchId,
  )
  return { schemaVersion: INDEX_SCHEMA_VERSION, batches }
}

export function upsertIndexEntry(index, entry, limit = INDEX_LIMIT) {
  if (!isEntryLike(entry)) return trimIndex(index, limit)
  const batches = (Array.isArray(index?.batches) ? index.batches : []).filter(
    (existing) => existing.batchId !== entry.batchId,
  )
  return trimIndex({ schemaVersion: INDEX_SCHEMA_VERSION, batches: [entry, ...batches] }, limit)
}

/**
 * 读取索引中的一条。
 * @param {{ batches: Array<Record<string, any>> }} index 索引。
 * @param {string} batchId 批次 ID。
 * @returns {Record<string, any> | null} 条目，找不到为 null。
 */
export function findIndexEntry(index, batchId) {
  if (typeof batchId !== 'string' || batchId === '') return null
  const batches = Array.isArray(index?.batches) ? index.batches : []
  for (const entry of batches) if (entry.batchId === batchId) return entry
  return null
}
