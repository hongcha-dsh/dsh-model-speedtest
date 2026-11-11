/**
 * 删除存档的路径安全判定（DESIGN §7.2）。
 *
 * 纯逻辑，不碰文件系统：服务层先读出 batch.json，再把目录、工作区、
 * batch.json 一起交给 `assessBatchDeletion` 判定，只有 ok 才执行 fs.rm。
 * 任何一条不满足都拒绝删除，避免误删索引之外的东西。
 */
import { basename, dirname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { BATCHES_DIR_NAME, SPEEDTEST_DIR_NAME, batchesDir } from './paths.js'

/** 仍在运行、不允许删除的批次状态（DESIGN §7.2）。 */
export const ACTIVE_BATCH_STATUS = Object.freeze(['queued', 'running'])

/**
 * 批次是否仍在运行。
 * @param {unknown} status 批次状态。
 * @returns {boolean} 是否 queued/running。
 */
export function isBatchActive(status) {
  return typeof status === 'string' && ACTIVE_BATCH_STATUS.includes(status)
}

/**
 * 从 `<workspaceRoot>/.speedtest/batches/<batchId>` 反推工作区；形态不符返回空串。
 * @param {unknown} dir 批次目录。
 * @returns {string} 工作区绝对路径或空串。
 */
export function workspaceRootFromBatchDir(dir) {
  if (typeof dir !== 'string' || dir === '') return ''
  const absolute = resolve(dir)
  const batches = dirname(absolute)
  const root = dirname(batches)
  if (basename(batches) !== BATCHES_DIR_NAME) return ''
  if (basename(root) !== SPEEDTEST_DIR_NAME) return ''
  return dirname(root)
}

/**
 * Windows 路径比较用大小写不敏感（盘符与目录名都不区分大小写）。
 * @param {string} left 左路径。
 * @param {string} right 右路径。
 * @returns {boolean} 是否同一个路径。
 */
function samePath(left, right) {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase()
}

/**
 * 删除前的安全校验（DESIGN §7.2 的 1–4 条）。
 * @param {{
 *   batchId: string,
 *   dir: string,
 *   workspaceRoot: string,
 *   batchDoc: Record<string, any> | null,
 * }} input 待删除批次信息。
 * @returns {{ ok: true, dir: string } | { ok: false, code: string, message: string }} 判定结果。
 */
export function assessBatchDeletion(input) {
  const batchId = typeof input?.batchId === 'string' ? input.batchId : ''
  const rawDir = typeof input?.dir === 'string' ? input.dir : ''
  const workspaceRoot = typeof input?.workspaceRoot === 'string' ? input.workspaceRoot : ''
  if (batchId === '') {
    return { ok: false, code: 'DELETE-UNSAFE', message: '删除缺少批次 ID。' }
  }
  if (rawDir === '' || !isAbsolute(rawDir)) {
    return { ok: false, code: 'DELETE-UNSAFE', message: `批次目录不是绝对路径：${rawDir}` }
  }
  if (workspaceRoot === '' || !isAbsolute(workspaceRoot)) {
    return { ok: false, code: 'DELETE-UNSAFE', message: `无法确定批次工作区：${workspaceRoot}` }
  }
  const absolute = resolve(rawDir)
  // 1. 目录 basename 必须等于 batchId。
  if (basename(absolute) !== batchId) {
    return { ok: false, code: 'DELETE-UNSAFE', message: `批次目录名与批次 ID 不一致：${absolute}` }
  }
  // 2. 父目录必须是 <workspaceRoot>/.speedtest/batches。
  const parent = batchesDir(workspaceRoot)
  if (!samePath(dirname(absolute), parent)) {
    return { ok: false, code: 'DELETE-UNSAFE', message: `批次目录不在预期位置：${absolute}` }
  }
  // 3. 解析后的绝对路径不得逃出父目录。
  const inside = relative(resolve(parent), absolute)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return { ok: false, code: 'DELETE-UNSAFE', message: `批次目录跳出了批次根目录：${absolute}` }
  }
  // 4. batch.json 必须存在且 batchId 一致。
  const doc = input?.batchDoc
  if (doc === null || typeof doc !== 'object' || typeof doc.batchId !== 'string') {
    return { ok: false, code: 'DELETE-UNSAFE', message: '批次目录缺少可读的 batch.json，拒绝删除。' }
  }
  if (doc.batchId !== batchId) {
    return { ok: false, code: 'DELETE-UNSAFE', message: `batch.json 的批次 ID 与请求不一致：${doc.batchId}` }
  }
  return { ok: true, dir: absolute }
}
