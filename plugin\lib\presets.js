/**
 * Agent 预设组合（CONTRACT §3.3 / §3.1）。
 *
 * 与内置 `api-session-controller` 的 `composeAgent` 保持一致：
 * - 没有 agentPresets 服务：只装模型选择监听；
 * - 有服务：先 resolve 出真实预设 ID，再在未发布 Agent 的 setup 里
 *   `installModelSelection` + `presets.mount`。
 */
import { installModelSelection } from '@deepseek-ai/dsh-agent'

/**
 * 生成一个 `composePreset(presetId)` 函数（绑定在当前 ctx 上）。
 * @param {any} ctx Host 插件上下文。
 * @returns {(presetId?: string) => Promise<{ agentPreset?: string, setup: (agentCtx: any) => Promise<void> | void }>} 组合函数。
 */
export function createComposePreset(ctx) {
  return async function composePreset(presetId) {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) {
      return {
        setup: (agentCtx) => {
          installModelSelection(agentCtx)
        },
      }
    }
    const resolved = await presets.resolve(presetId)
    const resolvedId = resolved.id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }
}
