import test from 'node:test';
import assert from 'node:assert/strict';

import { summarize } from '../src/summary.js';

test('返回值只包含 count/min/max/median 四个字段', () => {
  const result = summarize([1, 2, 3]);
  assert.deepEqual(Object.keys(result).sort(), ['count', 'max', 'median', 'min']);
});

test('奇数长度：count/min/max/median 正确', () => {
  assert.deepEqual(summarize([5, 1, 3]), { count: 3, min: 1, max: 5, median: 3 });
});

test('奇数长度（乱序、含负数）', () => {
  assert.deepEqual(summarize([-1, 7, 3]), { count: 3, min: -1, max: 7, median: 3 });
});

test('偶数长度：median 取中间两数的平均值', () => {
  assert.deepEqual(summarize([4, 1, 3, 2]), { count: 4, min: 1, max: 4, median: 2.5 });
});

test('偶数长度（两个元素）', () => {
  assert.deepEqual(summarize([10, 2]), { count: 2, min: 2, max: 10, median: 6 });
});

test('偶数长度（平均值带小数）', () => {
  assert.deepEqual(summarize([1.5, 2.5]), { count: 2, min: 1.5, max: 2.5, median: 2 });
});

test('单个元素', () => {
  assert.deepEqual(summarize([7]), { count: 1, min: 7, max: 7, median: 7 });
});

test('小数与负数混合', () => {
  assert.deepEqual(summarize([-2.5, 0, 3.5]), { count: 3, min: -2.5, max: 3.5, median: 0 });
});

test('空数组：count 为 0，min/max/median 为 null', () => {
  assert.deepEqual(summarize([]), { count: 0, min: null, max: null, median: null });
});

test('非数组输入抛出 TypeError', () => {
  const bad = [null, undefined, 42, '1,2,3', {}, true, new Set([1])];
  for (const value of bad) {
    assert.throws(() => summarize(value), TypeError);
  }
});

test('数组含非数值元素抛出 TypeError', () => {
  const cases = [
    ['1', 2],
    [1, null],
    [1, undefined],
    [1, NaN],
    [1, Infinity],
    [1, -Infinity],
    [true],
    [{}, 1],
    [[1], 2],
  ];
  for (const values of cases) {
    assert.throws(() => summarize(values), TypeError);
  }
});

test('不修改入参（奇数长度）', () => {
  const input = [3, 1, 2];
  const snapshot = [...input];
  summarize(input);
  assert.deepEqual(input, snapshot);
});

test('不修改入参（偶数长度、乱序）', () => {
  const input = [9, 4, 7, 1, 6, 2];
  const snapshot = [...input];
  summarize(input);
  assert.deepEqual(input, snapshot);
});

test('不修改入参：冻结数组也能处理', () => {
  const input = Object.freeze([3, 1, 2]);
  assert.deepEqual(summarize(input), { count: 3, min: 1, max: 3, median: 2 });
  assert.deepEqual([...input], [3, 1, 2]);
});

test('重复调用结果稳定（无内部状态）', () => {
  const input = [2, 8, 4, 6];
  assert.deepEqual(summarize(input), summarize(input));
  assert.deepEqual(summarize(input), { count: 4, min: 2, max: 8, median: 5 });
});
