import assert from 'node:assert/strict'
import test from 'node:test'
import { repeatScriptPath, runBatchSummary } from '../lib/summary.js'

test('repeatScriptPath 指向 skill 的 scripts/repeat.mjs', () => {
  assert.equal(repeatScriptPath('D:\\skill'), 'D:\\skill\\scripts\\repeat.mjs')
})

test('runBatchSummary 调用注入的 runRepeat 并回传产物路径', async () => {
  let received = null
  const result = await runBatchSummary({
    skillDir: 'D:\\skill',
    workspace: 'D:\\ws',
    runs: ['a/result.json', '', 'b/result.json'],
    outDir: 'D:\\ws\\batch',
    rounds: [{ index: 1, status: 'passed', error: null }],
    loader: async () => ({
      runRepeat: async (input) => {
        received = input
        return { ok: true, jsonPath: 'D:\\ws\\batch\\repeat.json', mdPath: 'D:\\ws\\batch\\summary.md' }
      },
    }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.jsonPath, 'D:\\ws\\batch\\repeat.json')
  assert.equal(result.mdPath, 'D:\\ws\\batch\\summary.md')
  assert.deepEqual(received, {
    workspace: 'D:\\ws',
    runs: ['a/result.json', 'b/result.json'],
    outDir: 'D:\\ws\\batch',
    rounds: [{ index: 1, status: 'passed', error: null }],
  })
})

test('runBatchSummary 没有结果文件时不调用脚本', async () => {
  let called = false
  const result = await runBatchSummary({
    skillDir: 'D:\\skill',
    workspace: 'D:\\ws',
    runs: [],
    outDir: 'D:\\ws\\batch',
    loader: async () => {
      called = true
      return {}
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO-RUNS')
  assert.equal(called, false)
})

test('repeat.mjs 未就绪时返回 REPEAT-MISSING 而不是抛错', async () => {
  const result = await runBatchSummary({
    skillDir: 'D:\\skill',
    workspace: 'D:\\ws',
    runs: ['a/result.json'],
    outDir: 'D:\\ws\\batch',
    loader: async () => {
      const error = new Error('missing')
      error.code = 'REPEAT-MISSING'
      throw error
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'REPEAT-MISSING')
  assert.match(result.error, /repeat\.mjs/)
})

test('runRepeat 缺导出或抛错都被收敛', async () => {
  const invalid = await runBatchSummary({
    skillDir: 'D:\\skill',
    workspace: 'D:\\ws',
    runs: ['a/result.json'],
    outDir: 'D:\\ws\\batch',
    loader: async () => ({ runRepeat: 'not-a-function' }),
  })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'REPEAT-INVALID')

  const failed = await runBatchSummary({
    skillDir: 'D:\\skill',
    workspace: 'D:\\ws',
    runs: ['a/result.json'],
    outDir: 'D:\\ws\\batch',
    loader: async () => ({
      runRepeat: async () => {
        throw new Error('boom')
      },
    }),
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'REPEAT-FAILED')
  assert.match(failed.error, /boom/)
})
