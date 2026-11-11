import assert from 'node:assert/strict'
import test from 'node:test'
import {
  environmentWarnings,
  isExcludedResultPath,
  roundPatchFromResult,
  roundStatusOf,
  selectLatestResult,
  validateResultDocument,
} from '../lib/collect.js'

test('isExcludedResultPath 排除 comparisons / batches', () => {
  assert.equal(isExcludedResultPath('run-1/result.json'), false)
  assert.equal(isExcludedResultPath('comparisons/c1/result.json'), true)
  assert.equal(isExcludedResultPath('batches/b1/result.json'), true)
  assert.equal(isExcludedResultPath('batches\\x\\result.json'), true)
})

test('selectLatestResult 取 mtime 最新并记警告', () => {
  const none = selectLatestResult([])
  assert.deepEqual(none, { ok: false, code: 'NO-REPORT' })

  const picked = selectLatestResult([
    { path: 'a/result.json', relative: 'a/result.json', mtimeMs: 100 },
    { path: 'b/result.json', relative: 'b/result.json', mtimeMs: 300 },
    { path: 'comparisons/c/result.json', relative: 'comparisons/c/result.json', mtimeMs: 900 },
  ])
  assert.equal(picked.ok, true)
  assert.equal(picked.path, 'b/result.json')
  assert.match(picked.warning, /2 个结果文件/)
})

test('validateResultDocument 校验 schema 与指标版本', () => {
  assert.deepEqual(validateResultDocument({ resultSchemaVersion: 1, metricVersion: 'v3-request-wall' }), { ok: true })
  const nullDoc = validateResultDocument(null)
  assert.equal(nullDoc.ok, false)
  assert.equal(nullDoc.code, 'RESULT-INVALID')
  const oldSchema = validateResultDocument({ resultSchemaVersion: 0, metricVersion: 'v3-request-wall' })
  assert.equal(oldSchema.ok, false)
  assert.match(oldSchema.message, /resultSchemaVersion/)
  const oldMetric = validateResultDocument({ resultSchemaVersion: 1, metricVersion: 'v2-span' })
  assert.equal(oldMetric.ok, false)
  assert.match(oldMetric.message, /metricVersion/)
})

test('roundStatusOf 映射 outcome', () => {
  assert.equal(roundStatusOf('passed'), 'passed')
  assert.equal(roundStatusOf('timeout'), 'timeout')
  assert.equal(roundStatusOf('aborted'), 'aborted')
  assert.equal(roundStatusOf('failed'), 'failed')
  assert.equal(roundStatusOf('whatever'), 'failed')
})

test('roundPatchFromResult 抽取 runId/耗时/速度/错误', () => {
  const patch = roundPatchFromResult(
    {
      runId: 'run-1',
      outcome: 'passed',
      elapsedMs: 96_050,
      failureReason: null,
      taskVersion: 'dev-short-v1',
      metrics: {
        speedTps: 12.345,
        outputTokens: 812,
        toolCount: 7,
        devRequestCount: 4,
        firstRequestCache: { state: 'hit', reason: 'cache-read-positive', cacheReadTokens: 34176 },
        summaryCache: { state: 'miss', reason: 'no-cache-read' },
      },
      env: { provider: 'p', model: 'm', keyAlias: 'should-not-be-copied' },
      environmentFlags: ['environment-changed', 'extra'],
    },
    { resultPath: 'D:\\ws\\.speedtest\\r1\\result.json', reportPath: 'D:\\ws\\.speedtest\\r1\\report.md' },
  )
  assert.equal(patch.runId, 'run-1')
  assert.equal(patch.status, 'passed')
  assert.equal(patch.elapsedSeconds, 96.1)
  assert.equal(patch.speedTps, 12.3)
  assert.equal(patch.tokens, 812)
  assert.equal(patch.toolCount, 7)
  assert.equal(patch.devRequestCount, 4)
  assert.equal(patch.cacheHit, 'hit')
  assert.equal(patch.cacheReadTokens, 34176)
  assert.equal(patch.summaryCacheHit, 'miss')
  assert.equal(patch.taskVersion, 'dev-short-v1')
  assert.equal(patch.error, null)
  assert.equal(patch.reportPath.endsWith('report.md'), true)
  assert.deepEqual(patch._environmentFlags, ['environment-changed', 'extra'])
  assert.deepEqual(patch._envIdentity, { provider: 'p', model: 'm' })
})

test('roundPatchFromResult 对失败/未知速度给出可读错误', () => {
  const patch = roundPatchFromResult(
    { outcome: 'failed', elapsedMs: 1000, failureReason: 'tests-not-passed', metrics: { speedTps: null } },
    { resultPath: 'r.json' },
  )
  assert.equal(patch.status, 'failed')
  assert.equal(patch.speedTps, null)
  assert.equal(patch.error, 'tests-not-passed')
  const noReason = roundPatchFromResult({ outcome: 'timeout' }, { resultPath: 'r.json' })
  assert.equal(noReason.error, '本轮结果为 timeout')
})

test('environmentWarnings 报告环境漂移与标记', () => {
  assert.deepEqual(environmentWarnings(null, { provider: 'p' }, 1, []), [])
  const warnings = environmentWarnings(
    { provider: 'p2', model: 'm' },
    { provider: 'p', model: 'm' },
    2,
    ['environment-changed'],
  )
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /第 2 轮实际 provider=p2/)
  assert.match(warnings[1], /environment-changed/)
})

test('filterFreshCandidates 只保留本轮新出现的结果', async () => {
  const { filterFreshCandidates } = await import('../lib/collect.js')
  const candidates = [
    { path: 'D:\\ws\\.speedtest\\run-old\\result.json', relative: 'run-old/result.json', mtimeMs: 1 },
    { path: 'D:\\ws\\.speedtest\\run-new\\result.json', relative: 'run-new/result.json', mtimeMs: 2 },
  ]
  const baseline = new Set(['D:\\ws\\.speedtest\\run-old\\result.json'])
  const fresh = filterFreshCandidates(candidates, baseline)
  assert.deepEqual(fresh.map((item) => item.relative), ['run-new/result.json'])
  assert.equal(filterFreshCandidates(candidates, undefined).length, 2)
  assert.equal(filterFreshCandidates(candidates, ['D:\\ws\\.speedtest\\run-new\\result.json']).length, 1)
})
