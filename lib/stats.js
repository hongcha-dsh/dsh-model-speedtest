/**
 * 轮次指标统计（纯逻辑）。
 *
 * CONTRACT §5.1 的 summary.stats 需要中位数 / 最小值 / 最大值 / 极差 / MAD；
 * 这里只处理“有限数字数组”，空集与未知值一律返回 null，绝不把未知当 0。
 */

/**
 * 四舍五入到指定小数位。
 * @param {number} value 数值。
 * @param {number} [digits] 小数位，默认 1。
 * @returns {number} 保留位数后的数值。
 */
export function roundTo(value, digits = 1) {
  if (!Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * 中位数：偶数个取中间两数均值。
 * @param {number[]} values 有限数字数组（调用方负责过滤非有限值）。
 * @returns {number | null} 中位数，空集为 null。
 */
export function medianOf(values) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * MAD（中位数绝对偏差）：median(|x - median|)。
 * @param {number[]} values 有限数字数组。
 * @returns {number | null} MAD，空集为 null。
 */
export function madOf(values) {
  const median = medianOf(values)
  if (median === null) return null
  return medianOf(values.map((value) => Math.abs(value - median)))
}

/**
 * 计算一组值的统计摘要；空集除 n=0 外全部为 null。
 * @param {number[]} values 候选值（非有限值会被忽略）。
 * @returns {{ n: number, median: number | null, min: number | null, max: number | null, range: number | null, mad: number | null }} 统计摘要。
 */
export function statsOf(values) {
  const usable = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value))
  if (usable.length === 0) {
    return { n: 0, median: null, min: null, max: null, range: null, mad: null }
  }
  const min = Math.min(...usable)
  const max = Math.max(...usable)
  return {
    n: usable.length,
    median: roundTo(medianOf(usable)),
    min: roundTo(min),
    max: roundTo(max),
    range: roundTo(max - min),
    mad: roundTo(madOf(usable)),
  }
}
