import assert from 'node:assert/strict'
import test from 'node:test'
import { madOf, medianOf, roundTo, statsOf } from '../lib/stats.js'

test('medianOf 处理奇偶与空集', () => {
  assert.equal(medianOf([]), null)
  assert.equal(medianOf([5]), 5)
  assert.equal(medianOf([3, 1, 2]), 2)
  assert.equal(medianOf([1, 2, 3, 4]), 2.5)
})

test('madOf 是中位数绝对偏差', () => {
  assert.equal(madOf([]), null)
  // 中位数 2；离差 [1,0,1] → 中位数 1
  assert.equal(madOf([1, 2, 3]), 1)
  assert.equal(roundTo(madOf([92, 96, 100]), 1), 4)
})

test('statsOf 汇总 n/median/min/max/range/mad 并忽略非有限值', () => {
  assert.deepEqual(statsOf([]), { n: 0, median: null, min: null, max: null, range: null, mad: null })
  const stats = statsOf([92, 100, null, Number.NaN, 'x', 96])
  assert.equal(stats.n, 3)
  assert.equal(stats.median, 96)
  assert.equal(stats.min, 92)
  assert.equal(stats.max, 100)
  assert.equal(stats.range, 8)
  assert.equal(stats.mad, 4)
})

test('statsOf 对单值样本给出 0 极差与 0 MAD', () => {
  const stats = statsOf([12.34])
  assert.equal(stats.median, 12.3)
  assert.equal(stats.range, 0)
  assert.equal(stats.mad, 0)
})

test('roundTo 只处理有限数字', () => {
  assert.equal(roundTo(1.25), 1.3)
  assert.equal(roundTo(Number.POSITIVE_INFINITY), null)
})
