import assert from 'node:assert/strict'
import { join, normalize, resolve } from 'node:path'
import test from 'node:test'
import {
  batchDir,
  batchJsonPath,
  batchesDir,
  expandHomePath,
  formatLocalIso,
  globalIndexPath,
  isBatchId,
  lockPath,
  makeBatchId,
  resolveWorkspaceRoot,
  roundCwd,
  speedtestRoot,
} from '../lib/paths.js'

test('expandHomePath 展开 ~ 前缀，其它原样返回', () => {
  assert.equal(expandHomePath('~', 'C:\\Users\\me'), 'C:\\Users\\me')
  assert.equal(expandHomePath('~/工作区', 'C:\\Users\\me'), join('C:\\Users\\me', '工作区'))
  assert.equal(expandHomePath('D:\\work', 'C:\\Users\\me'), 'D:\\work')
  assert.equal(expandHomePath('  ', 'C:\\Users\\me'), '')
  assert.equal(expandHomePath(undefined, 'C:\\Users\\me'), '')
})

test('resolveWorkspaceRoot 配置优先、绝对路径校验', () => {
  const fromConfig = resolveWorkspaceRoot({ configured: 'D:\\ws', sessionCwd: 'E:\\other' })
  assert.equal(fromConfig.ok, true)
  assert.equal(fromConfig.workspaceRoot, 'D:\\ws')

  const fromCwd = resolveWorkspaceRoot({ configured: '', sessionCwd: 'E:\\cwd-ws' })
  assert.equal(fromCwd.ok, true)
  assert.equal(fromCwd.workspaceRoot, normalize(resolve('E:\\cwd-ws')))

  const relative = resolveWorkspaceRoot({ configured: 'relative/ws' })
  assert.equal(relative.ok, false)
  assert.equal(relative.code, 'WORKSPACE-INVALID')

  const missing = resolveWorkspaceRoot({})
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'WORKSPACE-INVALID')
})

test('目录派生符合 CONTRACT §5.2', () => {
  const ws = 'D:\\work\\技术专家'
  assert.equal(speedtestRoot(ws), `${ws}\\.speedtest`)
  assert.equal(batchesDir(ws), `${ws}\\.speedtest\\batches`)
  assert.equal(lockPath(ws), `${ws}\\.speedtest\\batches\\.lock`)
  assert.equal(batchDir(ws, 'st-20261111-120000-ab12'), `${ws}\\.speedtest\\batches\\st-20261111-120000-ab12`)
  assert.equal(batchJsonPath('C:\\b'), 'C:\\b\\batch.json')
  assert.equal(roundCwd('C:\\b', 2), 'C:\\b\\r2')
  assert.equal(globalIndexPath('D:\\DSH-Home'), 'D:\\DSH-Home\\speedtest\\index.json')
})

test('makeBatchId 使用本地时间与随机后缀', () => {
  const id = makeBatchId(new Date('2026-11-11T04:00:00.000Z'), 'ab12', 480)
  assert.equal(id, 'st-20261111-120000-ab12')
  assert.equal(isBatchId(id), true)
  assert.equal(isBatchId('st-20260101-000000-Ab12'), true, '大写后缀也应是合法批次 ID')
  assert.equal(isBatchId('batch-1'), false)
})

test('formatLocalIso 输出带时区偏移的本地时间', () => {
  assert.equal(
    formatLocalIso(new Date('2026-11-11T04:00:00.000Z'), 480),
    '2026-11-11T12:00:00.000+08:00',
  )
  assert.equal(
    formatLocalIso(new Date('2026-11-11T04:00:00.000Z'), -300),
    '2026-11-10T23:00:00.000-05:00',
  )
})
