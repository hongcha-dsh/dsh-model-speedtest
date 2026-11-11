import assert from 'node:assert/strict'
import test from 'node:test'
import {
  INDEX_LIMIT,
  emptyIndex,
  findIndexEntry,
  parseIndexText,
  trimIndex,
  upsertIndexEntry,
} from '../lib/index-store.js'

test('parseIndexText 解析正常索引', () => {
  const parsed = parseIndexText(JSON.stringify({ schemaVersion: 1, batches: [{ batchId: 'a' }, { nope: 1 }] }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.warning, null)
  assert.deepEqual(parsed.index.batches, [{ batchId: 'a' }])
})

test('parseIndexText 对损坏文件返回空列表 + 警告', () => {
  const broken = parseIndexText('{not-json')
  assert.equal(broken.ok, false)
  assert.deepEqual(broken.index, emptyIndex())
  assert.match(broken.warning, /无法解析/)

  const wrongShape = parseIndexText(JSON.stringify({ batches: 'nope' }))
  assert.equal(wrongShape.ok, false)
  assert.match(wrongShape.warning, /结构/)
})

test('upsertIndexEntry 同 batchId 去重并置顶', () => {
  const first = upsertIndexEntry(emptyIndex(), { batchId: 'a', status: 'running' })
  const second = upsertIndexEntry(first, { batchId: 'b', status: 'done' })
  const replaced = upsertIndexEntry(second, { batchId: 'a', status: 'done' })
  assert.deepEqual(
    replaced.batches.map((entry) => `${entry.batchId}:${entry.status}`),
    ['a:done', 'b:done'],
  )
  assert.equal(findIndexEntry(replaced, 'b').status, 'done')
  assert.equal(findIndexEntry(replaced, 'missing'), null)
})

test('索引只保留最近 200 条', () => {
  let index = emptyIndex()
  for (let cursor = 0; cursor < INDEX_LIMIT + 20; cursor += 1) {
    index = upsertIndexEntry(index, { batchId: `b-${cursor}` })
  }
  assert.equal(index.batches.length, INDEX_LIMIT)
  assert.equal(index.batches[0].batchId, `b-${INDEX_LIMIT + 19}`)
  assert.equal(index.batches.at(-1).batchId, 'b-20')
})

test('trimIndex 忽略非法上限', () => {
  const index = { schemaVersion: 1, batches: [{ batchId: 'a' }, { batchId: 'b' }] }
  assert.equal(trimIndex(index, 0).batches.length, 2)
  assert.equal(trimIndex(index, -1).batches.length, 2)
  assert.equal(trimIndex(index, 1).batches.length, 1)
})
