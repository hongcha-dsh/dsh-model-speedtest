/**
 * HTTP 路由（CONTRACT §4，全部走 `ctx.connection.fetch.register`）。
 *
 * 统一响应：
 * - 成功 `{ ok: true, ... }`
 * - 失败 `{ ok: false, error: { code, message, ...附加字段 } }`，状态码 400/404/409/500。
 * 路径全部为精确路径，不使用动态段。
 */
import { SpeedtestError, toSpeedtestError } from './errors.js'
import { errorResponseOf } from './service.js'

/** 单次请求体上限（防止误传超大 JSON 撑爆内存）。 */
const MAX_BODY_BYTES = 64 * 1024

/**
 * 构造 JSON 响应。
 * @param {number} status HTTP 状态码。
 * @param {unknown} payload 响应体。
 * @returns {Response} fetch Response。
 */
function jsonResponse(status, payload) {
  return Response.json(payload, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * 读取并解析 JSON 请求体。
 * @param {Request} request 请求。
 * @returns {Promise<Record<string, any>>} 请求体对象。
 * @throws {SpeedtestError} BAD-REQUEST。
 */
async function readJsonBody(request) {
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new SpeedtestError('BAD-REQUEST', '请求体过大。')
  }
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new SpeedtestError('BAD-REQUEST', '请求体必须是合法的 JSON。')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SpeedtestError('BAD-REQUEST', '请求体必须是 JSON 对象。')
  }
  return parsed
}

/**
 * 路由表。`handlers` 返回业务响应体；`status` 用于成功状态码。
 */
const ROUTES = [
  {
    path: '/api/speedtest/context',
    methods: ['GET'],
    status: 200,
    handle: (service, _body, query) => service.context({ sessionId: query.get('sessionId') ?? '' }),
  },
  {
    path: '/api/speedtest/batches',
    methods: ['POST'],
    status: 202,
    handle: (service, body) => service.startBatch(body),
  },
  {
    path: '/api/speedtest/status',
    methods: ['GET'],
    status: 200,
    handle: (service) => service.status(),
  },
  {
    path: '/api/speedtest/index',
    methods: ['GET'],
    status: 200,
    handle: (service, _body, query) => service.readIndex({ limit: query.get('limit') ?? undefined }),
  },
  {
    path: '/api/speedtest/batch',
    methods: ['GET'],
    status: 200,
    handle: (service, _body, query) => service.readBatch({ id: query.get('id') ?? '' }),
  },
  {
    path: '/api/speedtest/batch/rename',
    methods: ['POST'],
    status: 200,
    handle: (service, body) => service.renameBatch(body),
  },
  {
    path: '/api/speedtest/batch/delete',
    methods: ['POST'],
    status: 200,
    handle: (service, body) => service.deleteBatch(body),
  },
  {
    path: '/api/speedtest/batch/cancel',
    methods: ['POST'],
    status: 200,
    handle: (service, body) => service.cancelBatch(body),
  },
  {
    path: '/api/speedtest/unlock',
    methods: ['POST'],
    status: 200,
    handle: (service, body) => service.unlock(body),
  },
]

/**
 * 处理一次路由请求：解析参数 → 调服务 → 统一错误映射。
 * @param {typeof ROUTES[number]} route 路由定义。
 * @param {any} service 测速服务。
 * @param {Request} request fetch 请求。
 * @returns {Promise<Response>} 响应。
 */
async function dispatch(route, service, request) {
  try {
    const url = new URL(request.url)
    const query = url.searchParams
    const body = route.methods.includes('POST') ? await readJsonBody(request) : {}
    const payload = await route.handle(service, body, query)
    return jsonResponse(route.status, payload)
  } catch (error) {
    const { status, body } = errorResponseOf(error)
    return jsonResponse(status, body)
  }
}

/**
 * 注册全部测速路由。每条路由都通过 `ctx.effect` 注册，卸载时自动注销。
 * @param {any} ctx Host 插件上下文（inject 含 connection）。
 * @param {any} service 测速服务。
 * @returns {void}
 */
export function registerSpeedtestRoutes(ctx, service) {
  for (const route of ROUTES) {
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: route.path,
          methods: route.methods,
          requestBody: 'buffered',
          fetch: (request) => dispatch(route, service, request),
        }),
      `model-speedtest: ${route.path}`,
    )
  }
}

/**
 * 导出错误归一化，供命令层复用同一套 code/message。
 * @param {unknown} error 抛出值。
 * @returns {SpeedtestError} 归一化错误。
 */
export function normalizeRouteError(error) {
  return toSpeedtestError(error)
}
