/**
 * 存档运维（重命名 / 删除 / 索引补名）——纯 Node 实现，不 import 任何 @deepseek-ai 包。
 *
 * 服务层只做 HTTP 参数透传；真正的校验与落盘都在这里，
 * 方便用 node --test 直接覆盖（CONTRACT §8：测试不 import 宿主包）。
 */
import { rm, stat } from 'node:fs/promises'
import { assessBatchDeletion, isBatchActive, workspaceRootFromBatchDir } from './archive.js'
import { archiveRoundSessions, removeRoundArtifacts } from './cleanup.js'
import { messageOf, SpeedtestError } from './errors.js'
import { displayNameOf, validateBatchName } from './name.js'
import { formatLocalIso } from './paths.js'
import { toIndexEntry } from './state.js'
import { BatchStore, findBatchDirInIndex, removeGlobalIndexEntry, upsertGlobalIndex } from './store.js'

/**
 * 解析一个批次的目录：活跃批次内存记录优先，其次全局索引。
 * @param {any} runner 批次执行器（只需 liveRecord）。
 * @param {string} home DSH 家目录。
 * @param {string} batchId 批次 ID。
 * @returns {Promise<{ live: any, dir: string }>} 活跃记录（可能为 null）与批次目录。
 * @throws {SpeedtestError} BATCH-NOT-FOUND。
 */
export async function resolveBatchDir(runner, home, batchId) {
  const live = runner?.liveRecord?.(batchId) ?? null
  const dir = live?.batch?.batchDir ?? (await findBatchDirInIndex(home, batchId))
  if (typeof dir !== 'string' || dir === '') {
    throw new SpeedtestError('BATCH-NOT-FOUND', `找不到批次 ${batchId}。`)
  }
  return { live, dir }
}

/**
 * 给一条索引条目补显示名（DESIGN §6.3）：优先条目里的 name，
 * 否则读同目录 batch.json，最后按派生规则兜底；全程只读，不回写旧文件。
 * @param {string} home DSH 家目录。
 * @param {Record<string, any>} entry 索引条目。
 * @returns {Promise<Record<string, any>>} 带 name 的条目。
 */
export async function indexEntryWithName(home, entry) {
  const stored = validateBatchName(entry?.name)
  if (stored.ok) return { ...entry, name: stored.name }
  const dir = typeof entry?.dir === 'string' ? entry.dir : ''
  if (dir !== '') {
    try {
      const store = new BatchStore({ workspaceRoot: '', dshHome: home })
      const read = await store.readBatch(dir)
      if (read.exists && read.batch !== null) return { ...entry, name: displayNameOf(read.batch) }
    } catch {
      // 读不到 batch.json 时退回派生名，不影响列表。
    }
  }
  return { ...entry, name: displayNameOf(entry) }
}

/**
 * 重命名一个存档：只改显示名，写 batch.json + 全局索引（DESIGN §7.1）。
 * @param {{ runner: any, home: string, logger?: any, body?: Record<string, any> }} input 运行依赖与请求体。
 * @returns {Promise<{ ok: true, batchId: string, name: string }>} 响应体。
 * @throws {SpeedtestError} BAD-REQUEST / BAD-NAME / BATCH-NOT-FOUND / INTERNAL。
 */
export async function renameStoredBatch(input) {
  const batchId = typeof input?.body?.batchId === 'string' ? input.body.batchId.trim() : ''
  if (batchId === '') throw new SpeedtestError('BAD-REQUEST', '缺少 batchId。')
  const validated = validateBatchName(input?.body?.name)
  if (!validated.ok) throw new SpeedtestError(validated.code, validated.message)
  const { live, dir } = await resolveBatchDir(input.runner, input.home, batchId)
  const store = new BatchStore({
    workspaceRoot: live?.batch?.workspaceRoot ?? workspaceRootFromBatchDir(dir),
    dshHome: input.home,
  })
  let batch = live?.batch ?? null
  if (batch === null) {
    const read = await store.readBatch(dir)
    if (!read.exists || read.batch === null) {
      throw new SpeedtestError('BATCH-NOT-FOUND', `批次 ${batchId} 的 batch.json 不存在或无法读取。`)
    }
    batch = read.batch
  }
  batch.name = validated.name
  batch.nameUpdatedAt = formatLocalIso(new Date())
  try {
    await store.writeBatch(batch)
  } catch (error) {
    throw new SpeedtestError('INTERNAL', messageOf(error), { cause: error })
  }
  try {
    await upsertGlobalIndex(input.home, toIndexEntry(batch))
  } catch (error) {
    input.logger?.warn?.(`model-speedtest: 重命名后更新索引失败：${messageOf(error)}`)
  }
  return { ok: true, batchId, name: validated.name }
}

/**
 * 删除一个存档：校验通过后删批次目录并移除索引条目（DESIGN §7.2）。
 * @param {{ runner: any, home: string, body?: Record<string, any> }} input 运行依赖与请求体。
 * @returns {Promise<{ ok: true, batchId: string, filesRemoved: boolean, artifactsRemoved?: number, sessionsArchived?: number }>} 响应体。
 * @throws {SpeedtestError} CONFIRM-REQUIRED / BATCH-ACTIVE / BATCH-NOT-FOUND / DELETE-UNSAFE / DELETE-FAILED。
 */
export async function deleteStoredBatch(input) {
  if (input?.body?.confirm !== true) {
    throw new SpeedtestError('CONFIRM-REQUIRED', '删除存档需要显式确认：请求体必须带 "confirm": true。')
  }
  const batchId = typeof input?.body?.batchId === 'string' ? input.body.batchId.trim() : ''
  if (batchId === '') throw new SpeedtestError('BAD-REQUEST', '缺少 batchId。')
  const { live, dir } = await resolveBatchDir(input.runner, input.home, batchId)
  if (live !== null && isBatchActive(live.batch.status)) {
    throw new SpeedtestError('BATCH-ACTIVE', `批次 ${batchId} 仍在运行，请先取消再删除。`, { batchId })
  }
  // 目录已不存在：只移除索引条目（DESIGN §7.2 最后一段）。
  const info = await statIfExists(dir)
  if (info === null) {
    await removeGlobalIndexEntry(input.home, batchId)
    return { ok: true, batchId, filesRemoved: false }
  }
  if (!info.isDirectory()) {
    throw new SpeedtestError('DELETE-UNSAFE', `批次路径不是目录：${dir}`)
  }
  const store = new BatchStore({
    workspaceRoot: live?.batch?.workspaceRoot ?? workspaceRootFromBatchDir(dir),
    dshHome: input.home,
  })
  const read = await store.readBatch(dir)
  if (!read.exists || read.batch === null) {
    throw new SpeedtestError('DELETE-UNSAFE', `批次目录缺少可读的 batch.json，拒绝删除：${dir}`)
  }
  const workspaceRoot =
    live?.batch?.workspaceRoot ??
    (typeof read.batch.workspaceRoot === 'string' ? read.batch.workspaceRoot : workspaceRootFromBatchDir(dir))
  const verdict = assessBatchDeletion({ batchId, dir, workspaceRoot, batchDoc: read.batch })
  if (!verdict.ok) throw new SpeedtestError(verdict.code, verdict.message)
  // 先清轮次产物：批次目录一删，batch.json 里的 resultPath 就没了，工作区会留下 .speedtest/<runId> 残留。
  const artifacts = await removeRoundArtifacts(read.batch)
  const sessions = await archiveRoundSessions(input.ctx, read.batch)
  for (const warning of [...artifacts.warnings, ...sessions.warnings]) {
    input.logger?.warn?.(`model-speedtest: ${warning}`)
  }
  try {
    await rm(verdict.dir, { recursive: true, force: false })
  } catch (error) {
    // 删不掉时不删索引，避免“列表没了文件还在”。
    throw new SpeedtestError('DELETE-FAILED', `删除批次目录失败：${messageOf(error)}`)
  }
  await removeGlobalIndexEntry(input.home, batchId)
  return { ok: true, batchId, filesRemoved: true, artifactsRemoved: artifacts.removed, sessionsArchived: sessions.archived }
}

/**
 * stat 一个路径；不存在返回 null（删除存档时用来区分“目录已丢失”）。
 * @param {string} path 路径。
 * @returns {Promise<import('node:fs').Stats | null>} 文件信息或 null。
 */
async function statIfExists(path) {
  try {
    return await stat(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}
