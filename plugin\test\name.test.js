import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NAME_MAX_LENGTH,
  deriveBatchName,
  displayNameOf,
  monthDayTimeOf,
  validateBatchName,
} from '../lib/name.js'

const CREATED = '2026-11-11T12:00:00.000+08:00'
const BATCH_ID = 'st-20261111-120000-ab12'

test('monthDayTimeOf 直接读 createdAt 的本地字面量', () => {
  assert.equal(monthDayTimeOf(CREATED), '11-11 12:00')
  assert.equal(monthDayTimeOf('2026-01-02T03:04:05.678Z'), '01-02 03:04')
  assert.equal(monthDayTimeOf('not-a-date'), '')
  assert.equal(monthDayTimeOf(undefined), '')
})

test('deriveBatchName：model 已知用 <model> · <MM-DD HH:mm>', () => {
  assert.equal(
    deriveBatchName({ model: 'deepseek-v4.1-flash', createdAt: CREATED, batchId: BATCH_ID }),
    'deepseek-v4.1-flash · 11-11 12:00',
  )
})

test('deriveBatchName：model 未知或时间无法解析时用批次前缀', () => {
  assert.equal(deriveBatchName({ model: '', createdAt: CREATED, batchId: BATCH_ID }), `批次 ${BATCH_ID.slice(0, 8)}`)
  assert.equal(deriveBatchName({ model: '   ', createdAt: CREATED, batchId: BATCH_ID }), `批次 ${BATCH_ID.slice(0, 8)}`)
  assert.equal(deriveBatchName({ model: 'm', createdAt: 'bad', batchId: BATCH_ID }), `批次 ${BATCH_ID.slice(0, 8)}`)
  assert.equal(deriveBatchName({ batchId: '' }), '未命名批次')
})

test('validateBatchName：trim、空名、超长、控制字符、非字符串', () => {
  assert.deepEqual(validateBatchName('  火山 k3.1 对比  '), { ok: true, name: '火山 k3.1 对比' })
  assert.equal(validateBatchName('   ').code, 'BAD-NAME')
  assert.equal(validateBatchName('\n').code, 'BAD-NAME')
  assert.equal(validateBatchName(42).code, 'BAD-NAME')
  assert.equal(validateBatchName('a\nb').code, 'BAD-NAME')
  assert.equal(validateBatchName('a\u0000b').code, 'BAD-NAME')
  assert.equal(validateBatchName('测'.repeat(NAME_MAX_LENGTH)).ok, true)
  assert.equal(validateBatchName('测'.repeat(NAME_MAX_LENGTH + 1)).code, 'BAD-NAME')
})

test('displayNameOf 优先已保存的 name，非法 name 退回派生规则', () => {
  assert.equal(
    displayNameOf({ name: '  自定义名字  ', env: { model: 'm' }, createdAt: CREATED, batchId: BATCH_ID }),
    '自定义名字',
  )
  assert.equal(
    displayNameOf({ name: 'a\nb', env: { model: 'm' }, createdAt: CREATED, batchId: BATCH_ID }),
    'm · 11-11 12:00',
  )
  assert.equal(
    displayNameOf({ name: 'x'.repeat(NAME_MAX_LENGTH + 1), env: { model: 'm' }, createdAt: CREATED, batchId: BATCH_ID }),
    'm · 11-11 12:00',
  )
  assert.equal(displayNameOf({ env: {}, createdAt: CREATED, batchId: BATCH_ID }), `批次 ${BATCH_ID.slice(0, 8)}`)
})
