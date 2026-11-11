import assert from 'node:assert/strict'
import test from 'node:test'
import { assessLock, buildLock, parseLockText, unlockVerdict } from '../lib/lock.js'

test('buildLock / parseLockText 往返一致', () => {
  const lock = buildLock({ batchId: 'st-1', pid: 4242, startedAt: '2026-11-11T12:00:00+08:00' })
  assert.deepEqual(lock, { batchId: 'st-1', pid: 4242, startedAt: '2026-11-11T12:00:00+08:00' })
  const parsed = parseLockText(JSON.stringify(lock))
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.lock, lock)
})

test('parseLockText 拒绝坏 JSON / 缺字段 / 坏 pid', () => {
  assert.equal(parseLockText('not json').ok, false)
  assert.equal(parseLockText('[]').ok, false)
  assert.equal(parseLockText(JSON.stringify({ batchId: 'b' })).ok, false)
  assert.equal(parseLockText(JSON.stringify({ batchId: 'b', pid: 0, startedAt: 't' })).ok, false)
  assert.equal(parseLockText(JSON.stringify({ batchId: '', pid: 1, startedAt: 't' })).ok, false)
  assert.match(parseLockText(JSON.stringify({ batchId: 'b', pid: 1 })).reason, /startedAt/)
})

test('assessLock 判定 BUSY 与损坏场景', () => {
  assert.deepEqual(assessLock({ exists: false }), { busy: false })
  const busy = assessLock({ exists: true, text: JSON.stringify({ batchId: 'st-x', pid: 1, startedAt: 't' }) })
  assert.equal(busy.busy, true)
  assert.equal(busy.batchId, 'st-x')
  assert.equal(busy.corrupt, false)
  assert.match(busy.message, /st-x/)

  const corrupt = assessLock({ exists: true, text: '{"batchId":' })
  assert.equal(corrupt.busy, true)
  assert.equal(corrupt.corrupt, true)
  assert.equal(corrupt.batchId, null)
  assert.match(corrupt.message, /无法解析/)
})

test('unlockVerdict：必须 confirm、不能与活跃批次冲突、锁必须存在', () => {
  assert.deepEqual(unlockVerdict({ confirm: true, activeBatchId: null, lockExists: true }), { ok: true })

  const noConfirm = unlockVerdict({ confirm: false, activeBatchId: null, lockExists: true })
  assert.equal(noConfirm.ok, false)
  assert.equal(noConfirm.code, 'CONFIRM-REQUIRED')

  const busy = unlockVerdict({ confirm: true, activeBatchId: 'st-live', lockExists: true })
  assert.equal(busy.ok, false)
  assert.equal(busy.code, 'BUSY')
  assert.equal(busy.extra.batchId, 'st-live')

  const missing = unlockVerdict({ confirm: true, activeBatchId: null, lockExists: false })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'LOCK-NOT-FOUND')
})
