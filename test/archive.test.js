import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACTIVE_BATCH_STATUS,
  assessBatchDeletion,
  isBatchActive,
  workspaceRootFromBatchDir,
} from '../lib/archive.js'
import { batchesDir } from '../lib/paths.js'

const WS = 'D:\\ws'
const BATCH_ID = 'st-20261111-120000-ab12'
const DIR = `${batchesDir(WS)}\\${BATCH_ID}`
const DOC = { batchId: BATCH_ID }

test('isBatchActive 只认 queued/running', () => {
  assert.deepEqual(ACTIVE_BATCH_STATUS, ['queued', 'running'])
  assert.equal(isBatchActive('queued'), true)
  assert.equal(isBatchActive('running'), true)
  assert.equal(isBatchActive('done'), false)
  assert.equal(isBatchActive(undefined), false)
})

test('workspaceRootFromBatchDir 只认 <ws>/.speedtest/batches/<id>', () => {
  assert.equal(workspaceRootFromBatchDir(DIR).toLowerCase(), WS.toLowerCase())
  assert.equal(workspaceRootFromBatchDir('D:\\other\\st-1'), '')
  assert.equal(workspaceRootFromBatchDir(''), '')
})

test('assessBatchDeletion 通过合法批次', () => {
  assert.deepEqual(assessBatchDeletion({ batchId: BATCH_ID, dir: DIR, workspaceRoot: WS, batchDoc: DOC }), {
    ok: true,
    dir: DIR,
  })
})

test('assessBatchDeletion 拒绝 basename 不符', () => {
  const wrong = `${batchesDir(WS)}\\another-dir`
  const verdict = assessBatchDeletion({ batchId: BATCH_ID, dir: wrong, workspaceRoot: WS, batchDoc: DOC })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'DELETE-UNSAFE')
  assert.match(verdict.message, /目录名与批次 ID 不一致/)
})

test('assessBatchDeletion 拒绝父目录不是 <ws>/.speedtest/batches', () => {
  const other = `D:\\other\\.speedtest\\batches\\${BATCH_ID}`
  const verdict = assessBatchDeletion({ batchId: BATCH_ID, dir: other, workspaceRoot: WS, batchDoc: DOC })
  assert.equal(verdict.code, 'DELETE-UNSAFE')
  assert.match(verdict.message, /不在预期位置/)
})

test('assessBatchDeletion 拒绝非绝对路径与未知工作区', () => {
  assert.equal(assessBatchDeletion({ batchId: BATCH_ID, dir: 'batches\\x', workspaceRoot: WS, batchDoc: DOC }).code, 'DELETE-UNSAFE')
  assert.equal(assessBatchDeletion({ batchId: BATCH_ID, dir: DIR, workspaceRoot: '', batchDoc: DOC }).code, 'DELETE-UNSAFE')
})

test('assessBatchDeletion 拒绝 batch.json 缺失或 batchId 不一致', () => {
  assert.equal(assessBatchDeletion({ batchId: BATCH_ID, dir: DIR, workspaceRoot: WS, batchDoc: null }).code, 'DELETE-UNSAFE')
  const verdict = assessBatchDeletion({
    batchId: BATCH_ID,
    dir: DIR,
    workspaceRoot: WS,
    batchDoc: { batchId: 'st-other' },
  })
  assert.equal(verdict.code, 'DELETE-UNSAFE')
  assert.match(verdict.message, /batch\.json/)
})
