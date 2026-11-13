import assert from 'node:assert/strict'
import test from 'node:test'
import { messageOf, SpeedtestError, statusOfCode, toSpeedtestError } from '../lib/errors.js'

test('statusOfCode 映射 CONTRACT 允许的状态码', () => {
  assert.equal(statusOfCode('BAD-REQUEST'), 400)
  assert.equal(statusOfCode('BAD-ROUNDS'), 400)
  assert.equal(statusOfCode('WORKSPACE-INVALID'), 400)
  assert.equal(statusOfCode('NO-MODEL'), 400)
  assert.equal(statusOfCode('SESSION-NOT-FOUND'), 404)
  assert.equal(statusOfCode('BATCH-NOT-FOUND'), 404)
  assert.equal(statusOfCode('BUSY'), 409)
  assert.equal(statusOfCode('SKILL-MISSING'), 500)
  assert.equal(statusOfCode('UNKNOWN-CODE'), 500)
})

test('SpeedtestError 携带 code 与附加字段', () => {
  const error = new SpeedtestError('BUSY', '已有批次', { batchId: 'st-1' })
  assert.equal(error.name, 'SpeedtestError')
  assert.equal(error.code, 'BUSY')
  assert.equal(error.extra.batchId, 'st-1')
  assert.equal(messageOf(error), '已有批次')
})

test('toSpeedtestError 归一化非 SpeedtestError', () => {
  const wrapped = toSpeedtestError(new Error('disk full'), 'INTERNAL')
  assert.equal(wrapped.code, 'INTERNAL')
  assert.equal(wrapped.message, 'disk full')
  assert.equal(messageOf(wrapped), 'disk full')
  assert.equal(messageOf('text'), 'text')
  assert.equal(messageOf(null), '未知错误')
})
