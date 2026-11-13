import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readJsonIfExists, readTextIfExists, writeJsonAtomic, writeTextAtomic } from '../lib/atomic.js'

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mst-atomic-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('writeTextAtomic 创建目录并覆盖写入', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'nested', 'a.txt')
    await writeTextAtomic(file, 'first')
    assert.equal(await readFile(file, 'utf8'), 'first')
    await writeTextAtomic(file, 'second')
    assert.equal(await readFile(file, 'utf8'), 'second')
  })
})

test('writeJsonAtomic 输出 2 空格缩进 + 换行', async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, 'x', 'batch.json')
    await writeJsonAtomic(file, { ok: true, nested: { a: 1 } })
    const text = await readFile(file, 'utf8')
    assert.equal(text, '{\n  "ok": true,\n  "nested": {\n    "a": 1\n  }\n}\n')
    const read = await readJsonIfExists(file)
    assert.deepEqual(read, { exists: true, value: { ok: true, nested: { a: 1 } }, error: null })
  })
})

test('readTextIfExists / readJsonIfExists 对不存在与坏 JSON 的降级', async () => {
  await withTempDir(async (dir) => {
    const missing = await readTextIfExists(join(dir, 'nope.txt'))
    assert.deepEqual(missing, { exists: false, text: null })
    const missingJson = await readJsonIfExists(join(dir, 'nope.json'))
    assert.deepEqual(missingJson, { exists: false, value: null, error: null })

    const broken = join(dir, 'broken.json')
    await writeTextAtomic(broken, '{oops')
    const read = await readJsonIfExists(broken)
    assert.equal(read.exists, true)
    assert.equal(read.value, null)
    assert.match(read.error, /JSON/)
  })
})
