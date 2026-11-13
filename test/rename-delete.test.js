import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteStoredBatch, indexEntryWithName, renameStoredBatch } from '../lib/archive-ops.js'
import { createBatchRecord } from '../lib/state.js'
import { batchJsonPath, batchesDir, globalIndexPath } from '../lib/paths.js'

const BATCH_ID = 'st-20261111-120000-ab12'
const CREATED = '2026-11-11T12:00:00.000+08:00'

const idleRunner = {
  liveRecord: () => null,
  anyLive: () => null,
}

function indexEntry(overrides = {}) {
  return {
    batchId: BATCH_ID,
    dir: '',
    createdAt: CREATED,
    status: 'done',
    env: { provider: 'p', model: 'm', agentPreset: 'standard' },
    rounds: 2,
    passed: 1,
    medians: { elapsedSeconds: 96, speedTps: 12 },
    ...overrides,
  }
}

async function writeIndex(home, batches) {
  await mkdir(join(home, 'speedtest'), { recursive: true })
  await writeFile(globalIndexPath(home), JSON.stringify({ schemaVersion: 1, batches }, null, 2), 'utf8')
}

async function readIndex(home) {
  return JSON.parse(await readFile(globalIndexPath(home), 'utf8'))
}

async function setup(runner = idleRunner) {
  const root = await mkdtemp(join(tmpdir(), 'mst-archive-'))
  const workspaceRoot = join(root, 'ws')
  const home = join(root, 'home')
  const batchDirPath = join(batchesDir(workspaceRoot), BATCH_ID)
  await mkdir(batchDirPath, { recursive: true })
  const batch = createBatchRecord({
    batchId: BATCH_ID,
    createdAt: CREATED,
    controlSessionId: 'session-control',
    workspaceRoot,
    batchDir: batchDirPath,
    rounds: 2,
    env: { provider: 'p', model: 'm', reasoningEffort: 'high', agentPreset: 'standard', permissionPreset: 'workspace-write' },
    skill: { dir: 'D:\\skill', skillHash: 'abc', taskVersion: 'dev-short-v1' },
  })
  // 每轮都有真实的 run 目录与测速会话，用来验证「删存档」会顺手清掉残留。
  const runIds = ['20261111-120100-aaaaaa', '20261111-120200-bbbbbb']
  for (let index = 0; index < batch.rounds.length; index += 1) {
    const runDir = join(workspaceRoot, '.speedtest', runIds[index])
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'result.json'), '{}', 'utf8')
    batch.rounds[index].runId = runIds[index]
    batch.rounds[index].resultPath = join(runDir, 'result.json')
    batch.rounds[index].sessionId = 'session-round-' + (index + 1)
  }
  await writeFile(batchJsonPath(batchDirPath), JSON.stringify(batch, null, 2), 'utf8')
  await writeIndex(home, [indexEntry({ dir: batchDirPath })])
  return { root, workspaceRoot, home, dir: batchDirPath, batch, runner, runIds }
}

/**
 * 假的 Cordis 上下文：只提供 workspaceRegistry.archiveSession。
 * @returns {{ archived: string[], ctx: Record<string, any> }} 归档调用记录与上下文。
 */
function makeCtx() {
  const archived = []
  return {
    archived,
    ctx: {
      get: (key) =>
        key === 'workspaceRegistry'
          ? {
              archiveSession: async (sessionId) => {
                archived.push(sessionId)
              },
            }
          : undefined,
    },
  }
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true })
}

test('renameStoredBatch 写 batch.json 与索引，名称 trim 后保存', async () => {
  const env = await setup()
  try {
    const result = await renameStoredBatch({
      runner: env.runner,
      home: env.home,
      body: { batchId: BATCH_ID, name: '  火山 k3.1 对比  ' },
    })
    assert.deepEqual(result, { ok: true, batchId: BATCH_ID, name: '火山 k3.1 对比' })
    const saved = JSON.parse(await readFile(batchJsonPath(env.dir), 'utf8'))
    assert.equal(saved.name, '火山 k3.1 对比')
    assert.equal(typeof saved.nameUpdatedAt, 'string')
    assert.match(saved.nameUpdatedAt, /^\d{4}-\d{2}-\d{2}T/)
    const index = await readIndex(env.home)
    assert.equal(index.batches[0].name, '火山 k3.1 对比')
  } finally {
    await cleanup(env.root)
  }
})

test('renameStoredBatch 允许给运行中的批次改名，并同步内存记录', async () => {
  const env = await setup()
  const liveBatch = { ...env.batch, status: 'running' }
  const runner = {
    liveRecord: (id) => (id === BATCH_ID ? { batch: liveBatch, live: { status: 'running' } } : null),
    anyLive: () => null,
  }
  try {
    const result = await renameStoredBatch({
      runner,
      home: env.home,
      body: { batchId: BATCH_ID, name: '运行中改名' },
    })
    assert.equal(result.name, '运行中改名')
    assert.equal(liveBatch.name, '运行中改名')
    const saved = JSON.parse(await readFile(batchJsonPath(env.dir), 'utf8'))
    assert.equal(saved.name, '运行中改名')
  } finally {
    await cleanup(env.root)
  }
})

test('renameStoredBatch 拒绝空名/超长/控制字符，且不写文件', async () => {
  const env = await setup()
  try {
    for (const name of ['', '   ', 'a'.repeat(81), 'a\nb', 42]) {
      await assert.rejects(
        renameStoredBatch({ runner: env.runner, home: env.home, body: { batchId: BATCH_ID, name } }),
        (error) => error.code === 'BAD-NAME',
      )
    }
    const saved = JSON.parse(await readFile(batchJsonPath(env.dir), 'utf8'))
    assert.equal('name' in saved, false)
  } finally {
    await cleanup(env.root)
  }
})

test('renameStoredBatch 对不存在的批次返回 BATCH-NOT-FOUND', async () => {
  const env = await setup()
  try {
    await assert.rejects(
      renameStoredBatch({
        runner: env.runner,
        home: env.home,
        body: { batchId: 'st-20261111-999999-zzzz', name: 'x' },
      }),
      (error) => error.code === 'BATCH-NOT-FOUND',
    )
  } finally {
    await cleanup(env.root)
  }
})

test('deleteStoredBatch 必须带 confirm:true', async () => {
  const env = await setup()
  try {
    await assert.rejects(
      deleteStoredBatch({ runner: env.runner, home: env.home, body: { batchId: BATCH_ID } }),
      (error) => error.code === 'CONFIRM-REQUIRED',
    )
    await assert.rejects(
      deleteStoredBatch({ runner: env.runner, home: env.home, body: { batchId: BATCH_ID, confirm: 'yes' } }),
      (error) => error.code === 'CONFIRM-REQUIRED',
    )
    const still = JSON.parse(await readFile(batchJsonPath(env.dir), 'utf8'))
    assert.equal(still.batchId, BATCH_ID)
  } finally {
    await cleanup(env.root)
  }
})

test('deleteStoredBatch 拒绝仍在运行的批次（BATCH-ACTIVE）', async () => {
  const env = await setup()
  const liveBatch = { ...env.batch, status: 'running' }
  const runner = {
    liveRecord: (id) => (id === BATCH_ID ? { batch: liveBatch, live: { status: 'running' } } : null),
    anyLive: () => null,
  }
  try {
    await assert.rejects(
      deleteStoredBatch({ runner, home: env.home, body: { batchId: BATCH_ID, confirm: true } }),
      (error) => error.code === 'BATCH-ACTIVE',
    )
    const still = JSON.parse(await readFile(batchJsonPath(env.dir), 'utf8'))
    assert.equal(still.batchId, BATCH_ID)
  } finally {
    await cleanup(env.root)
  }
})

test('deleteStoredBatch 删除目录、索引条目、轮次产物与测速会话', async () => {
  const env = await setup()
  const { ctx, archived } = makeCtx()
  try {
    const result = await deleteStoredBatch({
      runner: env.runner,
      home: env.home,
      ctx,
      body: { batchId: BATCH_ID, confirm: true },
    })
    assert.deepEqual(result, {
      ok: true,
      batchId: BATCH_ID,
      filesRemoved: true,
      artifactsRemoved: 2,
      sessionsArchived: 2,
    })
    await assert.rejects(readFile(batchJsonPath(env.dir), 'utf8'), (error) => error.code === 'ENOENT')
    // 关键回归：删存档不能把 .speedtest/<runId> 留在工作区（旧版只删批次目录）。
    for (const runId of env.runIds) {
      await assert.rejects(stat(join(env.workspaceRoot, '.speedtest', runId)), (error) => error.code === 'ENOENT')
    }
    assert.deepEqual(archived, ['session-round-1', 'session-round-2'])
    const index = await readIndex(env.home)
    assert.deepEqual(index.batches, [])
  } finally {
    await cleanup(env.root)
  }
})

test('deleteStoredBatch 目录已丢失时只移除索引（filesRemoved:false）', async () => {
  const env = await setup()
  try {
    await rm(env.dir, { recursive: true, force: true })
    const result = await deleteStoredBatch({
      runner: env.runner,
      home: env.home,
      body: { batchId: BATCH_ID, confirm: true },
    })
    assert.deepEqual(result, { ok: true, batchId: BATCH_ID, filesRemoved: false })
    const index = await readIndex(env.home)
    assert.deepEqual(index.batches, [])
  } finally {
    await cleanup(env.root)
  }
})

test('deleteStoredBatch 拒绝 basename 与 batchId 不符的目录', async () => {
  const env = await setup()
  try {
    const wrongDir = join(batchesDir(env.workspaceRoot), 'other-dir')
    await mkdir(wrongDir, { recursive: true })
    await writeFile(batchJsonPath(wrongDir), JSON.stringify({ ...env.batch, batchDir: wrongDir }, null, 2), 'utf8')
    await writeIndex(env.home, [indexEntry({ dir: wrongDir })])
    await assert.rejects(
      deleteStoredBatch({ runner: env.runner, home: env.home, body: { batchId: BATCH_ID, confirm: true } }),
      (error) => error.code === 'DELETE-UNSAFE',
    )
    const kept = JSON.parse(await readFile(batchJsonPath(wrongDir), 'utf8'))
    assert.equal(kept.batchId, BATCH_ID)
    assert.equal((await readIndex(env.home)).batches.length, 1)
  } finally {
    await cleanup(env.root)
  }
})

test('indexEntryWithName 给旧索引补 name：优先 batch.json，其次派生', async () => {
  const env = await setup()
  try {
    const saved = JSON.parse(await readFile(batchJsonPath(env.dir), 'utf8'))
    saved.name = '旧批次改名'
    await writeFile(batchJsonPath(env.dir), JSON.stringify(saved, null, 2), 'utf8')
    const missingDir = join(batchesDir(env.workspaceRoot), 'st-20261111-111111-miss')
    const withBatch = await indexEntryWithName(env.home, indexEntry({ dir: env.dir }))
    assert.equal(withBatch.name, '旧批次改名')
    const missing = await indexEntryWithName(
      env.home,
      indexEntry({ batchId: 'st-20261111-111111-miss', dir: missingDir, createdAt: '2026-10-01T08:30:00.000+08:00' }),
    )
    assert.equal(missing.name, 'm · 10-01 08:30')
  } finally {
    await cleanup(env.root)
  }
})
