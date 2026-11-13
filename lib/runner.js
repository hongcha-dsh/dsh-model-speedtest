/**
 * 批次执行器：串行跑 N 轮，每轮新建根级 Agent 会话（CONTRACT §3.3 / §3.4）。
 *
 * 约定：
 * - 同一工作区同时只允许一个批次（锁 + 内存 live 表双重保护）；
 * - 每轮的会话 cwd 固定为所选工作区（会话按 cwd 归组，子目录会被算进“未分类”），
 *   每轮由 skill 在工作区 .speedtest/<runId> 下创建独立 run 目录；
 * - 独立 sessionId、独立结果文件；
 * - 失败不自动重试；连续 2 轮 no-report 中止整个批次；
 * - 超时/取消都走 `agent.cancel({ kind: 'user' })`，然后等一个短宽限再收尾；
 * - 卸载时取消活跃批次、dispose 已创建 Agent、释放锁（由 index.js 的 ctx.effect 调用）。
 */
import { randomUUID } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { readJsonIfExists } from './atomic.js'
import { archiveRoundSessions, removeRoundArtifacts } from './cleanup.js'
import {
  environmentWarnings,
  filterFreshCandidates,
  roundPatchFromResult,
  selectLatestResult,
  validateResultDocument,
} from './collect.js'
import { messageOf, SpeedtestError } from './errors.js'
import { formatLocalIso, globalIndexPath } from './paths.js'
import {
  BATCH_STATUS,
  ROUND_STATUS,
  beginRound,
  completionStatus,
  finalizeBatch,
  liveStateOf,
  shouldAbortForNoReport,
  settleRound,
  toIndexEntry,
} from './state.js'
import { runBatchSummary } from './summary.js'
import { upsertGlobalIndex } from './store.js'

/**
 * CONTRACT §3.3 的固定提示词，必须逐字一致。
 */
export const FIXED_PROMPT =
  '用测速功能帮我测速。这是自动批量测速的一轮：只执行本轮，不要向我提问，不要创建子代理，按 model-speed-load skill 的流程一次跑完。'

/** 取消/超时后等待 Agent 收尾的宽限（毫秒）。 */
const SETTLE_GRACE_MS = 15_000
/** 卸载时等待所有活跃批次收尾的上限（毫秒）。 */
const SHUTDOWN_GRACE_MS = 20_000

/**
 * 构造一条用户消息。使用宿主 `createUserMessage` 生成带 brand id 的冻结消息，
 * 避免手工构造缺少标识/冻结导致会话格式层拒绝。`source.kind` 用 `user`，
 * 与内置 controller 的普通提示词一致；归因由批次记录负责。
 * @param {string} text 提示词。
 * @returns {Record<string, any>} UserMessage。
 */
export function createPromptMessage(text = FIXED_PROMPT) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** 当前时间（本地 ISO）。 */
function nowIso() {
  return formatLocalIso(new Date())
}

/** 简单延时。 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * 批次执行器。
 */
export class BatchRunner {
  /**
   * @param {any} ctx Host 插件上下文。
   * @param {{ runTimeoutMinutes: number }} config 已解析配置（只用超时字段）。
   * @param {{
   *   home: string,
   *   composePreset: (presetId?: string) => Promise<{ agentPreset?: string, setup: (agentCtx: any) => any }>,
   *   summaryLoader?: (skillDir: string) => Promise<Record<string, any>>,
   * }} options 依赖。
   */
  constructor(ctx, config, options) {
    this.ctx = ctx
    this.config = config
    this.home = options.home
    this.composePreset = options.composePreset
    this.summaryLoader = options.summaryLoader
    /** @type {Map<string, Record<string, any>>} 活跃批次内存表。 */
    this.records = new Map()
  }

  /** @returns {number} 单轮超时毫秒数。 */
  timeouts() {
    const minutes =
      Number.isFinite(this.config?.runTimeoutMinutes) && this.config.runTimeoutMinutes >= 1
        ? this.config.runTimeoutMinutes
        : 10
    return { minutes, ms: minutes * 60_000 }
  }

  /**
   * 记录快照（给服务层读）。
   * @param {Record<string, any>} record 内部记录。
   * @returns {{ batch: Record<string, any>, live: Record<string, any> }} 快照。
   */
  snapshot(record) {
    return { batch: record.batch, live: liveStateOf(record.batch) }
  }

  /**
   * 某工作区是否有活跃批次。
   * @param {string} workspaceRoot 工作区。
   * @returns {{ batch: Record<string, any>, live: Record<string, any> } | null} 活跃批次快照。
   */
  busyFor(workspaceRoot) {
    for (const record of this.records.values()) {
      if (record.batch.workspaceRoot === workspaceRoot) return this.snapshot(record)
    }
    return null
  }

  /**
   * 任意活跃批次。
   * @returns {{ batch: Record<string, any>, live: Record<string, any> } | null} 快照。
   */
  anyLive() {
    const first = this.records.values().next()
    return first.done === true ? null : this.snapshot(first.value)
  }

  /**
   * 某控制会话发起的活跃批次。
   * @param {string} sessionId 控制会话 ID。
   * @returns {{ batch: Record<string, any>, live: Record<string, any> } | null} 快照。
   */
  activeBatchFor(sessionId) {
    for (const record of this.records.values()) {
      if (record.batch.controlSessionId === sessionId) return this.snapshot(record)
    }
    return null
  }

  /**
   * 按批次 ID 找活跃记录。
   * @param {string} batchId 批次 ID。
   * @returns {{ batch: Record<string, any>, live: Record<string, any> } | null} 快照。
   */
  liveRecord(batchId) {
    const record = this.records.get(batchId)
    return record === undefined ? null : this.snapshot(record)
  }

  /**
   * 启动批次（后台串行执行，立即返回）。
   * @param {Record<string, any>} batch 初始批次记录。
   * @param {import('./store.js').BatchStore} store 批次存储。
   * @returns {void}
   */
  start(batch, store) {
    const record = {
      batch,
      store,
      abortRequested: false,
      interrupted: false,
      abortListeners: new Set(),
      currentAgent: null,
      /** 当前批次已创建但尚未 dispose 的 Agent 句柄，卸载兜底用。 */
      handles: new Set(),
      promise: null,
    }
    this.records.set(batch.batchId, record)
    record.promise = this.#run(record).catch((error) => {
      this.ctx.logger?.warn?.(`model-speedtest: 批次 ${batch.batchId} 异常结束：${messageOf(error)}`)
    })
  }

  /**
   * 取消活跃批次：取消当前轮，落 aborted，释放锁。
   * @param {string} batchId 批次 ID。
   * @returns {Promise<void>} 完成。
   * @throws {Error} 批次不存在或已结束。
   */
  async cancel(batchId) {
    const record = this.records.get(batchId)
    if (record === undefined) {
      throw new SpeedtestError('BATCH-NOT-FOUND', `批次 ${batchId} 未在运行（可能已完成或已被取消）。`)
    }
    record.abortRequested = true
    for (const listener of record.abortListeners) {
      try {
        listener()
      } catch {
        /* 监听器只用于唤醒等待，不应影响取消 */
      }
    }
    try {
      record.currentAgent?.cancel?.({ kind: 'user' })
    } catch {
      /* 会话可能已经结束 */
    }
  }

  /**
   * 插件卸载：取消全部活跃批次、dispose 已创建 Agent、释放锁。
   * @returns {Promise<void>} 完成。
   */
  async shutdown() {
    const records = [...this.records.values()]
    for (const record of records) {
      record.interrupted = true
      record.abortRequested = true
      for (const listener of record.abortListeners) {
        try {
          listener()
        } catch {
          /* ignore */
        }
      }
      try {
        record.currentAgent?.cancel?.({ kind: 'user' })
      } catch {
        /* ignore */
      }
    }
    if (records.length === 0) return
    await Promise.race([Promise.allSettled(records.map((record) => record.promise)), delay(SHUTDOWN_GRACE_MS)])
    // 兜底：宽限期内没来得及收尾的 Agent 仍然要 dispose，避免卸载后留下活会话。
    for (const record of records) {
      for (const handle of record.handles) {
        try {
          await handle.dispose()
        } catch (error) {
          this.ctx.logger?.warn?.(`model-speedtest: 卸载时释放会话失败：${messageOf(error)}`)
        }
      }
      record.handles.clear()
    }
  }

  /**
   * 批次主流程。
   * @param {Record<string, any>} record 内部记录。
   * @returns {Promise<void>} 完成。
   */
  async #run(record) {
    const { batch, store } = record
    try {
      batch.status = BATCH_STATUS.RUNNING
      batch.updatedAt = nowIso()
      await store.writeBatch(batch)

      let noReportAbort = false
      for (const round of batch.rounds) {
        if (record.abortRequested) break
        await this.#runRound(record, round)
        if (shouldAbortForNoReport(batch.rounds)) {
          noReportAbort = true
          this.#note(batch, '连续 2 轮没有找到 result.json，已中止批次；后续轮次不再执行。')
          break
        }
      }

      if (record.abortRequested) {
        for (const round of batch.rounds) {
          if (round.status === ROUND_STATUS.QUEUED || round.status === ROUND_STATUS.RUNNING) {
            round.status = ROUND_STATUS.ABORTED
            round.error = round.error ?? (record.interrupted ? '插件已卸载，批次中断。' : '批次已取消。')
          }
        }
      }

      let finalStatus
      if (record.interrupted) finalStatus = BATCH_STATUS.INTERRUPTED
      else if (record.abortRequested) finalStatus = BATCH_STATUS.ABORTED
      else if (noReportAbort) finalStatus = BATCH_STATUS.FAILED
      else finalStatus = completionStatus(batch.rounds)

      finalizeBatch(batch, { status: finalStatus, updatedAt: nowIso() })
      await store.writeBatch(batch)

      try {
        await this.#summarize(record)
      } catch (error) {
        this.#note(batch, `汇总生成异常：${messageOf(error)}`)
      }
      await store.writeBatch(batch)
      await this.#updateIndex(batch)
    } catch (error) {
      this.#note(batch, `批次执行失败：${messageOf(error)}`)
      const status = record.interrupted ? BATCH_STATUS.INTERRUPTED : BATCH_STATUS.FAILED
      finalizeBatch(batch, { status, updatedAt: nowIso() })
      try {
        await store.writeBatch(batch)
        await this.#updateIndex(batch)
      } catch {
        /* 落盘失败时保留内存状态，卸载流程不再抛错 */
      }
    } finally {
      record.currentAgent = null
      // 跑完清理：删除轮次产物、归档测速会话，只保留本存档记录（batch.json / repeat.json / summary.md）。
      try {
        await this.#cleanup(record)
      } catch (error) {
        this.ctx.logger?.warn?.(`model-speedtest: 清理批次产物失败：${messageOf(error)}`)
      }
      this.records.delete(batch.batchId)
      try {
        const released = await store.releaseLock(batch.batchId)
        if (!released.released && released.reason !== 'no-lock' && released.reason !== 'other-batch') {
          this.ctx.logger?.warn?.(`model-speedtest: 释放锁失败（${released.reason}）`)
        }
      } catch (error) {
        this.ctx.logger?.warn?.(`model-speedtest: 释放锁失败：${messageOf(error)}`)
      }
    }
  }

  /**
   * 执行一轮。
   * @param {Record<string, any>} record 批次记录。
   * @param {Record<string, any>} round 轮次记录。
   * @returns {Promise<void>} 完成。
   */
  async #runRound(record, round) {
    const { batch, store } = record
    const warnings = []
    // 会话 cwd 用工作区本身：DSH 按 session 头的 cwd 归组，子目录会被算进“未分类”。
    const runCwd = batch.workspaceRoot
    const sessionId = `session-${randomUUID()}`
    beginRound(batch, round.index, { sessionId, runCwd, updatedAt: nowIso() })
    await store.writeBatch(batch)

    /** @type {any} */
    let handle = null
    try {
      // 取消已经到达：不再创建新会话，直接落 aborted。
      if (record.abortRequested) {
        settleRound(batch, round.index, { status: ROUND_STATUS.ABORTED, error: '批次已取消。' }, nowIso())
        return
      }
      const lockWarning = await this.#clearSkillLock(record)
      if (lockWarning !== null) warnings.push(lockWarning)
      const baseline = await this.#snapshotResults(record, runCwd)
      const composition = await this.composePreset(batch.env?.agentPreset ?? undefined)
      const agentOptions = { provider: batch.env.provider, model: batch.env.model }
      if (typeof batch.env.reasoningEffort === 'string' && batch.env.reasoningEffort !== '') {
        agentOptions.reasoningEffort = batch.env.reasoningEffort
      }
      handle = await this.ctx.agents.create({
        sessionId,
        agentOptions,
        meta: {
          cwd: runCwd,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        setup: composition.setup,
      })
      record.handles.add(handle)
      record.currentAgent = handle.agent

      if (record.abortRequested) {
        handle.agent.cancel({ kind: 'user' })
      }

      const permissionWarning = await this.#inheritPermission(record, handle.agent)
      if (permissionWarning !== null) warnings.push(permissionWarning)

      handle.agent.followup(createPromptMessage())
      const waitResult = await this.#waitSettled(record, handle.agent)
      if (waitResult !== 'idle') {
        try {
          handle.agent.cancel({ kind: 'user' })
        } catch {
          /* 已经停止 */
        }
        await Promise.race([Promise.resolve(handle.agent.whenIdle()).catch(() => {}), delay(SETTLE_GRACE_MS)])
      }

      // 收轮：先找结果文件并校验，再 flush + dispose，最后原子更新 batch.json。
      const collected = await this.#collectRound(record, round, runCwd, baseline)
      if (collected.kind === 'ok') {
        const status =
          waitResult === 'timeout'
            ? ROUND_STATUS.TIMEOUT
            : waitResult === 'aborted'
              ? ROUND_STATUS.ABORTED
              : collected.patch.status
        const error =
          waitResult === 'timeout'
            ? `超过 ${this.timeouts().minutes} 分钟未完成，已取消本轮。`
            : waitResult === 'aborted'
              ? '批次已取消。'
              : collected.patch.error
        settleRound(batch, round.index, { ...collected.patch, status, error }, nowIso())
      } else if (collected.kind === 'invalid') {
        const status =
          waitResult === 'timeout'
            ? ROUND_STATUS.TIMEOUT
            : waitResult === 'aborted'
              ? ROUND_STATUS.ABORTED
              : ROUND_STATUS.FAILED
        settleRound(
          batch,
          round.index,
          {
            status,
            error:
              waitResult === 'timeout'
                ? `超过 ${this.timeouts().minutes} 分钟未完成，已取消本轮。`
                : waitResult === 'aborted'
                  ? '批次已取消。'
                  : collected.error,
            resultPath: collected.resultPath,
          },
          nowIso(),
        )
      } else if (waitResult === 'timeout') {
        settleRound(batch, round.index, { status: ROUND_STATUS.TIMEOUT, error: `超过 ${this.timeouts().minutes} 分钟未完成，已取消本轮。` }, nowIso())
      } else if (waitResult === 'aborted') {
        settleRound(batch, round.index, { status: ROUND_STATUS.ABORTED, error: '批次已取消。' }, nowIso())
      } else {
        settleRound(batch, round.index, { status: ROUND_STATUS.NO_REPORT, error: '本轮没有找到 result.json。' }, nowIso())
      }
      for (const warning of [...warnings, ...collected.warnings]) this.#note(batch, warning)
    } catch (error) {
      const status = record.abortRequested ? ROUND_STATUS.ABORTED : ROUND_STATUS.FAILED
      settleRound(batch, round.index, { status, error: messageOf(error) }, nowIso())
      for (const warning of warnings) this.#note(batch, warning)
    } finally {
      record.currentAgent = null
      await this.#flushAndDispose(record, handle, warnings)
      if (handle !== null && handle !== undefined) record.handles.delete(handle)
      for (const warning of warnings) this.#note(batch, warning)
      try {
        await store.writeBatch(batch)
      } catch (error) {
        this.ctx.logger?.warn?.(`model-speedtest: 写入 batch.json 失败：${messageOf(error)}`)
      }
    }
  }

  /**
   * 等 Agent 空闲，最长 timeout；返回 idle / timeout / aborted。
   * @param {Record<string, any>} record 内部记录。
   * @param {any} agent 本轮 Agent。
   * @returns {Promise<'idle' | 'timeout' | 'aborted'>} 等待结果。
   */
  #waitSettled(record, agent) {
    return new Promise((resolve) => {
      let settled = false
      let timer = null
      /** @type {null | (() => void)} */
      let onAbort = null
      const finish = (value) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        if (onAbort !== null) record.abortListeners.delete(onAbort)
        resolve(value)
      }
      onAbort = () => finish('aborted')
      if (record.abortRequested) {
        finish('aborted')
        return
      }
      record.abortListeners.add(onAbort)
      timer = setTimeout(() => finish('timeout'), this.timeouts().ms)
      if (typeof timer.unref === 'function') timer.unref()
      Promise.resolve(agent.whenIdle()).then(
        () => finish('idle'),
        () => finish('idle'),
      )
    })
  }

  /**
   * 权限预设继承；custom/auto/服务缺失时只记警告，不阻断（CONTRACT §3.3）。
   * @param {Record<string, any>} record 内部记录。
   * @param {any} agent 本轮 Agent。
   * @returns {Promise<string | null>} 警告文本或 null。
   */
  async #inheritPermission(record, agent) {
    const preset = record.batch.env?.permissionPreset
    if (typeof preset !== 'string' || preset === '') return '批次没有记录权限预设，新会话使用默认权限。'
    if (preset === 'custom' || preset === 'auto') {
      return `权限预设为 ${preset}，无法自动继承，新会话可能停在审批处。`
    }
    const permissions = this.ctx.get('permissionPresets')
    if (!permissions || typeof permissions.set !== 'function') {
      return '没有 permissionPresets 服务，无法继承权限预设。'
    }
    try {
      await permissions.set(agent.session, preset)
      return null
    } catch (error) {
      return `权限预设 ${preset} 继承失败：${messageOf(error)}`
    }
  }

  /**
   * 清理上一轮/上一批遗留的 skill 锁（<workspace>/.speedtest/.lock）。
   * 批次运行期间该工作区由本批次独占，遗留锁只会让下一轮的 measure start 报 BUSY。
   * @param {Record<string, any>} record 内部记录。
   * @returns {Promise<string | null>} 清理说明或 null。
   */
  async #clearSkillLock(record) {
    const lockPath = join(record.batch.workspaceRoot, '.speedtest', '.lock')
    try {
      const info = await stat(lockPath)
      if (!info.isFile()) return null
      // 只清理“本批次自己的”锁：runId 属于本批次已跑轮次，或锁创建于本批次开始之后。
      // 手工测速（在批次开始前就已持锁）不动它，让 measure start 按 BUSY 如实报错。
      let lock = null
      try {
        lock = JSON.parse(await readFile(lockPath, 'utf8'))
      } catch {
        lock = null
      }
      const runId = lock !== null && typeof lock === 'object' && typeof lock.runId === 'string' ? lock.runId : ''
      const ownedByRound = runId !== '' && record.batch.rounds.some((round) => round.runId === runId)
      const startedAt = lock !== null && typeof lock === 'object' ? Date.parse(String(lock.startedAt ?? '')) : NaN
      const batchStartedAt = Date.parse(String(record.batch.createdAt ?? ''))
      const createdDuringBatch =
        Number.isFinite(startedAt) && Number.isFinite(batchStartedAt) && startedAt >= batchStartedAt
      if (!ownedByRound && !createdDuringBatch) return null
      await rm(lockPath, { force: true })
      return `已清理本批次上一轮遗留的测速锁：${lockPath}`
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      return `检查测速锁失败：${messageOf(error)}`
    }
  }

  /**
   * 记录本轮开始前已存在的 result.json，供收轮时排除历史结果。
   * @param {Record<string, any>} record 内部记录。
   * @param {string} runCwd 本轮 cwd（= 工作区）。
   * @returns {Promise<Set<string>>} 已存在的 result.json 路径集合。
   */
  async #snapshotResults(record, runCwd) {
    try {
      const candidates = await record.store.listResultCandidates(runCwd)
      return new Set(candidates.map((candidate) => candidate.path))
    } catch {
      return new Set()
    }
  }

  /**
   * 收轮：找 result.json、校验版本、抽取指标与环境警告。
   *
   * 本轮 cwd 是工作区根，.speedtest 下会同时存在历史 run；baseline 记录本轮开始前
   * 已存在的 result.json，收轮时只认新出现的那个，避免把上一轮/上一批的结果算进本轮。
   * @param {Record<string, any>} record 内部记录。
   * @param {Record<string, any>} round 轮次记录。
   * @param {string} runCwd 本轮 cwd（= 工作区）。
   * @param {Set<string>} baseline 本轮开始前已存在的 result.json 路径。
   * @returns {Promise<Record<string, any>>} 收集结果。
   */
  async #collectRound(record, round, runCwd, baseline) {
    const warnings = []
    let candidates
    try {
      candidates = filterFreshCandidates(await record.store.listResultCandidates(runCwd), baseline)
    } catch (error) {
      return { kind: 'invalid', error: `扫描结果目录失败：${messageOf(error)}`, warnings, resultPath: null }
    }
    const selected = selectLatestResult(candidates)
    if (!selected.ok) return { kind: 'no-report', warnings: [], resultPath: null }
    if (selected.warning !== null) warnings.push(selected.warning)
    const read = await readJsonIfExists(selected.path)
    if (!read.exists || read.error !== null) {
      return {
        kind: 'invalid',
        error: `result.json 无法读取或解析：${read.error ?? '文件不存在'}（${selected.path}）`,
        warnings,
        resultPath: null,
      }
    }
    const valid = validateResultDocument(read.value)
    if (!valid.ok) {
      return { kind: 'invalid', error: `${selected.path}：${valid.message}`, warnings, resultPath: null }
    }
    const reportPath = await record.store.reportPathFor(selected.path)
    const patch = roundPatchFromResult(read.value, { resultPath: selected.path, reportPath })
    const identityWarnings = environmentWarnings(
      patch._envIdentity,
      record.batch.env,
      round.index,
      patch._environmentFlags,
    )
    delete patch._envIdentity
    delete patch._environmentFlags
    return { kind: 'ok', patch, warnings: [...warnings, ...identityWarnings], resultPath: selected.path }
  }

  /**
   * flush 后 dispose 本轮 Agent（CONTRACT §3.4 第 3 步）。
   * @param {Record<string, any>} record 内部记录。
   * @param {any} handle Agent 句柄。
   * @param {string[]} warnings 警告收集器。
   * @returns {Promise<void>} 完成。
   */
  async #flushAndDispose(record, handle, warnings) {
    if (handle === null || handle === undefined) return
    try {
      const flushed = await this.ctx.sessions.flush(handle.agent.session)
      if (flushed === false) warnings.push('会话持久化没有确认 flush（可能没有持久化监听者）。')
    } catch (error) {
      warnings.push(`flush 会话失败：${messageOf(error)}`)
    }
    try {
      await handle.dispose()
    } catch (error) {
      warnings.push(`释放会话失败：${messageOf(error)}`)
    }
  }

  /**
   * 跑完清理：删除每轮的 run 目录（result/report/task 等产物），并归档测速会话。
   *
   * 只保留批次目录下的记录文件（batch.json / repeat.json / summary.md），
   * 这样用户不必关心测速会话被归到哪个工作区，侧边栏也不会留下测试对话。
   * @param {Record<string, any>} record 内部记录。
   * @returns {Promise<void>} 完成。
   */
  async #cleanup(record) {
    const { batch, store } = record
    const warnings = []
    // 删产物 / 归档会话的逻辑与「删存档」共用（lib/cleanup.js），避免两处漂移。
    const artifacts = await removeRoundArtifacts(batch)
    const removedRuns = artifacts.removed
    warnings.push(...artifacts.warnings)
    const lockWarning = await this.#clearSkillLock(record)
    if (lockWarning !== null) warnings.push(lockWarning)

    const sessions = await archiveRoundSessions(this.ctx, batch)
    const archived = sessions.archived
    warnings.push(...sessions.warnings)

    batch.artifactsRemoved = true
    batch.artifactsRemovedAt = nowIso()
    this.#note(batch, `已清理 ${removedRuns} 个轮次产物目录、归档 ${archived} 个测速会话；仅保留本存档记录。`)
    for (const warning of warnings) this.#note(batch, warning)
    try {
      await store.writeBatch(batch)
      await this.#updateIndex(batch)
    } catch (error) {
      this.ctx.logger?.warn?.(`model-speedtest: 清理后写回记录失败：${messageOf(error)}`)
    }
  }

  /**
   * 调用 skill 的 repeat.mjs 生成批次汇总。
   * @param {Record<string, any>} record 内部记录。
   * @returns {Promise<void>} 完成。
   */
  async #summarize(record) {
    const { batch } = record
    const runs = batch.rounds
      .filter((round) => typeof round.resultPath === 'string' && round.resultPath !== '')
      .map((round) => round.resultPath)
    const rounds = batch.rounds
      .filter((round) => typeof round.resultPath !== 'string' || round.resultPath === '')
      .map((round) => ({ index: round.index, status: round.status, error: round.error }))
    const summary = await runBatchSummary({
      skillDir: batch.skill?.dir,
      workspace: batch.workspaceRoot,
      runs,
      outDir: batch.batchDir,
      rounds,
      ...(typeof this.summaryLoader === 'function' ? { loader: this.summaryLoader } : {}),
    })
    if (summary.ok) {
      this.#note(batch, '已生成 repeat.json 与 summary.md。')
      // repeat.mjs 判定环境不一致时拒绝合并中位数，把标记透传给面板（CONTRACT §6）。
      if (summary.result?.environment?.consistent === false) {
        batch.summary = { ...batch.summary, environmentMismatch: true }
        this.#note(batch, '各轮环境不一致（provider/model/agentPreset/工具哈希不同），已拒绝合并中位数。')
      }
      return
    }
    this.#note(batch, `汇总未生成：${summary.error}`)
  }

  /**
   * 更新全局索引（失败只告警，不影响批次结果）。
   * @param {Record<string, any>} batch 批次记录。
   * @returns {Promise<void>} 完成。
   */
  async #updateIndex(batch) {
    try {
      await upsertGlobalIndex(this.home, toIndexEntry(batch))
    } catch (error) {
      this.ctx.logger?.warn?.(
        `model-speedtest: 更新全局索引失败（${globalIndexPath(this.home)}）：${messageOf(error)}`,
      )
    }
  }

  /**
   * 去重追加一条批次说明。
   * @param {Record<string, any>} batch 批次记录。
   * @param {string} text 说明文本。
   * @returns {void}
   */
  #note(batch, text) {
    if (typeof text !== 'string' || text.trim() === '') return
    if (!Array.isArray(batch.notes)) batch.notes = []
    if (batch.notes.includes(text)) return
    batch.notes.push(text)
  }
}
