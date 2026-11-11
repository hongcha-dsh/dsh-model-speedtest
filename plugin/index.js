/**
 * model-speedtest Host 半侧入口（CONTRACT §2）。
 *
 * 职责：
 * - 导出 `name` / `inject` / `Config` / `apply`；
 * - 装配 service、HTTP 路由与 `/speedtest` 命令；
 * - 所有注册都走 `ctx.effect`，卸载时取消活跃批次、dispose 已创建 Agent、释放锁。
 *
 * 不注册任何模型可见工具：触发方式只有 `/speedtest` 命令与客户端按钮/面板。
 */
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { parseSpeedtestCommand, SPEEDTEST_USAGE } from './lib/command.js'
import { toSpeedtestError } from './lib/errors.js'
import { createComposePreset } from './lib/presets.js'
import { registerSpeedtestRoutes } from './lib/routes.js'
import { BatchRunner } from './lib/runner.js'
import { SpeedtestService } from './lib/service.js'

/** Cordis 插件名。 */
export const name = 'model-speedtest'

/** 依赖的 Host 服务（agentPresets / permissionPresets 用 ctx.get 可选读取，不写进 inject）。 */
export const inject = ['connection', 'agents', 'sessions', 'commands']

/** 插件配置（CONTRACT §2.1）。 */
export const Config = z.object({
  workspaceRoot: z.string().default(''),
  defaultRounds: z.natural().default(3),
  maxRounds: z.natural().default(9),
  runTimeoutMinutes: z.natural().default(10),
})

/**
 * 归一化配置：cordis 一般已套用 schema 默认值，这里再兜一层，避免直接调用 apply 时缺字段。
 * @param {Record<string, any> | undefined} config 原始配置。
 * @returns {{ workspaceRoot: string, defaultRounds: number, maxRounds: number, runTimeoutMinutes: number }} 归一化配置。
 */
function normalizeConfig(config) {
  const workspaceRoot = typeof config?.workspaceRoot === 'string' ? config.workspaceRoot.trim() : ''
  const defaultRounds = Number.isSafeInteger(config?.defaultRounds) ? config.defaultRounds : 3
  const maxRounds = Number.isSafeInteger(config?.maxRounds) ? config.maxRounds : 9
  const runTimeoutMinutes = Number.isFinite(config?.runTimeoutMinutes) ? config.runTimeoutMinutes : 10
  const safeMax = maxRounds >= 2 ? maxRounds : 9
  const safeDefault = defaultRounds >= 2 ? Math.min(defaultRounds, safeMax) : Math.min(3, safeMax)
  return {
    workspaceRoot,
    defaultRounds: safeDefault,
    maxRounds: safeMax,
    runTimeoutMinutes: runTimeoutMinutes >= 1 ? runTimeoutMinutes : 10,
  }
}

/**
 * 装配 Host 半侧。
 * @param {any} ctx Host 插件上下文。
 * @param {Record<string, any>} [config] 插件配置。
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  const home = dshHomePath()
  const limits = { defaultRounds: resolved.defaultRounds, maxRounds: resolved.maxRounds }

  const runner = new BatchRunner(ctx, resolved, {
    home,
    composePreset: createComposePreset(ctx),
  })
  const service = new SpeedtestService(ctx, resolved, runner, { home })

  registerSpeedtestRoutes(ctx, service)

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'speedtest',
        description: '在同一环境下串行跑 N 轮模型测速并汇总（默认 3 轮）',
        input: { hint: '[轮数|rounds=N|help]' },
        handler: async (invocation) => {
          const parsed = parseSpeedtestCommand(invocation?.rawInput ?? '', limits)
          if (parsed.kind === 'help') return { kind: 'success', text: SPEEDTEST_USAGE }
          if (parsed.kind === 'error') return { kind: 'error', text: parsed.message }
          const sessionId = invocation?.agent?.session?.id ?? invocation?.agent?.id
          try {
            const started = await service.startBatch({ sessionId, rounds: parsed.rounds })
            return {
              kind: 'success',
              text: [
                `测速批次已开始：${started.batchId}`,
                `轮数：${started.rounds} 轮（串行，每轮独立 cwd）`,
                `目录：${started.batchDir}`,
                '进度与结果可在测速面板查看，或用 /speedtest help 查看用法。',
              ].join('\n'),
            }
          } catch (error) {
            const normalized = toSpeedtestError(error)
            return { kind: 'error', text: `无法开始测速（${normalized.code}）：${normalized.message}` }
          }
        },
      }),
    'model-speedtest: /speedtest command',
  )

  // 最后注册 → 卸载时最先执行：先取消活跃批次、dispose Agent、释放锁，再注销路由。
  ctx.effect(() => () => runner.shutdown(), 'model-speedtest: active batches')

  ctx.logger?.info?.('model-speedtest: Host 半侧已加载')
}
