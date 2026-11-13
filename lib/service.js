/**
 * Host 服务层：环境快照、前置检查、批次启动/查询/取消/解锁。
 *
 * 这里集中所有“需要 DSH 服务”的读取，路由与命令都只调用本层，
 * 保证 HTTP 与命令两条入口走同一套校验与错误码（CONTRACT §3.2 / §4）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { normalizeRounds } from './command.js'
import { deleteStoredBatch, indexEntryWithName, renameStoredBatch } from './archive-ops.js'
import { messageOf, SpeedtestError, statusOfCode, toSpeedtestError } from './errors.js'
import { displayNameOf } from './name.js'
import { expandHomePath, formatLocalIso, makeBatchId, resolveWorkspaceRoot } from './paths.js'
import { BatchStore, findBatchDirInIndex, readGlobalIndex, upsertGlobalIndex } from './store.js'
import { createBatchRecord, toIndexEntry } from './state.js'
import { unlockVerdict } from './lock.js'

/** skill 相对 DSH_HOME 的目录。 */
const SKILL_RELATIVE = ['skills', 'model-speed-load']

/**
 * 随插件分发的 skill 副本（仓库根 `skill/model-speed-load/`）。
 * 市场用户机器上通常没有这个 skill，插件负责在缺失时把它装到 `$DSH_HOME/skills/model-speed-load`。
 */
const BUNDLED_SKILL_DIR = fileURLToPath(new URL('../skill/model-speed-load/', import.meta.url))

/**
 * 递归复制目录（skill 只有普通文件与目录，不需要保留权限位/符号链接）。
 * @param {string} from 源目录。
 * @param {string} to 目标目录。
 * @returns {Promise<void>} 完成。
 */
async function copySkillTree(from, to) {
  await mkdir(to, { recursive: true })
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      await copySkillTree(source, target)
    } else if (entry.isFile()) {
      await copyFile(source, target)
    }
  }
}

/**
 * 确保测速 skill 在 `$DSH_HOME/skills/model-speed-load` 存在且可读。
 *
 * - 已经存在（`SKILL.md` + `scripts/measure.mjs`）时不覆盖，尊重用户自己的版本；
 * - 缺失时把随插件分发的副本复制过去（市场一键安装因此不需要额外步骤）；
 * - 复制失败不抛异常，由调用方把原因透传到界面/错误码。
 * @returns {Promise<{ dir: string, provisioned: boolean, error: string | null }>} 安装结果。
 */
export async function ensureSkillInstalled() {
  const dir = dshHomePath(...SKILL_RELATIVE)
  const skillFile = join(dir, 'SKILL.md')
  const measureFile = join(dir, 'scripts', 'measure.mjs')
  const present = async () => {
    try {
      await stat(skillFile)
      await stat(measureFile)
      return true
    } catch {
      return false
    }
  }
  if (await present()) return { dir, provisioned: false, error: null }
  try {
    await copySkillTree(BUNDLED_SKILL_DIR, dir)
    if (!(await present())) throw new Error('复制后仍缺少 SKILL.md 或 scripts/measure.mjs')
    return { dir, provisioned: true, error: null }
  } catch (error) {
    return { dir, provisioned: false, error: messageOf(error) }
  }
}

/**
 * 读取 skill 快照：目录、skillHash（SKILL.md + measure.mjs 的 sha256 前 16 位）、taskVersion。
 * @returns {Promise<{ ok: true, dir: string, skillHash: string, taskVersion: string | null, provisioned: boolean } | { ok: false, message: string }>} 快照。
 */
export async function readSkillSnapshot() {
  const installed = await ensureSkillInstalled()
  const dir = installed.dir
  const skillFile = join(dir, 'SKILL.md')
  const measureFile = join(dir, 'scripts', 'measure.mjs')
  let skillText
  let measureText
  try {
    skillText = await readFile(skillFile, 'utf8')
    measureText = await readFile(measureFile, 'utf8')
  } catch (error) {
    const extra = installed.error === null ? '' : `；随插件自带副本安装失败：${installed.error}`
    return {
      ok: false,
      message: `测速 skill 不可用：缺少 ${skillFile} 或 ${measureFile}（${messageOf(error)}）${extra}。`,
    }
  }
  const hash = createHash('sha256').update(skillText).update('\n---\n').update(measureText).digest('hex')
  const version = /export const TASK_VERSION\s*=\s*'([^']+)'/u.exec(measureText)
  return {
    ok: true,
    dir,
    skillHash: hash.slice(0, 16),
    taskVersion: version === null ? null : version[1],
    provisioned: installed.provisioned,
  }
}

/**
 * 读取控制会话的模型与预设身份（CONTRACT §3.1）。
 * @param {any} ctx Host 上下文。
 * @param {any} agent 控制会话的 Agent。
 * @param {any} session 控制会话。
 * @returns {{ provider: string, model: string, reasoningEffort: string | null, agentPreset: string | null, permissionPreset: string | null }} 环境快照。
 * @throws {SpeedtestError} NO-MODEL 当没有 provider/model。
 */
export function snapshotEnvironment(ctx, agent, session) {
  let current
  try {
    current = agent?.model?.current?.()
  } catch (error) {
    throw new SpeedtestError('NO-MODEL', `无法读取当前模型选择：${messageOf(error)}`)
  }
  if (current === null || current === undefined || typeof current.provider !== 'string' || typeof current.model !== 'string' || current.provider === '' || current.model === '') {
    throw new SpeedtestError('NO-MODEL', '当前会话没有可用的 provider/model，请先在输入框选择模型再测速。')
  }
  let agentPreset = null
  try {
    const presets = ctx.get('agentPresets')
    if (presets && typeof presets.presetForSession === 'function') {
      const value = presets.presetForSession(session)
      agentPreset = typeof value === 'string' && value !== '' ? value : null
    }
  } catch {
    agentPreset = null
  }
  let permissionPreset = null
  try {
    const permissions = ctx.get('permissionPresets')
    if (permissions && typeof permissions.current === 'function') {
      const value = permissions.current(session)
      permissionPreset = typeof value === 'string' && value !== '' ? value : null
    }
  } catch {
    permissionPreset = null
  }
  return {
    provider: current.provider,
    model: current.model,
    reasoningEffort: typeof current.reasoningEffort === 'string' ? current.reasoningEffort : null,
    agentPreset,
    permissionPreset,
  }
}

/**
 * 测速 Host 服务。
 */
export class SpeedtestService {
  /**
   * @param {any} ctx Host 插件上下文。
   * @param {{ workspaceRoot: string, defaultRounds: number, maxRounds: number, runTimeoutMinutes: number }} config 已解析配置。
   * @param {any} runner 批次执行器。
   * @param {{ home?: string }} [options] 可注入 DSH 家目录（测试/诊断用）。
   */
  constructor(ctx, config, runner, options = {}) {
    this.ctx = ctx
    this.config = config
    this.runner = runner
    this.home = options.home ?? dshHomePath()
  }

  /** @returns {{ defaultRounds: number, maxRounds: number, runTimeoutMinutes: number }} 轮数与超时限制。 */
  limits() {
    const maxRounds = Number.isSafeInteger(this.config.maxRounds) && this.config.maxRounds >= 2 ? this.config.maxRounds : 9
    const defaultRounds = Number.isSafeInteger(this.config.defaultRounds) && this.config.defaultRounds >= 2 ? this.config.defaultRounds : 3
    return {
      defaultRounds: Math.min(defaultRounds, maxRounds),
      maxRounds,
      runTimeoutMinutes:
        Number.isFinite(this.config.runTimeoutMinutes) && this.config.runTimeoutMinutes >= 1
          ? this.config.runTimeoutMinutes
          : 10,
    }
  }

  /**
   * 解析控制会话与 Agent（SESSION-NOT-FOUND）。
   * @param {unknown} sessionId 会话 ID。
   * @returns {{ agent: any, session: any }} 控制会话。
   * @throws {SpeedtestError} 会话不存在。
   */
  resolveControl(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new SpeedtestError('SESSION-NOT-FOUND', '缺少 sessionId，请从某个对话里触发 /speedtest。')
    }
    const agents = this.ctx.agents
    const sessions = this.ctx.sessions
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    const session = agent?.session ?? (typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined)
    if (agent === undefined || session === undefined) {
      throw new SpeedtestError('SESSION-NOT-FOUND', `找不到会话 ${sessionId}，请刷新页面后重试。`)
    }
    return { agent, session }
  }

  /**
   * 计算默认工作区（配置优先，否则控制会话 cwd）。
   * @param {any} session 控制会话。
   * @returns {string} 工作区绝对路径；无法确定时为空串。
   */
  defaultWorkspace(session) {
    const resolved = resolveWorkspaceRoot({
      configured: this.config.workspaceRoot,
      sessionCwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : '',
    })
    return resolved.ok ? resolved.workspaceRoot : ''
  }

  /**
   * GET /api/speedtest/context 的数据。
   * @param {{ sessionId: string }} query 查询参数。
   * @returns {Promise<Record<string, any>>} context 响应体。
   */
  async context(query) {
    const control = this.resolveControl(query.sessionId)
    // 面板打开时不应因“还没选模型”而崩掉：环境缺失降级成空值 + 警告，由客户端提示。
    let env
    let warning = null
    try {
      env = snapshotEnvironment(this.ctx, control.agent, control.session)
    } catch (error) {
      const normalized = toSpeedtestError(error)
      warning = normalized.message
      env = {
        provider: '',
        model: '',
        reasoningEffort: null,
        agentPreset: null,
        permissionPreset: null,
      }
    }
    const skill = await readSkillSnapshot()
    const limits = this.limits()
    const workspaceRoot = this.defaultWorkspace(control.session)
    const live = this.runner.activeBatchFor(control.session.id) ?? this.runner.anyLive()
    const notes = []
    if (warning !== null) notes.push(warning)
    if (skill.ok && skill.provisioned === true) {
      notes.push(
        `已把插件自带的测速 skill 安装到 ${skill.dir}；如果本轮测速提示找不到 model-speed-load skill，重启一次 DSH 即可。`,
      )
    }
    return {
      ok: true,
      context: {
        sessionId: control.session.id ?? query.sessionId,
        cwd: typeof control.session.header?.cwd === 'string' ? control.session.header.cwd : '',
        env,
        defaults: {
          rounds: limits.defaultRounds,
          maxRounds: limits.maxRounds,
          workspaceRoot,
          runTimeoutMinutes: limits.runTimeoutMinutes,
        },
        skill: skill.ok
          ? {
              dir: skill.dir,
              skillHash: skill.skillHash,
              taskVersion: skill.taskVersion,
              provisioned: skill.provisioned === true,
            }
          : { dir: join(this.home, ...SKILL_RELATIVE), skillHash: null, taskVersion: null, provisioned: false },
        activeBatch:
          live === null || live === undefined
            ? null
            : {
                batchId: live.batch.batchId,
                // CONTRACT §4.1 只约定了 "running"；排队中的批次对面板同样是“进行中”。
                status: 'running',
                currentRound: live.live.currentRound,
                rounds: live.batch.rounds.length,
              },
        ...(notes.length === 0 ? {} : { warning: notes.join(' ') }),
      },
    }
  }

  /**
   * POST /api/speedtest/batches：前置检查 + 建批次记录 + 后台启动。
   * @param {{ sessionId?: unknown, rounds?: unknown, workspaceRoot?: unknown, permissionPreset?: unknown }} body 请求体。
   * @returns {Promise<{ ok: true, batchId: string, batchDir: string, rounds: number, env: Record<string, any> }>} 响应体。
   * @throws {SpeedtestError} 前置检查失败。
   */
  async startBatch(body) {
    const control = this.resolveControl(body?.sessionId)
    const env = snapshotEnvironment(this.ctx, control.agent, control.session)
    const skill = await readSkillSnapshot()
    if (!skill.ok) throw new SpeedtestError('SKILL-MISSING', skill.message)

    const limits = this.limits()
    const rounds = normalizeRounds(body?.rounds, limits)
    if (!rounds.ok) throw new SpeedtestError(rounds.code, rounds.message)

    const configuredWorkspace =
      typeof body?.workspaceRoot === 'string' && body.workspaceRoot.trim() !== ''
        ? body.workspaceRoot
        : this.config.workspaceRoot
    const workspace = resolveWorkspaceRoot({
      configured: configuredWorkspace,
      sessionCwd: typeof control.session.header?.cwd === 'string' ? control.session.header.cwd : '',
    })
    if (!workspace.ok) throw new SpeedtestError(workspace.code, workspace.message)

    const requestedPermission =
      typeof body?.permissionPreset === 'string' && body.permissionPreset.trim() !== ''
        ? body.permissionPreset.trim()
        : null
    const permissionPreset = requestedPermission ?? env.permissionPreset
    const batchEnv = { ...env, permissionPreset }

    const busy = this.runner.busyFor(workspace.workspaceRoot)
    if (busy !== null) {
      throw new SpeedtestError('BUSY', `工作区已有测速批次在运行：${busy.batch.batchId}。`, {
        batchId: busy.batch.batchId,
        workspaceRoot: workspace.workspaceRoot,
      })
    }

    const store = new BatchStore({ workspaceRoot: workspace.workspaceRoot, dshHome: this.home })
    const writable = await store.ensureWorkspaceWritable()
    if (!writable.ok) throw new SpeedtestError('WORKSPACE-INVALID', writable.message)

    const now = new Date()
    const batchId = makeBatchId(now, randomBytes(2).toString('hex'))
    const dir = await store.ensureBatchDir(batchId)
    const lock = await store.acquireLock(batchId)
    if (!lock.ok) {
      const conflict = lock.conflict === null ? '' : `（已有批次 ${lock.conflict}）`
      throw new SpeedtestError('BUSY', `工作区已有测速批次锁${conflict}，请先等待其完成或手动解锁。`, {
        batchId: lock.conflict,
        workspaceRoot: workspace.workspaceRoot,
      })
    }

    const batch = createBatchRecord({
      batchId,
      createdAt: formatLocalIso(now),
      controlSessionId: control.session.id ?? String(body?.sessionId),
      workspaceRoot: workspace.workspaceRoot,
      batchDir: dir,
      rounds: rounds.rounds,
      env: batchEnv,
      skill: { dir: skill.dir, skillHash: skill.skillHash, taskVersion: skill.taskVersion },
    })
    if (permissionPreset === 'custom' || permissionPreset === 'auto' || permissionPreset === null) {
      batch.notes.push(
        `权限预设为 ${permissionPreset ?? '未知'}，新会话可能停在审批处；建议先切到固定权限预设再测速。`,
      )
    }
    try {
      await store.writeBatch(batch)
    } catch (error) {
      await store.releaseLock(batchId).catch(() => {})
      throw toSpeedtestError(error, 'INTERNAL')
    }

    this.runner.start(batch, store)
    try {
      await upsertGlobalIndex(this.home, toIndexEntry(batch))
    } catch (error) {
      this.ctx.logger?.warn?.(`model-speedtest: 写入全局索引失败：${messageOf(error)}`)
    }
    return { ok: true, batchId, batchDir: dir, rounds: rounds.rounds, env: batchEnv }
  }

  /**
   * GET /api/speedtest/batch 的数据。
   * @param {{ id: string }} query 查询参数。
   * @returns {Promise<Record<string, any>>} 响应体。
   * @throws {SpeedtestError} BATCH-NOT-FOUND。
   */
  async readBatch(query) {
    const batchId = typeof query?.id === 'string' ? query.id.trim() : ''
    if (batchId === '') throw new SpeedtestError('BAD-REQUEST', '缺少批次 ID。')
    const live = this.runner.liveRecord(batchId)
    const dir = live?.batch?.batchDir ?? (await findBatchDirInIndex(this.home, batchId))
    if (typeof dir !== 'string' || dir === '') {
      throw new SpeedtestError('BATCH-NOT-FOUND', `找不到批次 ${batchId}。`)
    }
    const store = new BatchStore({ workspaceRoot: live?.batch?.workspaceRoot ?? process.cwd(), dshHome: this.home })
    const read = await store.readBatch(dir)
    if (!read.exists || read.batch === null) {
      throw new SpeedtestError('BATCH-NOT-FOUND', `批次 ${batchId} 的 batch.json 不存在或无法读取。`)
    }
    return { ok: true, batch: read.batch, live: live === null ? null : live.live }
  }

  /**
   * POST /api/speedtest/batch/rename：只改显示名（DESIGN §7.1）。
   * @param {{ batchId?: unknown, name?: unknown }} body 请求体。
   * @returns {Promise<{ ok: true, batchId: string, name: string }>} 响应体。
   * @throws {SpeedtestError} BAD-NAME / BATCH-NOT-FOUND / INTERNAL。
   */
  async renameBatch(body) {
    return renameStoredBatch({ runner: this.runner, home: this.home, logger: this.ctx.logger, body })
  }

  /**
   * POST /api/speedtest/batch/delete：确认后删除批次目录与索引条目（DESIGN §7.2）。
   * @param {{ batchId?: unknown, confirm?: unknown }} body 请求体。
   * @returns {Promise<{ ok: true, batchId: string, filesRemoved: boolean, artifactsRemoved?: number, sessionsArchived?: number }>} 响应体。
   * @throws {SpeedtestError} CONFIRM-REQUIRED / BATCH-ACTIVE / BATCH-NOT-FOUND / DELETE-UNSAFE / DELETE-FAILED。
   */
  async deleteBatch(body) {
    return deleteStoredBatch({ runner: this.runner, home: this.home, logger: this.ctx.logger, ctx: this.ctx, body })
  }

  /**
   * GET /api/speedtest/workspaces 的数据：插件页「开始」按钮要显式指定工作区。
   *
   * 不传 workspaceId 时 DSH 的 startSession 会落到"当前或最近的工作区"，
   * 结果就是产物可能写进 DSH 安装目录（D:\DeepSeek Harness\.speedtest）。
   * @returns {Promise<{ ok: true, workspaces: Array<{ workspaceId: string, path: string, title: string }> }>} 响应体。
   * @throws {SpeedtestError} NO-WORKSPACE。
   */
  async listWorkspaces() {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined || registry === null || typeof registry.list !== 'function') {
      throw new SpeedtestError('NO-WORKSPACE', '没有 workspaceRegistry 服务，无法列出工作区。')
    }
    const workspaces = []
    for (const workspace of registry.list()) {
      const workspaceId = typeof workspace?.id === 'string' ? workspace.id : ''
      const path = typeof workspace?.path === 'string' ? workspace.path : ''
      if (workspaceId === '' || path === '') continue
      const title = typeof workspace?.title === 'string' && workspace.title !== '' ? workspace.title : path
      workspaces.push({ workspaceId, path, title })
    }
    return { ok: true, workspaces }
  }

  /**
   * GET /api/speedtest/status 的数据：插件页没有会话上下文时的只读概览。
   * @returns {Promise<Record<string, any>>} 响应体。
   */
  async status() {
    const limits = this.limits()
    const live = this.runner.anyLive()
    const skill = await readSkillSnapshot()
    return {
      ok: true,
      defaults: {
        rounds: limits.defaultRounds,
        maxRounds: limits.maxRounds,
        runTimeoutMinutes: limits.runTimeoutMinutes,
      },
      skill: skill.ok
        ? { dir: skill.dir, skillHash: skill.skillHash, taskVersion: skill.taskVersion }
        : { dir: join(this.home, ...SKILL_RELATIVE), skillHash: null, taskVersion: null },
      activeBatch:
        live === null || live === undefined
          ? null
          : {
              batchId: live.batch.batchId,
              status: live.batch.status,
              currentRound: live.live.currentRound,
              rounds: live.batch.rounds.length,
              workspaceRoot: live.batch.workspaceRoot,
            },
    }
  }

  /**
   * GET /api/speedtest/index 的数据。
   * @param {{ limit?: string | number }} query 查询参数。
   * @returns {Promise<Record<string, any>>} 响应体。
   */
  async readIndex(query) {
    const { index, warning } = await readGlobalIndex(this.home)
    const requested = Number(query?.limit)
    const limit = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 200) : 20
    if (warning !== null) this.ctx.logger?.warn?.(`model-speedtest: ${warning}`)
    const rows = await Promise.all(
      index.batches.slice(0, limit).map((entry) => indexEntryWithName(this.home, entry)),
    )
    return {
      ok: true,
      batches: rows.map(normalizeEntry),
      ...(warning === null ? {} : { warning }),
    }
  }

  /**
   * POST /api/speedtest/batch/cancel：取消当前轮并标记 aborted。
   * @param {{ batchId?: unknown }} body 请求体。
   * @returns {Promise<{ ok: true }>} 响应体。
   * @throws {SpeedtestError} BATCH-NOT-FOUND。
   */
  async cancelBatch(body) {
    const batchId = typeof body?.batchId === 'string' ? body.batchId.trim() : ''
    if (batchId === '') throw new SpeedtestError('BAD-REQUEST', '缺少 batchId。')
    await this.runner.cancel(batchId)
    return { ok: true }
  }

  /**
   * POST /api/speedtest/unlock：仅在无活跃批次且锁存在时释放。
   * @param {{ workspaceRoot?: unknown, confirm?: unknown }} body 请求体。
   * @returns {Promise<{ ok: true }>} 响应体。
   * @throws {SpeedtestError} 前置检查失败。
   */
  async unlock(body) {
    const rawWorkspace = typeof body?.workspaceRoot === 'string' ? expandHomePath(body.workspaceRoot) : ''
    if (rawWorkspace === '' || !isAbsolute(rawWorkspace)) {
      throw new SpeedtestError('WORKSPACE-INVALID', '解锁需要提供工作区绝对路径。')
    }
    const workspaceRoot = normalize(resolve(rawWorkspace))
    const active = this.runner.busyFor(workspaceRoot)
    const store = new BatchStore({ workspaceRoot, dshHome: this.home })
    const lock = await store.readLock()
    const verdict = this.unlockVerdict({
      confirm: body?.confirm,
      activeBatchId: active === null ? null : active.batch.batchId,
      lockExists: lock.exists,
    })
    if (!verdict.ok) throw new SpeedtestError(verdict.code, verdict.message, verdict.extra)
    await store.forceReleaseLock()
    return { ok: true }
  }

  /**
   * 通过注入点暴露解锁判定，便于测试与统一错误码。
   * @param {{ confirm?: unknown, activeBatchId: string | null, lockExists: boolean }} input 判定输入。
   * @returns {ReturnType<typeof unlockVerdict>} 判定结果。
   */
  unlockVerdict(input) {
    return unlockVerdict(input)
  }
}

/**
 * 把业务错误映射成 HTTP 状态码（供路由层复用）。
 * @param {unknown} error 抛出值。
 * @returns {{ status: number, body: Record<string, any> }} 响应描述。
 */
export function errorResponseOf(error) {
  const normalized = toSpeedtestError(error)
  const body = {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...normalized.extra,
    },
  }
  return { status: statusOfCode(normalized.code), body }
}

/**
 * 索引条目规范化（防御旧版本/手改文件）：只保留 CONTRACT §4.3 字段。
 * @param {Record<string, any>} entry 原始条目。
 * @returns {Record<string, any>} 规范化条目。
 */
function normalizeEntry(entry) {
  return {
    batchId: String(entry?.batchId ?? ''),
    dir: typeof entry?.dir === 'string' ? entry.dir : '',
    createdAt: typeof entry?.createdAt === 'string' ? entry.createdAt : null,
    name: displayNameOf(entry),
    status: typeof entry?.status === 'string' ? entry.status : null,
    env: {
      provider: entry?.env?.provider ?? null,
      model: entry?.env?.model ?? null,
      agentPreset: entry?.env?.agentPreset ?? null,
    },
    rounds: Number.isSafeInteger(entry?.rounds) ? entry.rounds : null,
    passed: Number.isSafeInteger(entry?.passed) ? entry.passed : null,
    medians: {
      elapsedSeconds: Number.isFinite(entry?.medians?.elapsedSeconds) ? entry.medians.elapsedSeconds : null,
      speedTps: Number.isFinite(entry?.medians?.speedTps) ? entry.medians.speedTps : null,
    },
  }
}

