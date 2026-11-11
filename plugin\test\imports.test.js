import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')

/** 必须保持纯逻辑（不 import @deepseek-ai/*）的模块。 */
const PURE_MODULES = [
  'archive-ops.js',
  'archive.js',
  'atomic.js',
  'collect.js',
  'name.js',
  'command.js',
  'errors.js',
  'index-store.js',
  'lock.js',
  'paths.js',
  'state.js',
  'stats.js',
  'store.js',
  'summary.js',
]

test('纯逻辑模块不 import @deepseek-ai/*（CONTRACT §8）', async () => {
  for (const name of PURE_MODULES) {
    const text = await readFile(join(LIB_DIR, name), 'utf8')
    assert.equal(
      /from\s+['"]@deepseek-ai\//u.test(text),
      false,
      `${name} 不应 import DSH 包，否则无法在 node --test 里覆盖`,
    )
  }
})

test('涉及 DSH 服务的模块可以 import，但应集中在少数文件', async () => {
  const dshModules = ['presets.js', 'service.js', 'runner.js', 'routes.js']
  for (const name of dshModules) {
    const text = await readFile(join(LIB_DIR, name), 'utf8')
    assert.equal(text.length > 0, true, `${name} 应存在`)
  }
})

test('service.js 调用的 archive-ops 符号必须真的被 import（防运行时 ReferenceError）', async () => {
  const text = await readFile(join(LIB_DIR, 'service.js'), 'utf8')
  const matched = /import \{([^}]+)\} from '\.\/archive-ops\.js'/u.exec(text)
  assert.ok(matched !== null, "service.js 应 import './archive-ops.js'")
  const imported = matched[1].split(',').map(name => name.trim())
  for (const name of ['renameStoredBatch', 'deleteStoredBatch', 'indexEntryWithName']) {
    if (text.includes(name + '(')) {
      assert.ok(imported.includes(name), `service.js 调用了 ${name} 但没有导入`)
    }
  }
})
