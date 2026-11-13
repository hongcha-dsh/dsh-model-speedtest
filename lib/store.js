/**
 * 批次落盘（只依赖 node:fs / node:path，不 import @deepseek-ai/*）。
 *
 * 负责：批次目录与锁、batch.json 原子读写、单轮结果文件发现、全局索引读写。
 * 业务判定（状态、统计）留在 state.js / collect.js 里，方便用 node --test 覆盖。
 */
import { mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readJsonIfExists, readTextIfExists, writeJsonAtomic, writeTextAtomic } from './atomic.js'
import { RESULT_FILE_NAME, REPORT_FILE_NAME, isExcludedResultPath } from './collect.js'
import { assessLock, buildLock, parseLockText } from './lock.js'
import { emptyIndex, findIndexEntry, parseIndexText, removeIndexEntry, upsertIndexEntry } from './index-store.js'
import {
  batchesDir,
  batchDir,
  batchJsonPath,
  globalIndexPath,
  lockPath,
  speedtestRoot,
} from './paths.js'

/**
 * 原子获取文件锁并写入 JSON 内容；已存在则返回 EEXIST。
 * @param {string} file 锁文件。
 * @param {string} text 内容文本。
 * @returns {Promise<{ ok: true } | { ok: false, conflict: string | null }>} 获取结果。
 */
async function createExclusiveFile(file, text) {
  await mkdir(dirname(file), { recursive: true })
  let handle
  try {
    handle = await open(file, 'wx')
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const existing = await readTextIfExists(file)
      const verdict = assessLock({ exists: true, text: existing.text })
      return { ok: false, conflict: verdict.busy ? verdict.batchId : null }
    }
    throw error
  }
  try {
    await handle.writeFile(text, 'utf8')
    return { ok: true }
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 单个工作区的批次存储。
 */
export class BatchStore {
  /**
   * @param {{ workspaceRoot: string, dshHome: string }} options 工作区与 DSH 家目录。
   */
  constructor(options) {
    this.workspaceRoot = options.workspaceRoot
    this.dshHome = options.dshHome
  }

  /** @returns {string} 批次根目录。 */
  get batchesRoot() {
    return batchesDir(this.workspaceRoot)
  }

  /** @returns {string} 锁文件路径。 */
  get lockFile() {
    return lockPath(this.workspaceRoot)
  }

  /**
   * 确保工作区可用于写测速数据（顺带完成 WORKSPACE-INVALID 检查）。
   * @returns {Promise<{ ok: true } | { ok: false, message: string }>} 检查结果。
   */
  async ensureWorkspaceWritable() {
    try {
      await mkdir(this.batchesRoot, { recursive: true })
      const probe = join(speedtestRoot(this.workspaceRoot), `.write-probe-${process.pid}`)
      await writeFile(probe, 'probe', 'utf8')
      await rm(probe, { force: true })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: `工作区不可写：${this.workspaceRoot}（${message}）` }
    }
  }

  /**
   * 创建批次目录。
   * @param {string} batchId 批次 ID。
   * @returns {Promise<string>} 批次目录。
   */
  async ensureBatchDir(batchId) {
    const dir = batchDir(this.workspaceRoot, batchId)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * 尝试获取锁。
   * @param {string} batchId 批次 ID。
   * @returns {Promise<{ ok: true } | { ok: false, batchId: string | null }>} 获取结果。
   */
  async acquireLock(batchId) {
    const content = buildLock({
      batchId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })
    return createExclusiveFile(this.lockFile, `${JSON.stringify(content)}\n`)
  }

  /**
   * 释放锁（仅当锁属于该批次或锁内容损坏时）。
   * @param {string} batchId 批次 ID。
   * @returns {Promise<{ released: boolean, reason: string }>} 释放结果。
   */
  async releaseLock(batchId) {
    const existing = await readTextIfExists(this.lockFile)
    if (!existing.exists) return { released: false, reason: 'no-lock' }
    const parsed = parseLockText(existing.text ?? '')
    if (!parsed.ok) {
      await rm(this.lockFile, { force: true })
      return { released: true, reason: 'corrupt-lock' }
    }
    if (parsed.lock.batchId !== batchId) return { released: false, reason: 'other-batch' }
    await rm(this.lockFile, { force: true })
    return { released: true, reason: 'released' }
  }

  /**
   * 强制删锁（/api/speedtest/unlock 使用）。
   * @returns {Promise<void>} 完成。
   */
  async forceReleaseLock() {
    await rm(this.lockFile, { force: true })
  }

  /**
   * 读取当前锁。
   * @returns {Promise<{ exists: boolean, text: string | null }>} 锁文件内容。
   */
  async readLock() {
    return readTextIfExists(this.lockFile)
  }

  /**
   * 原子写 batch.json。
   * @param {Record<string, any>} batch 批次记录。
   * @returns {Promise<void>} 完成。
   */
  async writeBatch(batch) {
    await writeJsonAtomic(batchJsonPath(batch.batchDir), batch)
  }

  /**
   * 读取某个批次目录下的 batch.json。
   * @param {string} dir 批次目录。
   * @returns {Promise<{ exists: boolean, batch: Record<string, any> | null, error: string | null }>} 读取结果。
   */
  async readBatch(dir) {
    const read = await readJsonIfExists(batchJsonPath(dir))
    if (!read.exists) return { exists: false, batch: null, error: null }
    if (read.error !== null) return { exists: true, batch: null, error: read.error }
    return { exists: true, batch: read.value, error: null }
  }

  /**
   * 发现某一轮 cwd 下的结果文件候选。
   * @param {string} runCwd 本轮 cwd。
   * @returns {Promise<Array<{ path: string, relative: string, mtimeMs: number }>>} 候选列表。
   */
  async listResultCandidates(runCwd) {
    const root = join(runCwd, '.speedtest')
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const candidates = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (isExcludedResultPath(entry.name)) continue
      const resultPath = join(root, entry.name, RESULT_FILE_NAME)
      try {
        const info = await stat(resultPath)
        if (!info.isFile()) continue
        candidates.push({
          path: resultPath,
          relative: `${entry.name}/${RESULT_FILE_NAME}`,
          mtimeMs: info.mtimeMs,
        })
      } catch (error) {
        if (error && error.code === 'ENOENT') continue
        throw error
      }
    }
    return candidates
  }

  /**
   * 推断同目录的 report.md 路径（存在才返回）。
   * @param {string} resultPath result.json 路径。
   * @returns {Promise<string | null>} report.md 路径或 null。
   */
  async reportPathFor(resultPath) {
    const reportPath = join(resultPath, '..', REPORT_FILE_NAME)
    try {
      const info = await stat(reportPath)
      return info.isFile() ? reportPath : null
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
  }
}

/**
 * 读取全局索引；损坏时返回空索引 + 警告，不抛错。
 * @param {string} dshHome DSH 家目录。
 * @returns {Promise<{ index: { schemaVersion: number, batches: Array<Record<string, any>> }, warning: string | null }>} 读取结果。
 */
export async function readGlobalIndex(dshHome) {
  const read = await readTextIfExists(globalIndexPath(dshHome))
  if (!read.exists) return { index: emptyIndex(), warning: null }
  const parsed = parseIndexText(read.text ?? '')
  return { index: parsed.index, warning: parsed.warning }
}

/**
 * 原子写全局索引。
 * @param {string} dshHome DSH 家目录。
 * @param {{ schemaVersion: number, batches: Array<Record<string, any>> }} index 索引。
 * @returns {Promise<void>} 完成。
 */
export async function writeGlobalIndex(dshHome, index) {
  await writeJsonAtomic(globalIndexPath(dshHome), index)
}

/**
 * 写入/更新一条全局索引。
 * @param {string} dshHome DSH 家目录。
 * @param {Record<string, any>} entry 索引条目。
 * @returns {Promise<{ index: { batches: Array<Record<string, any>> }, warning: string | null }>} 更新后的索引。
 */
export async function upsertGlobalIndex(dshHome, entry) {
  const current = await readGlobalIndex(dshHome)
  const next = upsertIndexEntry(current.index, entry)
  await writeGlobalIndex(dshHome, next)
  return { index: next, warning: current.warning }
}

/**
 * 按批次 ID 在全局索引里找批次目录。
 * @param {string} dshHome DSH 家目录。
 * @param {string} batchId 批次 ID。
 * @returns {Promise<string | null>} 批次目录或 null。
 */
export async function findBatchDirInIndex(dshHome, batchId) {
  const { index } = await readGlobalIndex(dshHome)
  const entry = findIndexEntry(index, batchId)
  return entry && typeof entry.dir === 'string' ? entry.dir : null
}

/**
 * 从全局索引里移除一条（删除存档用，DESIGN §7.2）。
 * @param {string} dshHome DSH 家目录。
 * @param {string} batchId 批次 ID。
 * @returns {Promise<{ removed: boolean, warning: string | null }>} 移除结果。
 */
export async function removeGlobalIndexEntry(dshHome, batchId) {
  const current = await readGlobalIndex(dshHome)
  const next = removeIndexEntry(current.index, batchId)
  const removed = next.batches.length !== current.index.batches.length
  if (removed) await writeGlobalIndex(dshHome, next)
  return { removed, warning: current.warning }
}
