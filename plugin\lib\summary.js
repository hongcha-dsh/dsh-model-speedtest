/**
 * Skill 侧 `scripts/repeat.mjs` 的调用封装（CONTRACT §6）。
 *
 * Lead 负责实现该脚本；Host 只做动态 import 并把结果转成批次 notes。
 * loader 允许注入，测试里用替身，因此 repeat.mjs 未就绪也不会阻塞 Host 半侧。
 */
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { messageOf } from './errors.js'

/**
 * repeat.mjs 的绝对路径。
 * @param {string} skillDir skill 目录。
 * @returns {string} 脚本路径。
 */
export function repeatScriptPath(skillDir) {
  return join(skillDir, 'scripts', 'repeat.mjs')
}

/**
 * 默认 loader：先检查文件存在，再动态 import。
 * @param {string} skillDir skill 目录。
 * @returns {Promise<Record<string, any>>} 模块命名空间。
 */
export async function loadRepeatModule(skillDir) {
  const file = repeatScriptPath(skillDir)
  try {
    await access(file)
  } catch {
    const error = new Error(`skill 尚未提供汇总脚本：${file}`)
    error.code = 'REPEAT-MISSING'
    throw error
  }
  return import(pathToFileURL(file).href)
}

/**
 * 调用 runRepeat 生成批次汇总。
 * @param {{
 *   skillDir: string,
 *   workspace: string,
 *   runs: string[],
 *   outDir: string,
 *   rounds?: Array<{ index: number, status: string, error: string | null }>,
 *   loader?: (skillDir: string) => Promise<Record<string, any>>,
 * }} input 汇总输入。
 * @returns {Promise<{ ok: true, result: Record<string, any>, jsonPath: string | null, mdPath: string | null } | { ok: false, code: string, error: string }>} 汇总结果。
 */
export async function runBatchSummary(input) {
  const runs = Array.isArray(input?.runs) ? input.runs.filter((run) => typeof run === 'string' && run !== '') : []
  if (runs.length === 0) {
    return { ok: false, code: 'NO-RUNS', error: '没有任何一轮产出结果文件，无法汇总。' }
  }
  const loader = typeof input.loader === 'function' ? input.loader : loadRepeatModule
  let loaded
  try {
    loaded = await loader(input.skillDir)
  } catch (error) {
    const missing = error && error.code === 'REPEAT-MISSING'
    return {
      ok: false,
      code: missing ? 'REPEAT-MISSING' : 'REPEAT-LOAD-FAILED',
      error: missing ? '汇总脚本尚未就绪（repeat.mjs 不存在），本次只保留逐轮结果。' : `汇总脚本加载失败：${messageOf(error)}`,
    }
  }
  const runRepeat = loaded?.runRepeat
  if (typeof runRepeat !== 'function') {
    return { ok: false, code: 'REPEAT-INVALID', error: 'repeat.mjs 未导出 runRepeat 函数，本次只保留逐轮结果。' }
  }
  try {
    const result = await runRepeat({
      workspace: input.workspace,
      runs,
      outDir: input.outDir,
      rounds: Array.isArray(input.rounds) ? input.rounds : undefined,
    })
    if (result && result.ok === false) {
      return {
        ok: false,
        code: typeof result.code === 'string' ? result.code : 'REPEAT-FAILED',
        error: typeof result.message === 'string' ? result.message : '汇总脚本拒绝了本次批次。',
      }
    }
    return {
      ok: true,
      result: result && typeof result === 'object' ? result : {},
      jsonPath: typeof result?.jsonPath === 'string' ? result.jsonPath : null,
      mdPath: typeof result?.mdPath === 'string' ? result.mdPath : null,
    }
  } catch (error) {
    return { ok: false, code: 'REPEAT-FAILED', error: `汇总脚本执行失败：${messageOf(error)}` }
  }
}
