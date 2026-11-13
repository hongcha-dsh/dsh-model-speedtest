/**
 * 批次产物清理：删掉每轮的 run 目录（result.json / report.md / 任务文件）并归档测速会话。
 *
 * 跑完一个批次（runner.#cleanup）和删除一个存档（archive-ops.deleteStoredBatch）都要做同一件事，
 * 抽到这里避免两处逻辑漂移：否则「删存档」会只删批次目录、把 .speedtest/<runId> 留在工作区里。
 */
import { rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { messageOf } from './errors.js'

/**
 * 删除批次里每一轮的产物目录。
 *
 * 只删工作区 .speedtest 下的目录：resultPath 由本插件写入，但删文件属于破坏性操作，
 * 所以再校验一次相对路径不越界（CONTRACT §7.3）。
 * @param {Record<string, any>} batch 批次记录。
 * @returns {Promise<{ removed: number, warnings: string[] }>} 删除数量与告警。
 */
export async function removeRoundArtifacts(batch) {
  const warnings = []
  let removed = 0
  const workspaceRoot = typeof batch?.workspaceRoot === 'string' ? batch.workspaceRoot : ''
  const rounds = Array.isArray(batch?.rounds) ? batch.rounds : []
  for (const round of rounds) {
    const runDir = roundDirOf(round, workspaceRoot)
    if (runDir === null) continue
    const speedtestRoot = join(workspaceRoot, '.speedtest')
    const inside = relative(speedtestRoot, runDir)
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      warnings.push(`跳过不在工作区 .speedtest 下的产物目录：${runDir}`)
      continue
    }
    try {
      await rm(runDir, { recursive: true, force: true })
      removed += 1
    } catch (error) {
      warnings.push(`清理轮次产物失败：${messageOf(error)}`)
    }
  }
  return { removed, warnings }
}

/**
 * 归档批次里的测速会话（侧边栏不再显示测试对话）。
 * @param {any} ctx Cordis 上下文（用来取 workspaceRegistry）。
 * @param {Record<string, any>} batch 批次记录。
 * @returns {Promise<{ archived: number, warnings: string[] }>} 归档数量与告警。
 */
export async function archiveRoundSessions(ctx, batch) {
  const warnings = []
  let archived = 0
  const rounds = Array.isArray(batch?.rounds) ? batch.rounds : []
  const registry = ctx?.get?.('workspaceRegistry')
  if (registry === undefined || registry === null || typeof registry.archiveSession !== 'function') {
    warnings.push('没有 workspaceRegistry 服务，测速会话未归档。')
    return { archived, warnings }
  }
  for (const round of rounds) {
    if (typeof round?.sessionId !== 'string' || round.sessionId === '') continue
    try {
      await registry.archiveSession(round.sessionId)
      archived += 1
    } catch (error) {
      warnings.push(`归档测速会话失败（${round.sessionId}）：${messageOf(error)}`)
    }
  }
  return { archived, warnings }
}

/**
 * 取一轮的产物目录：优先 resultPath 的父目录，其次 runId。
 * @param {Record<string, any>} round 轮次记录。
 * @param {string} workspaceRoot 工作区根目录。
 * @returns {string | null} 目录路径。
 */
function roundDirOf(round, workspaceRoot) {
  if (typeof round?.resultPath === 'string' && round.resultPath !== '') return dirname(round.resultPath)
  if (typeof round?.runId === 'string' && round.runId !== '' && workspaceRoot !== '') {
    return join(workspaceRoot, '.speedtest', round.runId)
  }
  return null
}
