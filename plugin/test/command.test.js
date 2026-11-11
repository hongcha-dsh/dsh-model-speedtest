import assert from 'node:assert/strict'
import test from 'node:test'
import { COMMAND_KIND, normalizeRounds, parseSpeedtestCommand, SPEEDTEST_USAGE } from '../lib/command.js'

const LIMITS = { defaultRounds: 3, maxRounds: 9 }

test('/speedtest 无参数使用默认轮数', () => {
  assert.deepEqual(parseSpeedtestCommand('', LIMITS), { kind: COMMAND_KIND.START, rounds: 3 })
  assert.deepEqual(parseSpeedtestCommand('   ', LIMITS), { kind: COMMAND_KIND.START, rounds: 3 })
})

test('/speedtest N 与 rounds=N 都解析成轮数', () => {
  assert.deepEqual(parseSpeedtestCommand('5', LIMITS), { kind: COMMAND_KIND.START, rounds: 5 })
  assert.deepEqual(parseSpeedtestCommand(' rounds=4 ', LIMITS), { kind: COMMAND_KIND.START, rounds: 4 })
  assert.deepEqual(parseSpeedtestCommand('rounds:2', LIMITS), { kind: COMMAND_KIND.START, rounds: 2 })
})

test('/speedtest help 返回用法', () => {
  assert.deepEqual(parseSpeedtestCommand('help', LIMITS), { kind: COMMAND_KIND.HELP })
  assert.deepEqual(parseSpeedtestCommand('--help', LIMITS), { kind: COMMAND_KIND.HELP })
})

test('越界轮数返回 BAD-ROUNDS', () => {
  const tooSmall = parseSpeedtestCommand('1', LIMITS)
  assert.equal(tooSmall.kind, COMMAND_KIND.ERROR)
  assert.equal(tooSmall.code, 'BAD-ROUNDS')
  const tooLarge = parseSpeedtestCommand('10', LIMITS)
  assert.equal(tooLarge.code, 'BAD-ROUNDS')
  assert.match(tooLarge.message, /2 到 9/)
  assert.ok(tooLarge.message.includes(SPEEDTEST_USAGE))
})

test('无法识别的参数返回 BAD-REQUEST', () => {
  const bad = parseSpeedtestCommand('abc', LIMITS)
  assert.equal(bad.kind, COMMAND_KIND.ERROR)
  assert.equal(bad.code, 'BAD-REQUEST')
})

test('默认轮数超过上限时报告 BAD-ROUNDS', () => {
  const bad = parseSpeedtestCommand('', { defaultRounds: 12, maxRounds: 9 })
  assert.equal(bad.kind, COMMAND_KIND.ERROR)
  assert.equal(bad.code, 'BAD-ROUNDS')
})

test('normalizeRounds 校验 HTTP 请求里的 rounds', () => {
  assert.deepEqual(normalizeRounds(undefined, LIMITS), { ok: true, rounds: 3 })
  assert.deepEqual(normalizeRounds(null, LIMITS), { ok: true, rounds: 3 })
  assert.deepEqual(normalizeRounds(6, LIMITS), { ok: true, rounds: 6 })
  assert.deepEqual(normalizeRounds('2', LIMITS), { ok: true, rounds: 2 })
  const invalid = normalizeRounds(1, LIMITS)
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'BAD-ROUNDS')
  const fraction = normalizeRounds(2.5, LIMITS)
  assert.equal(fraction.ok, false)
})
