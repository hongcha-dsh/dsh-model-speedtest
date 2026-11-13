/**
 * 批次状态机（纯逻辑，不 import 任何 @deepseek-ai 包）。
 *
 * CONTRACT §5.1：
 * - batch.status: queued | running | done | aborted | failed | interrupted
 * - rounds[].status: queued | running | passed | failed | timeout | aborted | no-report
 *
 * 这里只负责“数据怎么变、怎么判定”，不碰文件与 DSH 服务。
 */
import { displayNameOf } from './name.js'
import { statsOf } from './stats.js'

/** batch.status 取值。 */
export const BATCH_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  DONE: 'done',
  ABORTED: 'aborted',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
})

/** rounds[].status 取值。 */
export const ROUND_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  PASSED: 'passed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  NO_REPORT: 'no-report',
})

/** 连续多少轮没有结果文件就中止整个批次（CONTRACT §3.4）。 */
export const NO_REPORT_ABORT_THRESHOLD = 2

/** batch.json 的 schema 版本。 */
export const BATCH_SCHEMA_VERSION = 1

/**
 * 创建一条批次的初始记录（对应 batch.json）。
 * @param {{
 *   batchId: string,
 *   createdAt: string,
 *   controlSessionId: string,
 *   workspaceRoot: string,
 *   batchDir: string,
 *   rounds: number,
 *   env: Record<string, unknown>,
 *   skill: Record<string, unknown>,
 * }} input 初始信息。
 * @returns {Record<string, any>} batch.json 内容。
 */
export function createBatchRecord(input) {
  const total = Math.max(1, Math.trunc(input.rounds))
  return {
    schemaVersion: BATCH_SCHEMA_VERSION,
    batchId: input.batchId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    status: BATCH_STATUS.QUEUED,
    controlSessionId: input.controlSessionId,
    workspaceRoot: input.workspaceRoot,
    batchDir: input.batchDir,
    env: { ...input.env },
    skill: { ...input.skill },
    rounds: Array.from({ length: total }, (_value, offset) => ({
      index: offset + 1,
      sessionId: null,
      runCwd: null,
      status: ROUND_STATUS.QUEUED,
      runId: null,
      resultPath: null,
      reportPath: null,
      elapsedSeconds: null,
      speedTps: null,
      // 模型请求墙钟耗时与流式吐字速度（result.json 的 metrics.requestWallSeconds / speedTpsStreamSpan）。
      modelRequestSeconds: null,
      streamSpeedTps: null,
      toolSeconds: null,
      tokens: null,
      toolCount: null,
      devRequestCount: null,
      cacheHit: null,
      cacheReadTokens: null,
      summaryCacheHit: null,
      taskVersion: null,
      error: null,
    })),
    summary: emptySummary(total),
    notes: [],
  }
}

/**
 * 初始 summary（全部轮次在排队）。
 * @param {number} total 总轮数。
 * @returns {Record<string, any>} summary。
 */
export function emptySummary(total) {
  return {
    total,
    passed: 0,
    failed: 0,
    timeout: 0,
    aborted: 0,
    noReport: 0,
    stats: { elapsedSeconds: statsOf([]), speedTps: statsOf([]) },
  }
}

/**
 * 切换批次状态并刷新 updatedAt。
 * @param {Record<string, any>} batch 批次记录。
 * @param {string} status 新状态。
 * @param {string} updatedAt 更新时间（本地 ISO）。
 * @returns {Record<string, any>} 同一个批次记录（原地修改）。
 */
export function setBatchStatus(batch, status, updatedAt) {
  batch.status = status
  batch.updatedAt = updatedAt
  return batch
}

/**
 * 找到某一轮。
 * @param {Record<string, any>} batch 批次记录。
 * @param {number} index 轮次序号（从 1 开始）。
 * @returns {Record<string, any> | undefined} 轮次记录。
 */
export function findRound(batch, index) {
  return batch.rounds.find((round) => round.index === index)
}

/**
 * 标记某一轮开始执行。
 * @param {Record<string, any>} batch 批次记录。
 * @param {number} index 轮次序号。
 * @param {{ sessionId: string, runCwd: string, updatedAt: string }} input 本轮身份信息。
 * @returns {Record<string, any> | undefined} 被更新的轮次。
 */
export function beginRound(batch, index, input) {
  const round = findRound(batch, index)
  if (round === undefined) return undefined
  round.sessionId = input.sessionId
  round.runCwd = input.runCwd
  round.status = ROUND_STATUS.RUNNING
  round.error = null
  batch.updatedAt = input.updatedAt
  return round
}

/**
 * 落定某一轮的结果字段。
 * @param {Record<string, any>} batch 批次记录。
 * @param {number} index 轮次序号。
 * @param {Record<string, any>} patch 需要合并进轮次记录的字段。
 * @param {string} updatedAt 更新时间。
 * @returns {Record<string, any> | undefined} 被更新的轮次。
 */
export function settleRound(batch, index, patch, updatedAt) {
  const round = findRound(batch, index)
  if (round === undefined) return undefined
  Object.assign(round, patch)
  batch.updatedAt = updatedAt
  return round
}

/**
 * 从末尾数连续 no-report 的轮数。
 * @param {Array<Record<string, any>>} rounds 轮次数组。
 * @returns {number} 连续 no-report 轮数。
 */
export function countConsecutiveNoReport(rounds) {
  // 末尾尚未执行的 queued 轮次不算“连续无结果”的断点：它们只是还没跑。
  let cursor = rounds.length - 1
  while (cursor >= 0 && rounds[cursor].status === ROUND_STATUS.QUEUED) cursor -= 1
  let count = 0
  for (; cursor >= 0; cursor -= 1) {
    if (rounds[cursor].status !== ROUND_STATUS.NO_REPORT) break
    count += 1
  }
  return count
}

/**
 * 是否应因连续无结果而中止批次。
 * @param {Array<Record<string, any>>} rounds 轮次数组。
 * @param {number} [threshold] 阈值，默认 2。
 * @returns {boolean} 是否中止。
 */
export function shouldAbortForNoReport(rounds, threshold = NO_REPORT_ABORT_THRESHOLD) {
  return countConsecutiveNoReport(rounds) >= threshold
}

/**
 * 是否有轮次仍在运行。
 * @param {Array<Record<string, any>>} rounds 轮次数组。
 * @returns {boolean} 是否有 running 轮次。
 */
export function runningRound(rounds) {
  return rounds.find((round) => round.status === ROUND_STATUS.RUNNING)
}

/**
 * 汇总统计：各状态计数 + 耗时/速度统计。
 * @param {Array<Record<string, any>>} rounds 轮次数组。
 * @returns {Record<string, any>} summary。
 */
export function deriveSummary(rounds) {
  const countOf = (status) => rounds.filter((round) => round.status === status).length
  const elapsed = rounds
    .filter((round) => Number.isFinite(round.elapsedSeconds))
    .map((round) => round.elapsedSeconds)
  const speed = rounds
    .filter((round) => Number.isFinite(round.speedTps))
    .map((round) => round.speedTps)
  return {
    total: rounds.length,
    passed: countOf(ROUND_STATUS.PASSED),
    failed: countOf(ROUND_STATUS.FAILED),
    timeout: countOf(ROUND_STATUS.TIMEOUT),
    aborted: countOf(ROUND_STATUS.ABORTED),
    noReport: countOf(ROUND_STATUS.NO_REPORT),
    stats: {
      elapsedSeconds: statsOf(elapsed),
      speedTps: statsOf(speed),
    },
  }
}

/**
 * 批次正常跑完后应落的状态：有通过轮次 → done；一轮都没通过 → failed。
 * @param {Array<Record<string, any>>} rounds 轮次数组。
 * @returns {string} 批次状态。
 */
export function completionStatus(rounds) {
  const summary = deriveSummary(rounds)
  return summary.passed > 0 ? BATCH_STATUS.DONE : BATCH_STATUS.FAILED
}

/**
 * 收尾：写入 summary 与最终状态。
 * @param {Record<string, any>} batch 批次记录。
 * @param {{ status?: string, updatedAt: string, notes?: string[] }} input 收尾信息。
 * @returns {Record<string, any>} 同一个批次记录。
 */
export function finalizeBatch(batch, input) {
  batch.summary = deriveSummary(batch.rounds)
  batch.updatedAt = input.updatedAt
  if (Array.isArray(input.notes)) batch.notes.push(...input.notes)
  if (typeof input.status === 'string') batch.status = input.status
  return batch
}

/**
 * 计算给前端看 live 状态（CONTRACT §4.4）。
 * @param {Record<string, any>} batch 批次记录。
 * @returns {{ status: string, currentRound: number, totalRounds: number, phase: string }} live 视图。
 */
export function liveStateOf(batch) {
  const totalRounds = batch.rounds.length
  const running = runningRound(batch.rounds)
  const settled = batch.rounds.filter((round) => round.status !== ROUND_STATUS.QUEUED && round.status !== ROUND_STATUS.RUNNING).length
  const currentRound = running !== undefined ? running.index : Math.min(settled + 1, totalRounds)
  let phase
  switch (batch.status) {
    case BATCH_STATUS.QUEUED:
      phase = 'queued'
      break
    case BATCH_STATUS.RUNNING:
      phase = running !== undefined ? 'running' : 'starting'
      break
    default:
      phase = batch.status
  }
  return { status: batch.status, currentRound, totalRounds, phase }
}

/**
 * 生成全局索引条目（CONTRACT §4.3 / §5.3）。
 * @param {Record<string, any>} batch 批次记录。
 * @returns {Record<string, any>} 索引条目。
 */
export function toIndexEntry(batch) {
  const summary = batch.summary ?? deriveSummary(batch.rounds)
  return {
    batchId: batch.batchId,
    dir: batch.batchDir,
    createdAt: batch.createdAt,
    name: displayNameOf(batch),
    status: batch.status,
    env: {
      provider: batch.env?.provider ?? null,
      model: batch.env?.model ?? null,
      agentPreset: batch.env?.agentPreset ?? null,
    },
    rounds: batch.rounds.length,
    passed: summary.passed ?? 0,
    medians: {
      elapsedSeconds: summary.stats?.elapsedSeconds?.median ?? null,
      speedTps: summary.stats?.speedTps?.median ?? null,
    },
  }
}
