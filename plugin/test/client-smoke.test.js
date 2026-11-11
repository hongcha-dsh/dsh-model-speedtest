import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { readFileSync } from 'node:fs'

/**
 * Client smoke test: renders the plugin-detail section with a pocket React
 * runtime and a fake fetch, then walks the produced tree to drive the flows of
 * DESIGN §8 (list → detail → rename → delete) and the new launch flow.
 *
 * The client half is a browser script (window.__ModuleLoader__), so it is
 * evaluated with new Function instead of imported.
 */

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const ORIGINAL_FETCH = globalThis.fetch

after(() => {
  globalThis.fetch = ORIGINAL_FETCH
})

// ---- pocket React ---------------------------------------------------------

function createReact() {
  const Fragment = Symbol('Fragment')
  const instances = new Map()
  const dirtyRef = { value: false }
  const cleanups = []
  let current = null
  let rootElement = null
  let currentTree = null

  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
  }
  Component.prototype.isReactComponent = true

  function createElement(type, props, ...children) {
    const flat = []
    const push = value => {
      if (Array.isArray(value)) value.forEach(push)
      else if (value === null || value === undefined || value === false) return
      else flat.push(value)
    }
    children.forEach(push)
    return { type, props: Object.assign({}, props, { children: flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat }) }
  }

  function instanceFor(type) {
    let inst = instances.get(type)
    if (inst === undefined) {
      inst = { type, hooks: [], cursor: 0, pending: [] }
      instances.set(type, inst)
    }
    return inst
  }

  function useState(initial) {
    const inst = current
    const index = inst.cursor++
    if (!(index in inst.hooks)) {
      inst.hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = inst.hooks[index]
    return [
      slot.value,
      next => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        dirtyRef.value = true
      },
    ]
  }

  function useEffect(effect, deps) {
    const inst = current
    const index = inst.cursor++
    const previous = inst.hooks[index]
    const changed =
      previous === undefined ||
      deps === undefined ||
      previous.deps.length !== deps.length ||
      deps.some((value, k) => !Object.is(value, previous.deps[k]))
    if (changed) {
      inst.hooks[index] = { kind: 'effect', deps: deps === undefined ? [] : deps, run: effect }
      inst.pending.push(effect)
    }
  }

  function useCallback(fn, deps) {
    const inst = current
    const index = inst.cursor++
    const previous = inst.hooks[index]
    if (previous !== undefined && deps !== undefined && previous.deps.length === deps.length && deps.every((value, k) => Object.is(value, previous.deps[k]))) {
      return previous.fn
    }
    inst.hooks[index] = { kind: 'callback', deps: deps === undefined ? [] : deps, fn }
    return fn
  }

  function useRef(initial) {
    const inst = current
    const index = inst.cursor++
    if (!(index in inst.hooks)) inst.hooks[index] = { kind: 'ref', ref: { current: initial } }
    return inst.hooks[index].ref
  }

  function useSyncExternalStore(subscribe, getSnapshot) {
    const inst = current
    const index = inst.cursor++
    if (!(index in inst.hooks)) {
      inst.hooks[index] = { kind: 'store' }
      subscribe(() => {
        dirtyRef.value = true
      })
    }
    return getSnapshot()
  }

  function renderNode(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map(renderNode)
    if (node.type === Fragment) return renderNode(node.props.children)
    if (typeof node.type === 'function') {
      if (node.type.prototype !== undefined && node.type.prototype.isReactComponent === true) {
        const inst = new node.type(node.props)
        return renderNode(inst.render())
      }
      const inst = instanceFor(node.type)
      current = inst
      inst.cursor = 0
      const out = node.type(node.props)
      current = null
      return renderNode(out)
    }
    return {
      type: node.type,
      props: Object.assign({}, node.props, { children: renderNode(node.props.children) }),
    }
  }

  return {
    React: {
      createElement,
      Fragment,
      Component,
      useState,
      useEffect,
      useCallback,
      useRef,
      useSyncExternalStore,
    },
    /** Render the root once; later renders are driven by settle(). */
    render(rootType, props) {
      rootElement = createElement(rootType, props)
      currentTree = renderNode(rootElement)
      return { tree: currentTree, dirty: dirtyRef }
    },
    /** Run pending effects, then re-render while state changes keep arriving. */
    async settle() {
      for (let round = 0; round < 15; round += 1) {
        const effects = []
        for (const inst of instances.values()) {
          effects.push(...inst.pending.splice(0))
        }
        for (const effect of effects) {
          const cleanup = effect()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        }
        await new Promise(resolve => setTimeout(resolve, 0))
        await new Promise(resolve => setTimeout(resolve, 0))
        if (dirtyRef.value === false) break
        dirtyRef.value = false
        currentTree = renderNode(rootElement)
      }
    },
    /** Latest rendered tree (nodes are recreated on every render). */
    getTree() {
      return currentTree
    },
    instances,
    cleanups,
  }
}

// ---- tree helpers ---------------------------------------------------------

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.props && node.props.children)
}

function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    node.forEach(child => findAll(child, predicate, found))
    return found
  }
  if (predicate(node)) found.push(node)
  findAll(node.props && node.props.children, predicate, found)
  return found
}

const byClass = name => node => node.props && node.props.className === name
const byText = text => node => node.props && node.props.children !== undefined && textOf(node).trim() === text
const byPlaceholder = part => node => node.props && typeof node.props.placeholder === 'string' && node.props.placeholder.indexOf(part) !== -1
const buttonByText = text => node => node.type === 'button' && typeof node.props.onClick === 'function' && textOf(node).trim() === text

function click(node) {
  assert.ok(node && typeof node.props.onClick === 'function', 'node should have onClick')
  node.props.onClick({ preventDefault() {}, target: node, currentTarget: node })
}

// ---- client harness -------------------------------------------------------

function load({ status, index, batch, renameResult, deleteResult }) {
  const calls = { startSession: [], openSession: [], fetch: [], rename: [], remove: [] }
  const runtime = createReact()
  let loaded = null
  const sandbox = {
    __ModuleLoader__: {
      load(module) {
        loaded = module
      },
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: () => true,
  }
  globalThis.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    calls.fetch.push({ url, method, body: init && init.body ? JSON.parse(init.body) : null })
    const json = payload => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'POST' && url.indexOf('/api/speedtest/batch/rename') === 0) {
      calls.rename.push(JSON.parse(init.body))
      return json(renameResult)
    }
    if (method === 'POST' && url.indexOf('/api/speedtest/batch/delete') === 0) {
      calls.remove.push(JSON.parse(init.body))
      return json(deleteResult)
    }
    if (url.indexOf('/api/speedtest/status') === 0) return json(status)
    if (url.indexOf('/api/speedtest/index') === 0) return json(index)
    if (url.indexOf('/api/speedtest/batch') === 0) return json(batch)
    return { ok: false, status: 404, json: async () => ({ ok: false, error: { code: 'NOT-FOUND', message: url } }) }
  }
  new Function('window', SOURCE)(sandbox)
  assert.ok(loaded !== null, 'module table load should register the plugin')

  const dicts = {}
  const locale = {
    register(ns, value) {
      dicts[ns] = value
    },
    bind(ns) {
      return (key, params) => {
        const template = (dicts[ns] && dicts[ns].zh && dicts[ns].zh[key]) || key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
  }
  const registrations = []
  const slots = {
    inject(name, callback) {
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  }
  const uiWorkspace = {
    startSession(workspaceId, options) {
      calls.startSession.push({ workspaceId, options })
    },
    openSession(id) {
      calls.openSession.push(id)
    },
  }
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    locale,
    slots,
    get(key) {
      return key === 'uiWorkspace' ? uiWorkspace : undefined
    },
  }
  const module = loaded.factory(name => {
    if (name === 'react') return runtime.React
    throw new Error('unexpected require: ' + name)
  })
  assert.equal(typeof module.apply, 'function')
  module.apply(ctx)
  return { runtime, registrations, calls, dicts }
}

const BATCH_ID = 'st-20261111-120000-ab12'
const CREATED = '2026-11-11T12:00:00.000+08:00'
const STATUS = {
  ok: true,
  defaults: { rounds: 3, maxRounds: 9, runTimeoutMinutes: 10 },
  skill: { dir: 'D:\\\\skill', skillHash: 'abcdef', taskVersion: 'dev-short-v1' },
  activeBatch: null,
}
const INDEX = {
  ok: true,
  batches: [
    {
      batchId: BATCH_ID,
      name: '火山 k3.1 对比',
      dir: 'D:\\\\ws\\\\.speedtest\\\\batches\\\\' + BATCH_ID,
      createdAt: CREATED,
      status: 'done',
      env: { provider: 'huosan', model: 'kimi-k3.1-pro', agentPreset: 'standard' },
      rounds: 2,
      passed: 2,
      medians: { elapsedSeconds: 96, speedTps: 12.3 },
    },
  ],
}
const BATCH = {
  ok: true,
  batch: {
    schemaVersion: 1,
    batchId: BATCH_ID,
    name: '火山 k3.1 对比',
    createdAt: CREATED,
    updatedAt: CREATED,
    status: 'done',
    workspaceRoot: 'D:\\\\ws',
    batchDir: 'D:\\\\ws\\\\.speedtest\\\\batches\\\\' + BATCH_ID,
    env: { provider: 'huosan', model: 'kimi-k3.1-pro', reasoningEffort: 'high', agentPreset: 'standard', permissionPreset: 'workspace-write' },
    skill: { dir: 'D:\\\\skill', skillHash: 'abcdef', taskVersion: 'dev-short-v1' },
    rounds: [
      { index: 1, status: 'passed', elapsedSeconds: 96, speedTps: 12.3, error: null },
      { index: 2, status: 'passed', elapsedSeconds: 100, speedTps: 14, error: null },
    ],
    summary: {
      total: 2,
      passed: 2,
      stats: { elapsedSeconds: { n: 2, median: 98, mad: 2 }, speedTps: { n: 2, median: 13.15 } },
    },
    notes: [],
  },
  live: null,
}
const SUBJECT = { kind: 'bundle', pkg: { name: '@local/model-speedtest', rows: [{ rowId: 'model-speedtest' }] } }

test('section renders nothing for other plugin pages', () => {
  const harness = load({ status: STATUS, index: INDEX, batch: BATCH, renameResult: { ok: true, name: 'x' }, deleteResult: { ok: true } })
  const section = harness.registrations[0].component
  const tree = harness.runtime.render(section, { subject: { kind: 'bundle', pkg: { name: 'other-plugin' } } }).tree
  assert.equal(textOf(tree), '')
})

test('list view shows the start form and archive names', async () => {
  const harness = load({ status: STATUS, index: INDEX, batch: BATCH, renameResult: { ok: true, name: 'x' }, deleteResult: { ok: true } })
  const section = harness.registrations[0].component
  harness.runtime.render(section, { subject: SUBJECT })
  await harness.runtime.settle()
  const text = textOf(harness.runtime.getTree())
  assert.match(text, /开始新批次/)
  assert.match(text, /火山 k3\.1 对比/)
  assert.match(text, /2 轮 · 通过 2/)
  assert.match(text, /96\.0 s/)
  assert.match(text, /12\.30 tok\/s/)
  assert.equal(harness.calls.startSession.length, 0)
})

test('clicking start opens a session with the prefilled command', async () => {
  const harness = load({ status: STATUS, index: INDEX, batch: BATCH, renameResult: { ok: true, name: 'x' }, deleteResult: { ok: true } })
  const section = harness.registrations[0].component
  harness.runtime.render(section, { subject: SUBJECT })
  await harness.runtime.settle()
  const startButton = findAll(harness.runtime.getTree(), node => node.props && node.props.className === 'mst-btn mst-btn-primary' && /开始 3 轮/.test(textOf(node)))[0]
  click(startButton)
  await harness.runtime.settle()
  assert.equal(harness.calls.startSession.length, 1)
  assert.equal(harness.calls.startSession[0].options.prompt, '/speedtest 3')
  assert.equal(harness.calls.startSession[0].options.whenDraftExists, 'append')
  assert.match(textOf(harness.runtime.getTree()), /已新建测速对话/)
})

test('archive detail, rename and delete round-trip', async () => {
  const harness = load({
    status: STATUS,
    index: INDEX,
    batch: BATCH,
    renameResult: { ok: true, batchId: BATCH_ID, name: '火山 k3.1 对比 · 二次' },
    deleteResult: { ok: true, batchId: BATCH_ID, filesRemoved: true },
  })
  const section = harness.registrations[0].component
  harness.runtime.render(section, { subject: SUBJECT })
  await harness.runtime.settle()

  // 1. list -> detail
  const archive = findAll(harness.runtime.getTree(), node => node.type === 'tr' && node.props.className === 'mst-archive-row')[0]
  click(archive)
  await harness.runtime.settle()
  assert.ok(harness.calls.fetch.some(call => call.url.indexOf('/api/speedtest/batch?id=' + BATCH_ID) === 0))
  assert.match(textOf(harness.runtime.getTree()), /返回列表/)
  assert.match(textOf(harness.runtime.getTree()), /批次环境/)
  assert.match(textOf(harness.runtime.getTree()), /缓存/)
  assert.match(textOf(harness.runtime.getTree()), /任务/)
  assert.match(textOf(harness.runtime.getTree()), /统计/)
  assert.match(textOf(harness.runtime.getTree()), /完成耗时（秒）/)
  assert.match(textOf(harness.runtime.getTree()), /有效速度（tok\/s）/)

  // 2. rename
  const renameButton = findAll(harness.runtime.getTree(), buttonByText('重命名'))[0]
  click(renameButton)
  await harness.runtime.settle()
  const input = findAll(harness.runtime.getTree(), byPlaceholder('输入新名称'))[0]
  assert.ok(input, 'rename input should be visible')
  input.props.onChange({ target: { value: '火山 k3.1 对比 · 二次' } })
  await harness.runtime.settle()
  const saveButton = findAll(harness.runtime.getTree(), buttonByText('保存'))[0]
  click(saveButton)
  await harness.runtime.settle()
  assert.deepEqual(harness.calls.rename, [{ batchId: BATCH_ID, name: '火山 k3.1 对比 · 二次' }])
  assert.match(textOf(harness.runtime.getTree()), /已重命名为「火山 k3\.1 对比 · 二次」/)

  // 3. delete -> inline confirm -> back to list
  const deleteButton = findAll(harness.runtime.getTree(), buttonByText('删除存档'))[0]
  click(deleteButton)
  await harness.runtime.settle()
  assert.match(textOf(harness.runtime.getTree()), /将删除该批次目录及其中所有轮次产物，不可恢复/)
  const confirmButton = findAll(harness.runtime.getTree(), buttonByText('确认删除'))[0]
  click(confirmButton)
  await harness.runtime.settle()
  assert.deepEqual(harness.calls.remove, [{ batchId: BATCH_ID, confirm: true }])
  assert.equal(textOf(harness.runtime.getTree()).indexOf('返回列表'), -1)
  assert.match(textOf(harness.runtime.getTree()), /已删除存档/)
  assert.equal(harness.calls.startSession.length, 0)
})
