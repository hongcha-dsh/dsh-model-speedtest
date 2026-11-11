import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BATCH_STATUS,
  ROUND_STATUS,
  beginRound,
  completionStatus,
  countConsecutiveNoReport,
  createBatchRecord,
  deriveSummary,
  finalizeBatch,
  findRound,
  liveStateOf,
  setBatchStatus,
  settleRound,
  shouldAbortForNoReport,
  toIndexEntry,
} from '../lib/state.js'

function makeBatch(rounds = 3) {
  return createBatchRecord({
    batchId: 'st-20261111-120000-ab12',
    createdAt: '2026-11-11T12:00:00.000+08:00',
    controlSessionId: 'session-control',
    workspaceRoot: 'D:\\ws',
    batchDir: 'D:\\ws\\.speedtest\\batches\\st-20261111-120000-ab12',
    rounds,
    env: { provider: 'p', model: 'm', reasoningEffort: 'high', agentPreset: 'standard', permissionPreset: 'workspace-write' },
    skill: { dir: 'D:\\skill', skillHash: 'abc', taskVersion: 'dev-short-v1' },
  })
}

test('createBatchRecord 生成 CONTRACT §5.1 结构', () => {
  const batch = makeBatch(2)
  assert.equal(batch.schemaVersion, 1)
  assert.equal(batch.status, BATCH_STATUS.QUEUED)
  assert.equal(batch.rounds.length, 2)
  assert.deepEqual(
    batch.rounds[0],
    {
      index: 1,
      sessionId: null,
      runCwd: null,
      status: ROUND_STATUS.QUEUED,
      runId: null,
      resultPath: null,
      reportPath: null,
      elapsedSeconds: null,
      speedTps: null,
      tokens: null,
      toolCount: null,
      devRequestCount: null,
      cacheHit: null,
      cacheReadTokens: null,
      summaryCacheHit: null,
      taskVersion: null,
      error: null,
    },
  )
  assert.equal(batch.summary.total, 2)
  assert.deepEqual(batch.notes, [])
})

test('beginRound / settleRound 更新轮次与 updatedAt', () => {
  const batch = makeBatch(2)
  beginRound(batch, 1, { sessionId: 'session-a', runCwd: 'D:\\ws\\.speedtest\\batches\\b\\r1', updatedAt: 't1' })
  assert.equal(findRound(batch, 1).status, ROUND_STATUS.RUNNING)
  assert.equal(batch.updatedAt, 't1')
  settleRound(batch, 1, { status: ROUND_STATUS.PASSED, elapsedSeconds: 96.1, speedTps: 12.3, resultPath: 'x' }, 't2')
  assert.equal(findRound(batch, 1).status, ROUND_STATUS.PASSED)
  assert.equal(batch.updatedAt, 't2')
  assert.equal(findRound(batch, 2).status, ROUND_STATUS.QUEUED)
})

test('连续 no-report 计数与中止阈值', () => {
  const batch = makeBatch(3)
  settleRound(batch, 1, { status: ROUND_STATUS.NO_REPORT }, 't')
  assert.equal(countConsecutiveNoReport(batch.rounds), 1)
  assert.equal(shouldAbortForNoReport(batch.rounds), false)
  settleRound(batch, 2, { status: ROUND_STATUS.NO_REPORT }, 't')
  assert.equal(countConsecutiveNoReport(batch.rounds), 2)
  assert.equal(shouldAbortForNoReport(batch.rounds), true)
})

test('成功轮次会打断连续 no-report 计数', () => {
  const batch = makeBatch(3)
  settleRound(batch, 1, { status: ROUND_STATUS.NO_REPORT }, 't')
  settleRound(batch, 2, { status: ROUND_STATUS.PASSED }, 't')
  assert.equal(countConsecutiveNoReport(batch.rounds), 0)
})

test('deriveSummary 统计各状态与耗时/速度', () => {
  const batch = makeBatch(3)
  settleRound(batch, 1, { status: ROUND_STATUS.PASSED, elapsedSeconds: 92, speedTps: 10, resultPath: 'a' }, 't')
  settleRound(batch, 2, { status: ROUND_STATUS.PASSED, elapsedSeconds: 100, speedTps: 14, resultPath: 'b' }, 't')
  settleRound(batch, 3, { status: ROUND_STATUS.TIMEOUT, error: '超时' }, 't')
  const summary = deriveSummary(batch.rounds)
  assert.deepEqual(
    { total: summary.total, passed: summary.passed, failed: summary.failed, timeout: summary.timeout, aborted: summary.aborted, noReport: summary.noReport },
    { total: 3, passed: 2, failed: 0, timeout: 1, aborted: 0, noReport: 0 },
  )
  assert.equal(summary.stats.elapsedSeconds.n, 2)
  assert.equal(summary.stats.elapsedSeconds.median, 96)
  assert.equal(summary.stats.elapsedSeconds.min, 92)
  assert.equal(summary.stats.elapsedSeconds.max, 100)
  assert.equal(summary.stats.elapsedSeconds.range, 8)
  assert.equal(summary.stats.elapsedSeconds.mad, 4)
  assert.equal(summary.stats.speedTps.median, 12)
})

test('completionStatus：有通过 → done，全不过 → failed', () => {
  const passing = makeBatch(2)
  settleRound(passing, 1, { status: ROUND_STATUS.PASSED }, 't')
  settleRound(passing, 2, { status: ROUND_STATUS.FAILED }, 't')
  assert.equal(completionStatus(passing.rounds), BATCH_STATUS.DONE)

  const failing = makeBatch(2)
  settleRound(failing, 1, { status: ROUND_STATUS.FAILED }, 't')
  settleRound(failing, 2, { status: ROUND_STATUS.TIMEOUT }, 't')
  assert.equal(completionStatus(failing.rounds), BATCH_STATUS.FAILED)
})

test('finalizeBatch 写入 summary/状态/说明', () => {
  const batch = makeBatch(2)
  settleRound(batch, 1, { status: ROUND_STATUS.PASSED, elapsedSeconds: 90 }, 't')
  setBatchStatus(batch, BATCH_STATUS.RUNNING, 't')
  finalizeBatch(batch, { status: BATCH_STATUS.DONE, updatedAt: 't9', notes: ['已生成汇总'] })
  assert.equal(batch.status, BATCH_STATUS.DONE)
  assert.equal(batch.updatedAt, 't9')
  assert.deepEqual(batch.notes, ['已生成汇总'])
  assert.equal(batch.summary.passed, 1)
})

test('liveStateOf 给出当前轮与阶段', () => {
  const batch = makeBatch(3)
  assert.deepEqual(liveStateOf(batch), {
    status: BATCH_STATUS.QUEUED,
    currentRound: 1,
    totalRounds: 3,
    phase: 'queued',
  })
  setBatchStatus(batch, BATCH_STATUS.RUNNING, 't')
  beginRound(batch, 1, { sessionId: 's', runCwd: 'r1', updatedAt: 't' })
  assert.deepEqual(liveStateOf(batch), {
    status: BATCH_STATUS.RUNNING,
    currentRound: 1,
    totalRounds: 3,
    phase: 'running',
  })
  settleRound(batch, 1, { status: ROUND_STATUS.PASSED }, 't')
  assert.equal(liveStateOf(batch).currentRound, 2)
  setBatchStatus(batch, BATCH_STATUS.DONE, 't')
  assert.equal(liveStateOf(batch).phase, BATCH_STATUS.DONE)
})

test('toIndexEntry 只带 CONTRACT §4.3 字段', () => {
  const batch = makeBatch(2)
  settleRound(batch, 1, { status: ROUND_STATUS.PASSED, elapsedSeconds: 96, speedTps: 12 }, 't')
  settleRound(batch, 2, { status: ROUND_STATUS.PASSED, elapsedSeconds: 100, speedTps: 14 }, 't')
  finalizeBatch(batch, { status: BATCH_STATUS.DONE, updatedAt: 't' })
  const entry = toIndexEntry(batch)
  assert.deepEqual(entry, {
    batchId: 'st-20261111-120000-ab12',
    dir: batch.batchDir,
    createdAt: '2026-11-11T12:00:00.000+08:00',
    name: 'm · 11-11 12:00',
    status: BATCH_STATUS.DONE,
    env: { provider: 'p', model: 'm', agentPreset: 'standard' },
    rounds: 2,
    passed: 2,
    medians: { elapsedSeconds: 98, speedTps: 13 },
  })
  assert.equal('workspaceRoot' in entry, false)
  assert.equal('skill' in entry, false)
})
