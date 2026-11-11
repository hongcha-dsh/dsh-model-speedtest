/**
 * 原子写与安全读（只依赖 node:fs / node:path）。
 *
 * batch.json 与全局索引都要求原子写：先写同目录临时文件，再 rename 覆盖，
 * 避免进程中断留下半截 JSON。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 临时文件计数器，保证同一进程内并发写不撞名。 */
let tempCounter = 0

/**
 * 原子写文本文件（先写临时文件，再 rename）。
 * @param {string} file 目标文件。
 * @param {string} text 文本内容。
 * @returns {Promise<void>} 完成。
 */
export async function writeTextAtomic(file, text) {
  await mkdir(dirname(file), { recursive: true })
  tempCounter += 1
  const temp = `${file}.tmp-${process.pid}-${tempCounter}`
  try {
    await writeFile(temp, text, 'utf8')
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * 原子写 JSON 文件（2 空格缩进 + 结尾换行）。
 * @param {string} file 目标文件。
 * @param {unknown} value 可 JSON 序列化的值。
 * @returns {Promise<void>} 完成。
 */
export async function writeJsonAtomic(file, value) {
  await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * 读取文本文件；不存在时返回 exists=false。
 * @param {string} file 目标文件。
 * @returns {Promise<{ exists: boolean, text: string | null }>} 读取结果。
 */
export async function readTextIfExists(file) {
  try {
    return { exists: true, text: await readFile(file, 'utf8') }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, text: null }
    throw error
  }
}

/**
 * 读取 JSON 文件；不存在 / 解析失败都收敛成结构化结果，由调用方决定如何降级。
 * @param {string} file 目标文件。
 * @returns {Promise<{ exists: boolean, value: unknown, error: string | null }>} 读取结果。
 */
export async function readJsonIfExists(file) {
  const text = await readTextIfExists(file)
  if (!text.exists) return { exists: false, value: null, error: null }
  try {
    return { exists: true, value: JSON.parse(text.text), error: null }
  } catch (error) {
    return { exists: true, value: null, error: error instanceof Error ? error.message : String(error) }
  }
}
