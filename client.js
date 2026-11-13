// Model speedtest — client half (browser module).
//
// 入口是「设置 → 插件 → 模型测速批次」详情页里的一块区块（plugins.detail.section），
// 不再往输入区加按钮，也没有浮层面板。
//
// 启动流程：
//   1. 点「开始 N 轮」→ uiWorkspace.startSession(undefined, { prompt: '/speedtest N' })
//      新建一个对话并把提示词填进输入框（只填不发），并自动跳到该对话；
//   2. 用户在那对话里选好 provider / model / 推理强度 / 权限 / 预设，点发送；
//   3. 消息里的 /speedtest 命令用该会话的环境快照启动 N 轮批次；
//   4. 模块级看护器发现新批次后跳到第 1 轮测速会话，之后不再自动切换。
//
// 数据都来自 Host 的精确路由；这里不直接读写文件、不创建 Agent。
window.__ModuleLoader__.load({
  id: 'dsh-model-speedtest',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useSyncExternalStore } = React

    /** 本插件包名（plugins.detail.section 的 subject 用它识别自己）。 */
    const OWN_PACKAGE = 'dsh-model-speedtest'
    /** Locale namespace owned by this plugin. */
    const NS = 'model-speedtest'
    /** Client build stamp shown in the list header (bump with package.json). */
    const CLIENT_VERSION = '0.2.0'
    /** Poll interval for the plugin page's status / progress cards. */
    const POLL_MS = 1500
    /** Archive page size. */
    const HISTORY_LIMIT = 20
    /** Round bounds (CONTRACT §3.2). */
    const MIN_ROUNDS = 2
    const DEFAULT_MAX_ROUNDS = 9
    /** Batch statuses that are still moving. */
    const BATCH_ACTIVE = ['queued', 'running']
    /** After clicking start, how long the jump watcher waits for the batch to appear. */
    const JUMP_WINDOW_MS = 10 * 60 * 1000
    /** Jump watcher cadence. */
    const JUMP_POLL_MS = 2000
    /** How far before the click a batch may still count as the one we launched. */
    const JUMP_SLACK_MS = 5000

    /** Host routes used by this half (exact paths, no dynamic segments). */
    const ROUTES = {
      status: '/api/speedtest/status',
      index: '/api/speedtest/index',
      batch: '/api/speedtest/batch',
      rename: '/api/speedtest/batch/rename',
      remove: '/api/speedtest/batch/delete',
      cancel: '/api/speedtest/batch/cancel',
      workspaces: '/api/speedtest/workspaces',
    }

    /** Batch status → locale key. */
    const BATCH_STATUS_KEYS = {
      queued: 'status.queued',
      running: 'status.running',
      done: 'status.done',
      aborted: 'status.aborted',
      failed: 'status.failed',
      interrupted: 'status.interrupted',
    }

    /** Round status → locale key. */
    const ROUND_STATUS_KEYS = {
      queued: 'status.queued',
      running: 'status.running',
      passed: 'status.passed',
      failed: 'status.failed',
      timeout: 'status.timeout',
      aborted: 'status.aborted',
      'no-report': 'status.noReport',
    }

    /** Visible strings. */
    const DICTS = {
      zh: {
        'section.title': '模型测速',
        'refresh': '刷新',
        'loading': '加载中…',
        'common.dash': '—',
        'form.title': '开始新批次',
        'form.rounds': '轮数',
        'form.workspace': '工作区',
        'form.workspacePick': '请选择工作区',
        'form.workspaceLoading': '正在读取工作区…',
        'form.roundsHint': '{min}–{max} 轮，默认 {defaults} 轮',
        'form.start': '开始 {count} 轮',
        'form.starting': '正在打开…',
        'form.meta': '每轮一个全新会话 + 全新目录，单轮上限 {minutes} 分钟',
        'form.note': '点击后会跳到新对话，提示词是 /speedtest {count}；选好配置再发送。',
        'notice.started': '已新建测速对话并填入提示词，选好要测的配置后发送即可。',
        'notice.renamed': '已重命名为「{name}」',
        'notice.deleted': '已删除存档 {batchId}',
        'notice.removed': '目录本来就不存在，已从列表移除条目。',
        'notice.cancelled': '已请求取消当前轮，批次将标记为 aborted。',
        'progress.title': '当前批次',
        'progress.round': '第 {current}/{total} 轮',
        'progress.cancel': '取消批次',
        'progress.cancelling': '正在取消…',
        'progress.cancelHint': '只取消当前轮并结束批次，已有轮次结果会保留。',
        'list.title': '存档',
        'list.empty': '还没有存档。配好环境后点“开始 N 轮”。',
        'list.loading': '正在读取存档…',
        'list.rounds': '{rounds} 轮 · 通过 {passed}',
        'list.median': '中位 {seconds}s · {speed} tok/s',
        'list.col.name': '名称',
        'list.col.status': '状态',
        'list.col.rounds': '轮数/通过',
        'list.col.elapsed': '中位耗时',
        'list.col.speed': '中位速度',
        'list.col.created': '创建时间',
        'list.col.model': '模型',
        'list.buildHint': '插件客户端版本；页面没变时先重载插件再强刷（Ctrl+Shift+R）。',
        'result.cache': '缓存',
        'result.task': '任务',
        'result.cacheHit': '命中',
        'result.cacheMiss': '未命中',
        'result.cacheUnknown': '未知',
        'result.stats.title': '统计',
        'result.metric.elapsed': '完成耗时（秒）',
        'result.metric.speed': '有效速度（tok/s）',
        'result.metric.request': '模型请求耗时（秒）',
        'result.metric.toolTime': '工具耗时（秒）',
        'result.metric.stream': '流式吐字速度（tok/s）',
        'result.metric.tokens': '输出 token',
        'result.metric.tools': '工具次数',
                'result.stat.metric': '指标',
'result.stat.n': 'n',
        'result.stat.median': '中位数',
        'result.stat.min': '最小',
        'result.stat.max': '最大',
        'result.stat.mad': 'MAD',
        'detail.back': '返回列表',
        'detail.name': '名称',
        'detail.rename': '重命名',
        'detail.renameSave': '保存',
        'detail.renameCancel': '取消',
        'detail.renamePlaceholder': '输入新名称（1–80 字符）',
        'detail.delete': '删除存档',
        'detail.deleteConfirm': '将删除该批次目录及其中所有轮次产物，不可恢复。确认删除？',
        'detail.deleteYes': '确认删除',
        'detail.deleteNo': '取消',
        'detail.missing': '文件已丢失：批次目录或 batch.json 不存在。',
        'detail.removeEntry': '从列表移除条目',
        'detail.createdAt': '创建时间',
        'detail.id': '批次 ID',
        'detail.env': '批次环境',
        'detail.skill': '测速 skill',
        'detail.batchDir': '批次目录',
        'detail.copy': '复制',
        'detail.copied': '已复制',
        'result.title': '逐轮结果',
        'result.round': '轮',
        'result.outcome': '结果',
        'result.elapsed': '耗时',
        'result.speed': '有效速度',
        'result.stream': '吐字速度',
        'result.streamHint': '流式输出阶段的纯吐字速度（Σtoken ÷ Σ流式跨度），不含预填与思考等待；服务端批量下发时可能偏高，仅作对照。',
        'result.tokens': 'Token',
        'result.tools': '工具次数',
        'result.error': '错误',
        'result.sample': '样本 n={n}',
        'result.passed': '通过 {passed}/{total}',
        'result.median': '中位数',
        'result.mad': 'MAD',
        'result.failed': '未通过轮次',
        'result.empty': '本批次还没有可用的轮次结果。',
        'result.pending': '等待第一轮结果…',
        'result.mismatch': '环境不一致，未合并中位数。',
        'result.insufficient': '样本不足（n<2），不计算中位数/MAD。',
        'result.statsHint': '中位数与 MAD 只在样本 n≥2 且各轮环境一致时有意义。',
        'status.queued': '排队中',
        'status.running': '运行中',
        'status.done': '已完成',
        'status.aborted': '已取消',
        'status.failed': '失败',
        'status.interrupted': '已中断',
        'status.passed': '通过',
        'status.timeout': '超时',
        'status.noReport': '无报告',
        'status.unknown': '未知',
        'error.title': '错误',
        'error.auth': '会话未通过鉴权，请刷新页面',
        'error.network': '网络请求失败，请检查连接后重试',
        'error.unknown': '未知错误',
        'error.rounds': '轮数必须是 {min}–{max} 之间的整数。',
        'error.name': '名称需为 1–80 个字符，且不能包含控制字符。',
        'error.pickWorkspace': '请先选择工作区：批次产物会写到该工作区的 .speedtest 目录下。',
        'error.noWorkspace': '当前页面没有可用的工作区服务，无法新建对话；请刷新页面后重试。',
        'error.deleteActive': '批次仍在运行，请先取消再删除。',
        'error.clipboard': '复制失败，请手动选择文本。',
        'error.crash': '测速区块渲染出错，批次状态仍保留；请刷新页面重试。',
        'unit.seconds': '{value} s',
        'unit.tps': '{value} tok/s',
      },
      en: {
        'section.title': 'Model speedtest',
        'refresh': 'Refresh',
        'loading': 'Loading…',
        'common.dash': '—',
        'form.title': 'Start a new batch',
        'form.rounds': 'Rounds',
        'form.workspace': 'Workspace',
        'form.workspacePick': 'Select a workspace',
        'form.workspaceLoading': 'Loading workspaces…',
        'form.roundsHint': '{min}–{max} rounds, default {defaults}',
        'form.start': 'Start {count} rounds',
        'form.starting': 'Opening…',
        'form.meta': 'Each round gets a fresh session and a fresh directory; {minutes} min per round at most',
        'form.note': 'This jumps to a new conversation with /speedtest {count} prefilled; choose the configuration, then send.',
        'notice.started': 'New speedtest conversation opened with the prompt filled in. Choose the configuration, then send.',
        'notice.renamed': 'Renamed to "{name}"',
        'notice.deleted': 'Deleted archive {batchId}',
        'notice.removed': 'The directory was already gone; removed the list entry.',
        'notice.cancelled': 'Cancellation requested; the batch will be marked aborted.',
        'progress.title': 'Current batch',
        'progress.round': 'Round {current}/{total}',
        'progress.cancel': 'Cancel batch',
        'progress.cancelling': 'Cancelling…',
        'progress.cancelHint': 'Cancels the current round and ends the batch; finished rounds are kept.',
        'list.title': 'Archives',
        'list.empty': 'No archives yet. Configure the environment, then start N rounds.',
        'list.loading': 'Loading archives…',
        'list.rounds': '{rounds} rounds · {passed} passed',
        'list.median': 'median {seconds}s · {speed} tok/s',
        'list.col.name': 'Name',
        'list.col.status': 'Status',
        'list.col.rounds': 'Rounds/passed',
        'list.col.elapsed': 'Median time',
        'list.col.speed': 'Median speed',
        'list.col.created': 'Created',
        'list.col.model': 'Model',
        'list.buildHint': 'Client build of this plugin; if the page looks stale, reload the plugin and hard-refresh (Ctrl+Shift+R).',
        'result.cache': 'Cache',
        'result.task': 'Run',
        'result.cacheHit': 'hit',
        'result.cacheMiss': 'miss',
        'result.cacheUnknown': 'unknown',
        'result.stats.title': 'Statistics',
        'result.metric.elapsed': 'Elapsed (s)',
        'result.metric.speed': 'Effective speed (tok/s)',
        'result.metric.request': 'Model request time (s)',
        'result.metric.toolTime': 'Tool time (s)',
        'result.metric.stream': 'Streaming speed (tok/s)',
        'result.metric.tokens': 'Output tokens',
        'result.metric.tools': 'Tool calls',
                'result.stat.metric': 'Metric',
'result.stat.n': 'n',
        'result.stat.median': 'Median',
        'result.stat.min': 'Min',
        'result.stat.max': 'Max',
        'result.stat.mad': 'MAD',
        'detail.back': 'Back to list',
        'detail.name': 'Name',
        'detail.rename': 'Rename',
        'detail.renameSave': 'Save',
        'detail.renameCancel': 'Cancel',
        'detail.renamePlaceholder': 'New name (1–80 characters)',
        'detail.delete': 'Delete archive',
        'detail.deleteConfirm': 'This deletes the batch directory and every round artifact in it; it cannot be undone. Delete?',
        'detail.deleteYes': 'Delete',
        'detail.deleteNo': 'Cancel',
        'detail.missing': 'Files are gone: the batch directory or batch.json no longer exists.',
        'detail.removeEntry': 'Remove list entry',
        'detail.createdAt': 'Created',
        'detail.id': 'Batch ID',
        'detail.env': 'Batch environment',
        'detail.skill': 'Speedtest skill',
        'detail.batchDir': 'Batch directory',
        'detail.copy': 'Copy',
        'detail.copied': 'Copied',
        'result.title': 'Rounds',
        'result.round': 'Round',
        'result.outcome': 'Outcome',
        'result.elapsed': 'Elapsed',
        'result.speed': 'Effective speed',
        'result.stream': 'Streaming',
        'result.streamHint': 'Raw streaming throughput (Σtokens ÷ Σstream span), excluding prefill and thinking waits; may read high when the server batches chunks — reference only.',
        'result.tokens': 'Tokens',
        'result.tools': 'Tool calls',
        'result.error': 'Error',
        'result.sample': 'samples n={n}',
        'result.passed': 'passed {passed}/{total}',
        'result.median': 'Median',
        'result.mad': 'MAD',
        'result.failed': 'Rounds that did not pass',
        'result.empty': 'No round results in this batch yet.',
        'result.pending': 'Waiting for the first round…',
        'result.mismatch': 'Environment mismatch — medians were not merged.',
        'result.insufficient': 'Not enough samples (n<2); median/MAD are not computed.',
        'result.statsHint': 'Median and MAD are meaningful only with n≥2 samples from one environment.',
        'status.queued': 'Queued',
        'status.running': 'Running',
        'status.done': 'Done',
        'status.aborted': 'Aborted',
        'status.failed': 'Failed',
        'status.interrupted': 'Interrupted',
        'status.passed': 'Passed',
        'status.timeout': 'Timeout',
        'status.noReport': 'No report',
        'status.unknown': 'Unknown',
        'error.title': 'Error',
        'error.auth': 'Session authentication failed; refresh the page',
        'error.network': 'Network request failed; check the connection and retry',
        'error.unknown': 'Unknown error',
        'error.rounds': 'Rounds must be an integer between {min} and {max}.',
        'error.name': 'The name must be 1–80 characters and contain no control characters.',
        'error.pickWorkspace': 'Pick a workspace first: batch artifacts are written under that workspace .speedtest.',
        'error.noWorkspace': 'The workspace service is unavailable on this page; refresh and retry.',
        'error.deleteActive': 'The batch is still running; cancel it before deleting.',
        'error.clipboard': 'Copy failed; select the text manually.',
        'error.crash': 'The speedtest section failed to render; batch state is kept — refresh the page.',
        'unit.seconds': '{value} s',
        'unit.tps': '{value} tok/s',
      },
    }

    const SECTION_CSS = ".mst-root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}\n.mst-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}\n.mst-head-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}\n.mst-title{margin:0;font-size:15px;line-height:22px;font-weight:600}\n.mst-subtitle{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}\n.mst-card{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l4,transparent);border-radius:var(--dsw-radius-md,8px)}\n.mst-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n.mst-card-title{margin:0;font-size:13px;line-height:20px;font-weight:600;flex:none}\n.mst-spacer{flex:1 1 auto}\n.mst-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:6px 14px}\n.mst-kv{display:flex;flex-direction:column;gap:1px;min-width:0}\n.mst-k{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}\n.mst-v{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.mst-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n.mst-label{flex:none;min-width:52px;font-size:12px;color:var(--dsw-alias-label-secondary)}\n.mst-input{box-sizing:border-box;min-width:0;padding:5px 8px;border:0.5px solid var(--dsw-alias-border-l4,transparent);border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;font-family:inherit;font-size:13px;line-height:1.4}\n.mst-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,currentColor)}\n.mst-input[data-invalid=true]{border-color:var(--dsw-alias-state-error-primary,currentColor)}\n.mst-input.mst-num{width:80px}.mst-select{box-sizing:border-box;max-width:360px;height:26px;padding:0 6px;border:0.5px solid var(--dsw-alias-border-l3,currentColor);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font-family:inherit;font-size:12px;line-height:17px}\n.mst-input.mst-grow{flex:1 1 220px}\n.mst-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:30px;padding:0 12px;border:0.5px solid var(--dsw-alias-border-l4,transparent);border-radius:var(--dsw-radius-md,8px);background:transparent;color:inherit;font-family:inherit;font-size:13px;line-height:1;cursor:pointer;white-space:nowrap}\n.mst-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-hover,var(--dsw-alias-bg-layer-2,transparent))}\n.mst-btn:disabled{cursor:not-allowed;opacity:.45}\n.mst-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:1px}\n.mst-btn-primary{border:none;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-state-business-primary,currentColor));color:var(--dsw-alias-label-primary-foreground,inherit)}\n.mst-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill,transparent))}\n.mst-btn-danger{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}\n.mst-btn-small{height:24px;padding:0 8px;font-size:12px}\n.mst-btn-link{height:auto;padding:0;border:none;background:transparent;color:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-primary));cursor:pointer;font-family:inherit;font-size:12px;line-height:18px}\n.mst-muted{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}\n.mst-warn{font-size:12px;line-height:17px;color:var(--dsw-alias-label-warning,var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary)))}\n.mst-error{font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,inherit);word-break:break-word}\n.mst-notice{font-size:12px;line-height:17px;color:var(--dsw-alias-label-success,var(--dsw-alias-state-success-primary,inherit))}\n.mst-badge{flex:none;display:inline-flex;align-items:center;padding:1px 7px;border:0.5px solid var(--dsw-alias-border-l4,currentColor);border-radius:999px;font-size:11px;line-height:16px;white-space:nowrap;color:var(--dsw-alias-label-secondary)}\n.mst-badge[data-status=passed],.mst-badge[data-status=done]{color:var(--dsw-alias-label-success,var(--dsw-alias-state-success-primary));border-color:currentColor}\n.mst-badge[data-status=running],.mst-badge[data-status=queued]{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-secondary));border-color:currentColor}\n.mst-badge[data-status=failed],.mst-badge[data-status=timeout],.mst-badge[data-status=no-report]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}\n.mst-badge[data-status=aborted],.mst-badge[data-status=interrupted]{color:var(--dsw-alias-label-secondary);border-color:currentColor}\n.mst-table-wrap{width:100%;overflow-x:auto}\n.mst-table{width:100%;border-collapse:collapse;font-size:12px;line-height:17px}\n.mst-table th{padding:4px 8px;text-align:left;font-weight:500;white-space:nowrap;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));border-bottom:0.5px solid var(--dsw-alias-border-l4,transparent)}.mst-table th.mst-num{text-align:right}\n.mst-table td{padding:4px 8px;vertical-align:top;border-bottom:0.5px solid var(--dsw-alias-border-l4,transparent)}\n.mst-table tr:last-child td{border-bottom:none}\n.mst-num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}\n.mst-stats{display:flex;gap:18px;flex-wrap:wrap}\n.mst-stat{display:flex;flex-direction:column;gap:1px;min-width:0}\n.mst-stat-v{font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}\n.mst-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);word-break:break-all}\n.mst-scroll{max-height:196px;overflow-y:auto}\n.mst-archive-item{box-sizing:border-box;width:100%;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-family:inherit;font-size:12px;line-height:17px;text-align:left;cursor:pointer}\n.mst-archive-item:hover{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-hover,transparent))}\n.mst-archive-item:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:-1px}\n.mst-archive-item[data-current=true]{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-hover,transparent))}\n.mst-archive-name{display:inline-block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;font-weight:600}.mst-archive-row{cursor:pointer}.mst-archive-row:hover td{background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-hover,transparent))}.mst-cell-run{display:inline-block;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom;color:var(--dsw-alias-label-secondary)}\n.mst-archive-time{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}\n.mst-archive-model{flex:0 1 180px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}\n.mst-archive-med{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}\n.mst-confirm{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:0.5px solid var(--dsw-alias-state-error-primary,var(--dsw-alias-border-l4,transparent));border-radius:var(--dsw-radius-md,8px)}\n.mst-detail-head{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}\n.mst-detail-name{margin:0;font-size:15px;line-height:22px;font-weight:600;word-break:break-word}\n.mst-empty{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}\n.mst-env-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px 14px}"

    /**
     * Tiny external store shared by the section and the module-level jump watcher.
     * @param {object} initial - first value.
     * @returns {{ get: Function, set: Function, subscribe: Function }} store.
     */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set: next => {
          const resolved = typeof next === 'function' ? next(value) : next
          if (resolved === null || typeof resolved !== 'object' || Object.is(resolved, value)) return
          value = resolved
          for (const listener of [...listeners]) listener()
        },
        subscribe: listener => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      }
    }

    /**
     * 批次目录 -> 工作区根目录：`<ws>\\.speedtest\\batches\\<batchId>` 取前三段之前的部分。
     * @param {unknown} dir - batch dir from the index entry.
     * @returns {string} workspace root, or '' when the shape does not match.
     */
    function workspaceRootOfDir(dir) {
      if (typeof dir !== 'string' || dir === '') return ''
      const parts = dir.replace(/[\\/]+$/u, '').split(/[\\/]+/u)
      if (parts.length < 4) return ''
      if (parts[parts.length - 3] !== '.speedtest' || parts[parts.length - 2] !== 'batches') return ''
      return parts.slice(0, parts.length - 3).join('\\')
    }

    /** @param {unknown} left - path. @param {unknown} right - path. @returns {boolean} same path ignoring slashes and case. */
    function samePath(left, right) {
      const norm = value => String(value).replace(/\//gu, '\\').replace(/\\+$/u, '').toLowerCase()
      return norm(left) === norm(right)
    }

    /** @param {unknown} value - candidate number. @returns {boolean} true for a finite number. */
    function isNumber(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }

    /** @param {unknown} value - seconds. @returns {string} one decimal or the em dash. */
    function secondsText(value) {
      return isNumber(value) ? value.toFixed(1) : '—'
    }

    /** @param {unknown} value - tokens per second. @returns {string} two decimals or the em dash. */
    function speedText(value) {
      return isNumber(value) ? value.toFixed(2) : '—'
    }

    /** @param {unknown} n - sample size. @returns {string} integer with thousands separators or the em dash. */
    function countText(n) {
      return isNumber(n) ? Math.round(n).toLocaleString('en-US') : '—'
    }

    /** @param {number[]} values - samples. @returns {number | undefined} median. */
    function medianOf(values) {
      if (!Array.isArray(values) || values.length === 0) return undefined
      const sorted = [...values].sort((left, right) => left - right)
      const middle = Math.floor(sorted.length / 2)
      return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
    }

    /** @param {number[]} values - samples. @returns {number | undefined} median absolute deviation. */
    function madOf(values) {
      const median = medianOf(values)
      if (median === undefined) return undefined
      return medianOf(values.map(value => Math.abs(value - median)))
    }

    /** @param {unknown[]} values - samples. @returns {{ n: number, median?: number, min?: number, max?: number, mad?: number }} summary. */
    function statsOfValues(values) {
      const list = Array.isArray(values) ? values.filter(isNumber) : []
      return {
        n: list.length,
        median: medianOf(list),
        min: list.length === 0 ? undefined : Math.min(...list),
        max: list.length === 0 ? undefined : Math.max(...list),
        mad: madOf(list),
      }
    }

    /** @param {unknown} value - statistic. @param {number} digits - decimals. @returns {string} formatted value. */
    function statNumber(value, digits) {
      if (!isNumber(value)) return '—'
      return digits === 0 ? String(Math.round(value)) : value.toFixed(digits)
    }

    /** @param {Array<Record<string, any>>} rounds - round records. @returns {Array<{ key: string, digits: number, values: any }>} statistic rows. */
    function buildStatsRows(rounds) {
      const collect = getter => rounds.map(getter).filter(isNumber)
      const rows = [
        { key: 'result.metric.elapsed', digits: 1, values: statsOfValues(collect(round => round.elapsedSeconds)) },
        { key: 'result.metric.speed', digits: 2, values: statsOfValues(collect(round => round.speedTps)) },
        { key: 'result.metric.request', digits: 1, values: statsOfValues(collect(round => round.modelRequestSeconds)) },
        { key: 'result.metric.toolTime', digits: 1, values: statsOfValues(collect(round => round.toolSeconds)) },
        { key: 'result.metric.stream', digits: 2, values: statsOfValues(collect(round => round.streamSpeedTps)) },
        { key: 'result.metric.tokens', digits: 0, values: statsOfValues(collect(round => round.tokens)) },
        { key: 'result.metric.tools', digits: 0, values: statsOfValues(collect(round => round.toolCount)) },
      ]
      // 老存档没有新字段时整行是空的，直接不显示，避免一排「—」。
      return rows.filter(row => row.values.n > 0)
    }

    /**
     * Read a nested property without throwing on missing levels.
     * @param {unknown} source - root value.
     * @param {string[]} path - keys to walk.
     * @returns {unknown} value or undefined.
     */
    function pick(source, path) {
      let cursor = source
      for (const key of path) {
        if (cursor === null || typeof cursor !== 'object') return undefined
        cursor = cursor[key]
      }
      return cursor
    }

    /**
     * First finite number found under any of the candidate paths.
     * @param {unknown} source - root value.
     * @param {string[][]} paths - candidate key paths.
     * @returns {number | undefined} the number or undefined.
     */
    function pickNumber(source, paths) {
      for (const path of paths) {
        const value = pick(source, path)
        if (isNumber(value)) return value
      }
      return undefined
    }

    /**
     * fetch + JSON + the Host envelope {ok:true,...} / {ok:false,error:{code,message}}.
     * @param {string} url - exact route, query included.
     * @param {object} [options] - extra fetch init.
     * @returns {Promise<any>} parsed body of a successful response.
     */
    async function requestJson(url, options) {
      const init = Object.assign({ cache: 'no-store', credentials: 'same-origin' }, options)
      let response
      try {
        response = await fetch(url, init)
      } catch (cause) {
        const error = new Error(cause && cause.message ? String(cause.message) : 'request failed')
        error.code = 'NETWORK'
        throw error
      }
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      const failure = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error : null
      if (!response.ok || (body && typeof body === 'object' && body.ok === false)) {
        const code = failure && typeof failure.code === 'string' ? failure.code : 'HTTP-' + response.status
        const message = failure && typeof failure.message === 'string' ? failure.message : 'HTTP ' + response.status
        const error = new Error(message)
        error.code = code
        error.status = response.status
        error.details = failure
        throw error
      }
      if (body === null || typeof body !== 'object') {
        const error = new Error('invalid JSON response')
        error.code = 'BAD-RESPONSE'
        throw error
      }
      return body
    }

    /**
     * Build a query string with proper encoding.
     * @param {Record<string, string | number>} params - query parameters.
     * @returns {string} query string including the leading question mark.
     */
    function query(params) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(params)) search.set(key, String(value))
      const text = search.toString()
      return text === '' ? '' : '?' + text
    }

    /** @param {unknown} value - ISO timestamp. @returns {string} local time text or the raw value. */
    function timeText(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      try {
        return date.toLocaleString()
      } catch {
        return value
      }
    }

    /**
     * Display name of one archive row or batch document: stored name first,
     * then the same derivation the Host uses.
     * @param {any} batch - batch.json or index entry.
     * @param {any[]} rows - index rows, used as a fallback source.
     * @param {string} batchId - target batch id.
     * @returns {string} display name.
     */
    function displayName(batch, rows, batchId) {
      const stored = typeof pick(batch, ['name']) === 'string' ? String(pick(batch, ['name'])).trim() : ''
      if (stored !== '') return stored
      const fallback = Array.isArray(rows) ? rows.find(row => pick(row, ['batchId']) === batchId) : undefined
      const rowName = typeof pick(fallback, ['name']) === 'string' ? String(pick(fallback, ['name'])).trim() : ''
      if (rowName !== '') return rowName
      const model = typeof pick(batch, ['env', 'model']) === 'string' ? String(pick(batch, ['env', 'model'])).trim() : ''
      const createdAt = typeof pick(batch, ['createdAt']) === 'string' ? String(pick(batch, ['createdAt'])) : ''
      const matched = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(createdAt)
      if (model !== '' && matched !== null) return model + ' · ' + matched[2] + '-' + matched[3] + ' ' + matched[4] + ':' + matched[5]
      const prefix = typeof batchId === 'string' ? batchId.slice(0, 8) : ''
      return prefix === '' ? '—' : '批次 ' + prefix
    }

    /**
     * Whether a plugins.detail.section subject is this plugin's page.
     * @param {any} subject - slot owner props subject.
     * @returns {boolean} true for our bundle or our row page.
     */
    function isOwnSubject(subject) {
      const name = pick(subject, ['pkg', 'name'])
      if (typeof name !== 'string' || name !== OWN_PACKAGE) return false
      return subject.kind === 'bundle' || subject.kind === 'row'
    }

    /** Client-side name rule mirroring the Host (1–80 chars, no control characters). */
    function nameIsValid(value) {
      if (typeof value !== 'string') return false
      const name = value.trim()
      if (name === '') return false
      if (/[\u0000-\u001F\u007F]/u.test(name)) return false
      return [...name].length <= 80
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTS), 'model-speedtest: dictionaries')
        const t = ctx.locale.bind(NS)

        /** Section state that must survive navigating away and back. */
        const store = createStore({ view: 'list', selectedBatchId: '', workspaceId: '' })

        /**
         * Turn a thrown request error into one readable line.
         * @param {any} error - error thrown by requestJson.
         * @returns {string} display text.
         */
        const describeError = error => {
          const code = error && typeof error.code === 'string' ? error.code : ''
          if (
            (error && (error.status === 401 || error.status === 403)) ||
            code === 'UNAUTHORIZED' ||
            code === 'FORBIDDEN' ||
            code === 'AUTH'
          ) {
            return t('error.auth')
          }
          if (code === 'NETWORK') {
            const detail = error && typeof error.message === 'string' ? error.message : ''
            return detail === '' ? t('error.network') : t('error.network') + ' · ' + detail
          }
          const message = error && typeof error.message === 'string' && error.message !== '' ? error.message : t('error.unknown')
          return code !== '' ? code + ' · ' + message : message
        }

        /**
         * Status text of one batch or round status string.
         * @param {unknown} status - status from CONTRACT §5.1.
         * @returns {string} localized text.
         */
        const statusText = status => {
          if (typeof status !== 'string' || status === '') return t('status.unknown')
          const key = BATCH_STATUS_KEYS[status] || ROUND_STATUS_KEYS[status]
          return key === undefined ? status : t(key)
        }

        /**
         * The Workspace service is optional: the section still renders (and explains
         * itself) when it is absent.
         * @returns {any} the uiWorkspace service or undefined.
         */
        const workspaceService = () => {
          const service = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
          return service === undefined || service === null ? undefined : service
        }

        /** Pending auto-jump: armed when the section opens a launcher conversation. */
        const jump = { armedAt: 0 }

        /**
         * Jump to the first round's session once the launched batch appears.
         * Runs at module scope so it survives navigating away from the plugin page.
         * @returns {Promise<void>} completion.
         */
        const watchJump = async () => {
          if (jump.armedAt === 0) return
          if (Date.now() - jump.armedAt > JUMP_WINDOW_MS) {
            jump.armedAt = 0
            return
          }
          const service = workspaceService()
          if (service === undefined || typeof service.openSession !== 'function') return
          let rows
          try {
            const data = await requestJson(ROUTES.index + query({ limit: 5 }))
            rows = Array.isArray(data.batches) ? data.batches : []
          } catch {
            return
          }
          const fresh = rows.find(row => {
            const createdAt = Date.parse(String(pick(row, ['createdAt']) || ''))
            return Number.isFinite(createdAt) && createdAt >= jump.armedAt - JUMP_SLACK_MS
          })
          if (fresh === undefined) return
          let doc
          try {
            doc = await requestJson(ROUTES.batch + query({ id: fresh.batchId }))
          } catch {
            return
          }
          const rounds = pick(doc, ['batch', 'rounds'])
          const first = Array.isArray(rounds)
            ? rounds.find(round => typeof pick(round, ['sessionId']) === 'string' && pick(round, ['sessionId']) !== '')
            : undefined
          if (first === undefined) return
          jump.armedAt = 0
          try {
            service.openSession(pick(first, ['sessionId']))
          } catch (error) {
            console.error('[model-speedtest] open first round failed', error)
          }
        }

        // Module-level watcher: one lightweight poll while a launch is pending.
        ctx.effect(() => {
          const timer = window.setInterval(() => {
            void watchJump()
          }, JUMP_POLL_MS)
          return () => window.clearInterval(timer)
        }, 'model-speedtest: round-1 jump watcher')

        /**
         * Minimal error boundary: a render throw must not take the plugin page down.
         */
        class SectionBoundary extends React.Component {
          /** @param {object} props - fallback text and children. */
          constructor(props) {
            super(props)
            this.state = { failed: false }
          }

          /** @returns {{ failed: boolean }} state that switches to the fallback. */
          static getDerivedStateFromError() {
            return { failed: true }
          }

          /** @param {any} error - thrown value. @param {any} info - React error info. */
          componentDidCatch(error, info) {
            console.error('[model-speedtest] section crashed', error, info)
          }

          /** @returns {any} children or the fallback line. */
          render() {
            if (this.state.failed) {
              return h('div', { className: 'mst-root' }, h('p', { className: 'mst-error', role: 'alert' }, this.props.fallback))
            }
            return this.props.children
          }
        }

        /**
         * Slot entry: renders nothing on pages that are not this plugin's.
         * @param {{ subject?: any }} props - plugins detail owner props.
         * @returns {any} the section or null.
         */
        function SpeedtestSection(props) {
          const subject = props && props.subject
          if (!isOwnSubject(subject)) return null
          return h(SectionBoundary, { fallback: t('error.crash') }, h(SectionBody, { key: 'body' }))
        }

        /**
         * The whole section: start form, active batch progress, archive list, archive detail.
         * @returns {any} the section tree.
         */
        function SectionBody() {
          const state = useSyncExternalStore(store.subscribe, store.get, store.get)
          const view = state.view === 'detail' && state.selectedBatchId !== '' ? 'detail' : 'list'
          const selectedBatchId = view === 'detail' ? state.selectedBatchId : ''
          const workspaceId = typeof state.workspaceId === 'string' ? state.workspaceId : ''

          const [status, setStatus] = useState(null)
          const [rows, setRows] = useState([])
          const [workspaces, setWorkspaces] = useState([])
          const [workspaceError, setWorkspaceError] = useState('')
          const [listLoading, setListLoading] = useState(true)
          const [listError, setListError] = useState('')
          const [roundsText, setRoundsText] = useState('3')
          const [starting, setStarting] = useState(false)
          const [cancelling, setCancelling] = useState(false)
          const [notice, setNotice] = useState('')
          const [error, setError] = useState(null)
          const [batchDoc, setBatchDoc] = useState(null)
          const [batchLive, setBatchLive] = useState(null)
          const [batchError, setBatchError] = useState('')
          const [batchMissing, setBatchMissing] = useState(false)
          const [renaming, setRenaming] = useState(false)
          const [renameText, setRenameText] = useState('')
          const [renameSaving, setRenameSaving] = useState(false)
          const [renameError, setRenameError] = useState('')
          const [confirmDelete, setConfirmDelete] = useState(false)
          const [deleting, setDeleting] = useState(false)
          const [deleteError, setDeleteError] = useState('')
          const [copied, setCopied] = useState('')
          const initializedRef = useRef(false)

          const maxRounds = Math.max(
            MIN_ROUNDS,
            Math.round(isNumber(pick(status, ['defaults', 'maxRounds'])) ? pick(status, ['defaults', 'maxRounds']) : DEFAULT_MAX_ROUNDS),
          )
          const defaultRounds = isNumber(pick(status, ['defaults', 'rounds'])) ? Math.round(pick(status, ['defaults', 'rounds'])) : 3
          const timeoutMinutes = isNumber(pick(status, ['defaults', 'runTimeoutMinutes']))
            ? Math.round(pick(status, ['defaults', 'runTimeoutMinutes']))
            : 10
          const activeBatch = pick(status, ['activeBatch'])
          const activeBatchId = typeof pick(activeBatch, ['batchId']) === 'string' ? pick(activeBatch, ['batchId']) : ''
          const active = activeBatchId !== ''

          /** Reload the archive list. */
          const loadList = useCallback(async () => {
            setListLoading(true)
            try {
              const data = await requestJson(ROUTES.index + query({ limit: HISTORY_LIMIT }))
              setRows(Array.isArray(data.batches) ? data.batches.filter(row => row !== null && typeof row === 'object') : [])
              setListError('')
            } catch (cause) {
              setRows([])
              setListError(describeError(cause))
            } finally {
              setListLoading(false)
            }
          }, [])

          useEffect(() => {
            void loadList()
          }, [loadList])

          // 工作区列表：显式指定工作区，批次产物才会落在它下面（否则 DSH 会落到"最近的工作区"）。
          useEffect(() => {
            let cancelled = false
            const load = async () => {
              try {
                const data = await requestJson(ROUTES.workspaces)
                if (cancelled) return
                const list = Array.isArray(data.workspaces)
                  ? data.workspaces.filter(
                      item => item !== null && typeof item === 'object' && typeof item.workspaceId === 'string' && item.workspaceId !== '',
                    )
                  : []
                setWorkspaces(list)
                setWorkspaceError('')
              } catch (cause) {
                if (cancelled) return
                setWorkspaces([])
                setWorkspaceError(describeError(cause))
              }
            }
            void load()
            return () => {
              cancelled = true
            }
          }, [])

          // 默认工作区：上次选的 → 最近一个存档所在的工作区 → 列表第一个。
          useEffect(() => {
            if (workspaces.length === 0) return
            if (workspaces.some(item => item.workspaceId === workspaceId)) return
            const recentRoot = workspaceRootOfDir(pick(rows[0], ['dir']))
            const matched = recentRoot === '' ? undefined : workspaces.find(item => samePath(item.path, recentRoot))
            const chosen = matched === undefined ? workspaces[0] : matched
            store.set(current => ({ ...current, workspaceId: chosen.workspaceId }))
          }, [workspaces, rows, workspaceId])

          // Progress card source: poll the lightweight status route while mounted.
          useEffect(() => {
            let cancelled = false
            let timer = 0
            const tick = async () => {
              try {
                const data = await requestJson(ROUTES.status)
                if (cancelled) return
                setStatus(data)
                if (initializedRef.current === false) {
                  initializedRef.current = true
                  const rounds = Math.round(isNumber(pick(data, ['defaults', 'rounds'])) ? pick(data, ['defaults', 'rounds']) : 3)
                  const max = Math.max(MIN_ROUNDS, Math.round(isNumber(pick(data, ['defaults', 'maxRounds'])) ? pick(data, ['defaults', 'maxRounds']) : DEFAULT_MAX_ROUNDS))
                  setRoundsText(String(Math.min(Math.max(rounds, MIN_ROUNDS), max)))
                }
              } catch {
                // The progress card is best-effort; list/detail requests report their own errors.
              }
              if (!cancelled) timer = window.setTimeout(tick, POLL_MS)
            }
            void tick()
            return () => {
              cancelled = true
              if (timer !== 0) window.clearTimeout(timer)
            }
          }, [])

          // Detail view: load the selected archive and keep polling while it runs.
          useEffect(() => {
            if (selectedBatchId === '') return undefined
            let cancelled = false
            let timer = 0
            const step = async () => {
              timer = 0
              try {
                const data = await requestJson(ROUTES.batch + query({ id: selectedBatchId }))
                if (cancelled) return
                setBatchDoc(data && typeof data.batch === 'object' && data.batch !== null ? data.batch : null)
                setBatchLive(data && typeof data.live === 'object' && data.live !== null ? data.live : null)
                setBatchError('')
                setBatchMissing(false)
                const status2 = pick(data, ['live', 'status']) || pick(data, ['batch', 'status']) || ''
                if (BATCH_ACTIVE.includes(status2)) timer = window.setTimeout(step, POLL_MS)
                else void loadList()
              } catch (cause) {
                if (cancelled) return
                setBatchDoc(null)
                setBatchLive(null)
                setBatchMissing(cause && cause.code === 'BATCH-NOT-FOUND')
                setBatchError(describeError(cause))
              }
            }
            void step()
            return () => {
              cancelled = true
              if (timer !== 0) window.clearTimeout(timer)
            }
          }, [selectedBatchId, loadList])

          const openDetail = id => {
            if (typeof id !== 'string' || id === '') return
            setNotice('')
            setError(null)
            setBatchError('')
            setBatchDoc(null)
            setRenaming(false)
            setConfirmDelete(false)
            setRenameError('')
            setDeleteError('')
            store.set({ view: 'detail', selectedBatchId: id })
          }

          const backToList = () => {
            setRenaming(false)
            setConfirmDelete(false)
            setRenameError('')
            setDeleteError('')
            store.set({ view: 'list', selectedBatchId: '' })
            void loadList()
          }

          const start = () => {
            if (starting) return
            const parsed = Number(roundsText)
            if (!Number.isInteger(parsed) || parsed < MIN_ROUNDS || parsed > maxRounds) {
              setError({ code: 'BAD-ROUNDS', text: t('error.rounds', { min: MIN_ROUNDS, max: maxRounds }) })
              return
            }
            const service = workspaceService()
            if (service === undefined || typeof service.startSession !== 'function') {
              setError({ code: 'NO-WORKSPACE', text: t('error.noWorkspace') })
              return
            }
            if (workspaceId === '') {
              setError({ code: 'NO-WORKSPACE', text: t('error.pickWorkspace') })
              return
            }
            setStarting(true)
            setError(null)
            setNotice('')
            try {
              // Prefill the composer draft only: the user picks model/preset, then sends.
              service.startSession(workspaceId, { prompt: '/speedtest ' + parsed, whenDraftExists: 'append' })
              setNotice(t('notice.started'))
              jump.armedAt = Date.now()
            } catch (cause) {
              setError({ code: 'START-FAILED', text: describeError(cause) })
            } finally {
              setStarting(false)
            }
          }

          const cancelActive = async () => {
            if (activeBatchId === '' || cancelling) return
            setCancelling(true)
            setError(null)
            try {
              await requestJson(ROUTES.cancel, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ batchId: activeBatchId }),
              })
              setNotice(t('notice.cancelled'))
              void loadList()
            } catch (cause) {
              setError({ code: cause && cause.code ? String(cause.code) : '', text: describeError(cause) })
            } finally {
              setCancelling(false)
            }
          }

          const beginRename = () => {
            setRenameText(displayName(batchDoc, rows, selectedBatchId))
            setRenameError('')
            setRenaming(true)
          }

          const saveRename = async () => {
            if (renameSaving || batchDoc === null) return
            if (!nameIsValid(renameText)) {
              setRenameError(t('error.name'))
              return
            }
            setRenameSaving(true)
            setRenameError('')
            try {
              const data = await requestJson(ROUTES.rename, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ batchId: selectedBatchId, name: renameText }),
              })
              const name = typeof data.name === 'string' ? data.name : renameText.trim()
              setBatchDoc(current => (current === null ? current : Object.assign({}, current, { name })))
              setRenaming(false)
              setNotice(t('notice.renamed', { name }))
              void loadList()
            } catch (cause) {
              setRenameError(describeError(cause))
            } finally {
              setRenameSaving(false)
            }
          }

          const removeArchive = async () => {
            if (deleting || selectedBatchId === '') return
            setDeleting(true)
            setDeleteError('')
            try {
              const data = await requestJson(ROUTES.remove, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ batchId: selectedBatchId, confirm: true }),
              })
              const removed = data.filesRemoved === false
              setConfirmDelete(false)
              setNotice(removed ? t('notice.removed') : t('notice.deleted', { batchId: selectedBatchId }))
              store.set({ view: 'list', selectedBatchId: '' })
              void loadList()
            } catch (cause) {
              const code = cause && typeof cause.code === 'string' ? cause.code : ''
              setDeleteError(code === 'BATCH-ACTIVE' ? t('error.deleteActive') : describeError(cause))
            } finally {
              setDeleting(false)
            }
          }

          const copyText = async (key, text) => {
            try {
              if (typeof navigator === 'undefined' || navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function') {
                setError({ code: 'CLIPBOARD', text: t('error.clipboard') })
                return
              }
              await navigator.clipboard.writeText(String(text))
              setCopied(key)
              window.setTimeout(() => setCopied(''), 1500)
            } catch {
              setError({ code: 'CLIPBOARD', text: t('error.clipboard') })
            }
          }

          const noticeRow = notice === '' ? null : h('p', { className: 'mst-notice', role: 'status', style: { margin: 0 } }, notice)
          const errorRow =
            error === null
              ? null
              : h('p', { className: 'mst-error', role: 'alert', style: { margin: 0 } }, t('error.title') + ' · ' + error.text)

          const roundsInvalid = (() => {
            const parsed = Number(roundsText)
            return roundsText !== '' && (!Number.isInteger(parsed) || parsed < MIN_ROUNDS || parsed > maxRounds)
          })()

          const workspaceOptions = workspaces.map(item =>
            h('option', { key: item.workspaceId, value: item.workspaceId }, item.title + ' · ' + item.path),
          )
          const startCard = h(
            'section',
            { className: 'mst-card', key: 'start' },
            h('h3', { className: 'mst-card-title' }, t('form.title')),
            h(
              'div',
              { className: 'mst-row' },
              h('label', { className: 'mst-label', htmlFor: 'mst-workspace' }, t('form.workspace')),
              workspaces.length === 0
                ? h('span', { className: 'mst-muted' }, workspaceError === '' ? t('form.workspaceLoading') : workspaceError)
                : h(
                    'select',
                    {
                      id: 'mst-workspace',
                      className: 'mst-select',
                      value: workspaceId,
                      onChange: event => store.set(current => ({ ...current, workspaceId: event.target.value })),
                    },
                    workspaceId === '' ? h('option', { value: '' }, t('form.workspacePick')) : null,
                    workspaceOptions,
                  ),
            ),
            h(
              'div',
              { className: 'mst-row' },
              h('label', { className: 'mst-label', htmlFor: 'mst-rounds' }, t('form.rounds')),
              h('input', {
                id: 'mst-rounds',
                className: 'mst-input mst-num',
                type: 'number',
                min: MIN_ROUNDS,
                max: maxRounds,
                step: 1,
                value: roundsText,
                'data-invalid': roundsInvalid ? 'true' : 'false',
                onChange: event => setRoundsText(event.target.value),
              }),
              h('span', { className: 'mst-muted' }, t('form.roundsHint', { min: MIN_ROUNDS, max: maxRounds, defaults: defaultRounds })),
            ),
            h(
              'div',
              { className: 'mst-row' },
              h(
                'button',
                { type: 'button', className: 'mst-btn mst-btn-primary', onClick: start, disabled: starting || active },
                starting ? t('form.starting') : t('form.start', { count: Number(roundsText) || defaultRounds }),
              ),
              h('span', { className: 'mst-muted' }, t('form.meta', { minutes: timeoutMinutes })),
            ),
            h('p', { className: 'mst-muted', style: { margin: 0 } }, t('form.note', { count: Number(roundsText) || defaultRounds })),
          )

          const progressCard = active
            ? h(
                'section',
                { className: 'mst-card', key: 'progress' },
                h(
                  'div',
                  { className: 'mst-card-head' },
                  h('h3', { className: 'mst-card-title' }, t('progress.title')),
                  h('span', { className: 'mst-badge', 'data-status': pick(activeBatch, ['status']) }, statusText(pick(activeBatch, ['status']))),
                  h('span', { className: 'mst-muted' }, t('progress.round', { current: countText(pick(activeBatch, ['currentRound'])), total: countText(pick(activeBatch, ['rounds'])) })),
                  h('span', { style: { flex: '1 1 auto' } }),
                  h(
                    'button',
                    { type: 'button', className: 'mst-btn mst-btn-danger mst-btn-small', onClick: cancelActive, disabled: cancelling },
                    cancelling ? t('progress.cancelling') : t('progress.cancel'),
                  ),
                ),
                h('p', { className: 'mst-muted', style: { margin: 0 } }, t('progress.cancelHint')),
              )
            : null

          const archiveList = h(
            'section',
            { className: 'mst-card', key: 'list' },
            h(
              'div',
              { className: 'mst-card-head' },
              h('h3', { className: 'mst-card-title' }, t('list.title')),
              h('span', { style: { flex: '1 1 auto' } }),
              h('span', { className: 'mst-muted', title: t('list.buildHint') }, 'v' + CLIENT_VERSION),
              h('button', { type: 'button', className: 'mst-btn mst-btn-small', onClick: () => void loadList(), disabled: listLoading }, listLoading ? t('loading') : t('refresh')),
            ),
            listError === '' ? null : h('p', { className: 'mst-error', role: 'alert', style: { margin: 0 } }, listError),
            rows.length === 0
              ? h('p', { className: 'mst-empty', style: { margin: 0 } }, listLoading ? t('list.loading') : t('list.empty'))
              : h(
                  'div',
                  { className: 'mst-table-wrap' },
                  h(
                    'table',
                    { className: 'mst-table mst-archive-table' },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', null, t('list.col.name')),
                        h('th', null, t('list.col.status')),
                        h('th', { className: 'mst-num' }, t('list.col.rounds')),
                        h('th', { className: 'mst-num' }, t('list.col.elapsed')),
                        h('th', { className: 'mst-num' }, t('list.col.speed')),
                        h('th', null, t('list.col.created')),
                        h('th', null, t('list.col.model')),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      rows.map((row, index) => {
                        const id = typeof row.batchId === 'string' ? row.batchId : ''
                        const rowStatus = typeof row.status === 'string' ? row.status : ''
                        const medians = row.medians !== null && typeof row.medians === 'object' ? row.medians : null
                        const rowName = displayName(row, rows, id)
                        return h(
                          'tr',
                          {
                            key: 'archive-' + (id === '' ? index : id),
                            className: 'mst-archive-row',
                            'data-current': id !== '' && id === activeBatchId ? 'true' : 'false',
                            title: typeof pick(row, ['dir']) === 'string' ? pick(row, ['dir']) : id,
                            tabIndex: 0,
                            onClick: () => openDetail(id),
                            onKeyDown: event => {
                              if (event.key === 'Enter') openDetail(id)
                            },
                          },
                          h('td', null, h('span', { className: 'mst-archive-name', title: rowName }, rowName)),
                          h('td', null, h('span', { className: 'mst-badge', 'data-status': rowStatus }, statusText(rowStatus))),
                          h('td', { className: 'mst-num' }, t('list.rounds', { rounds: countText(row.rounds), passed: countText(row.passed) })),
                          h('td', { className: 'mst-num' }, t('unit.seconds', { value: secondsText(medians === null ? undefined : medians.elapsedSeconds) })),
                          h('td', { className: 'mst-num' }, t('unit.tps', { value: speedText(medians === null ? undefined : medians.speedTps) })),
                          h('td', { className: 'mst-archive-time' }, timeText(row.createdAt)),
                          h('td', { className: 'mst-archive-model' }, typeof pick(row, ['env', 'model']) === 'string' ? pick(row, ['env', 'model']) : ''),
                        )
                      }),
                    ),
                  ),
                ),
          )

          const detailStatus = typeof pick(batchLive, ['status']) === 'string'
            ? pick(batchLive, ['status'])
            : typeof pick(batchDoc, ['status']) === 'string'
              ? pick(batchDoc, ['status'])
              : ''
          const detailActive = BATCH_ACTIVE.includes(detailStatus)
          const rounds = batchDoc && Array.isArray(batchDoc.rounds) ? batchDoc.rounds.filter(item => item !== null && typeof item === 'object') : []
          const summary = batchDoc && typeof batchDoc.summary === 'object' && batchDoc.summary !== null ? batchDoc.summary : null
          const statBlock = (() => {
            const block = pick(batchDoc, ['summary', 'stats', 'elapsedSeconds'])
            if (block !== null && typeof block === 'object') return block
            const legacy = pick(batchDoc, ['medians', 'elapsedSeconds'])
            return isNumber(legacy) ? { median: legacy } : null
          })()
          const environmentMismatch = pick(batchDoc, ['summary', 'environmentMismatch']) === true || pick(batchDoc, ['environmentMismatch']) === true
          const failedRounds = rounds.filter(item => item.status !== 'passed' && item.status !== 'queued' && item.status !== 'running')
          const hasTokenData = rounds.some(item => pickNumber(item, [['tokens'], ['totalTokens'], ['outputTokens'], ['metrics', 'totalTokens'], ['metrics', 'outputTokens'], ['metrics', 'tokens']]) !== undefined)
          const hasToolData = rounds.some(item => pickNumber(item, [['tools'], ['toolCalls'], ['toolCount'], ['metrics', 'toolCalls'], ['metrics', 'toolCount']]) !== undefined)
          const hasStreamData = rounds.some(item => isNumber(item.streamSpeedTps))
          const cacheTextOf = round => {
            const state = typeof round.cacheHit === 'string' ? round.cacheHit : ''
            if (state === 'hit') {
              return isNumber(round.cacheReadTokens)
                ? t('result.cacheHit') + ' · ' + countText(round.cacheReadTokens)
                : t('result.cacheHit')
            }
            if (state === 'miss') return t('result.cacheMiss')
            return t('result.cacheUnknown')
          }
          const taskTextOf = round => {
            const own = typeof round.taskVersion === 'string' ? round.taskVersion : ''
            const shared = typeof pick(batchDoc, ['skill', 'taskVersion']) === 'string' ? pick(batchDoc, ['skill', 'taskVersion']) : ''
            const version = own !== '' ? own : shared
            return version === '' ? t('common.dash') : version
          }
          const taskTitleOf = round => {
            const parts = []
            if (typeof round.runId === 'string' && round.runId !== '') parts.push('run ' + round.runId)
            if (typeof round.sessionId === 'string' && round.sessionId !== '') parts.push(round.sessionId)
            return parts.join('\n')
          }
          const batchEnv = batchDoc && typeof batchDoc.env === 'object' && batchDoc.env !== null ? batchDoc.env : null
          const batchDir = batchDoc && typeof batchDoc.batchDir === 'string' ? batchDoc.batchDir : ''
          const batchNotes = batchDoc && Array.isArray(batchDoc.notes) ? batchDoc.notes.filter(item => typeof item === 'string' && item !== '').slice(0, 5) : []
          const detailTitle = displayName(batchDoc, rows, selectedBatchId)

          const nameRow = renaming
            ? h(
                'div',
                { className: 'mst-row', key: 'rename' },
                h('input', {
                  className: 'mst-input mst-grow',
                  type: 'text',
                  value: renameText,
                  maxLength: 80,
                  placeholder: t('detail.renamePlaceholder'),
                  autoFocus: true,
                  onChange: event => setRenameText(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Enter') void saveRename()
                    if (event.key === 'Escape') setRenaming(false)
                  },
                }),
                h('button', { type: 'button', className: 'mst-btn mst-btn-small mst-btn-primary', onClick: () => void saveRename(), disabled: renameSaving }, renameSaving ? t('loading') : t('detail.renameSave')),
                h('button', { type: 'button', className: 'mst-btn mst-btn-small', onClick: () => setRenaming(false), disabled: renameSaving }, t('detail.renameCancel')),
                renameError === '' ? null : h('span', { className: 'mst-error' }, renameError),
              )
            : h(
                'div',
                { className: 'mst-row', key: 'name' },
                h('h3', { className: 'mst-detail-name' }, detailTitle),
                h('button', { type: 'button', className: 'mst-btn mst-btn-small', onClick: beginRename }, t('detail.rename')),
              )

          const detailEnvFields = [
            ['env.provider', pick(batchEnv, ['provider'])],
            ['env.model', pick(batchEnv, ['model'])],
            ['env.reasoning', pick(batchEnv, ['reasoningEffort'])],
            ['env.agentPreset', pick(batchEnv, ['agentPreset'])],
            ['env.permissionPreset', pick(batchEnv, ['permissionPreset'])],
            ['detail.skill', pick(batchDoc, ['skill', 'taskVersion'])],
          ]

          const detailSections = []

          if (batchDoc !== null) {
            detailSections.push(
              h(
                'div',
                { className: 'mst-card', key: 'env' },
                h('h3', { className: 'mst-card-title' }, t('detail.env')),
                h(
                  'div',
                  { className: 'mst-env-grid' },
                  detailEnvFields.map(([key, value], index) =>
                    h(
                      'div',
                      { className: 'mst-kv', key: 'env-' + index },
                      h('span', { className: 'mst-k' }, t(key)),
                      h('span', { className: 'mst-v', title: typeof value === 'string' ? value : '' }, typeof value === 'string' && value !== '' ? value : t('common.dash')),
                    ),
                  ),
                ),
                h('p', { className: 'mst-muted', style: { margin: 0 } }, t('detail.createdAt') + ' · ' + timeText(pick(batchDoc, ['createdAt']))),
              ),
            )

            const medianIsMeaningless = statBlock === null || !isNumber(statBlock.median) || (isNumber(statBlock.n) && statBlock.n < 2)

            const roundsTable = rounds.length === 0
              ? h('p', { className: 'mst-muted', style: { margin: 0 } }, detailActive ? t('result.pending') : t('result.empty'))
              : h(
                  'div',
                  { className: 'mst-table-wrap' },
                  h(
                    'table',
                    { className: 'mst-table' },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', { className: 'mst-num' }, t('result.round')),
                        h('th', null, t('result.outcome')),
                        h('th', null, t('result.cache')),
                        h('th', null, t('result.task')),
                        h('th', { className: 'mst-num' }, t('result.elapsed')),
                        h('th', { className: 'mst-num' }, t('result.speed')),
                        hasStreamData ? h('th', { className: 'mst-num', title: t('result.streamHint') }, t('result.stream')) : null,
                        hasTokenData ? h('th', { className: 'mst-num' }, t('result.tokens')) : null,
                        hasToolData ? h('th', { className: 'mst-num' }, t('result.tools')) : null,
                        h('th', null, t('result.error')),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      rounds.map((round, index) => {
                        const tokenValue = pickNumber(round, [['tokens'], ['totalTokens'], ['outputTokens'], ['metrics', 'totalTokens'], ['metrics', 'outputTokens'], ['metrics', 'tokens']])
                        const toolValue = pickNumber(round, [['tools'], ['toolCalls'], ['toolCount'], ['metrics', 'toolCalls'], ['metrics', 'toolCount']])
                        const status2 = typeof round.status === 'string' ? round.status : ''
                        const errorMessage = typeof round.error === 'string' ? round.error : ''
                        return h(
                          'tr',
                          { key: 'round-row-' + (isNumber(round.index) ? round.index : index) },
                          h('td', { className: 'mst-num' }, isNumber(round.index) ? String(round.index) : String(index + 1)),
                          h('td', null, h('span', { className: 'mst-badge', 'data-status': status2 }, statusText(status2))),
                          h('td', null, cacheTextOf(round)),
                          h('td', null, h('span', { className: 'mst-cell-run', title: taskTitleOf(round) }, taskTextOf(round))),
                          h('td', { className: 'mst-num' }, t('unit.seconds', { value: secondsText(round.elapsedSeconds) })),
                          h('td', { className: 'mst-num' }, t('unit.tps', { value: speedText(round.speedTps) })),
                          hasStreamData ? h('td', { className: 'mst-num' }, t('unit.tps', { value: speedText(round.streamSpeedTps) })) : null,
                          hasTokenData ? h('td', { className: 'mst-num' }, countText(tokenValue)) : null,
                          hasToolData ? h('td', { className: 'mst-num' }, countText(toolValue)) : null,
                          h('td', { className: 'mst-code', title: errorMessage }, errorMessage === '' ? t('common.dash') : errorMessage),
                        )
                      }),
                    ),
                  ),
                )

            detailSections.push(
              h(
                'div',
                { className: 'mst-card', key: 'result' },
                h(
                  'div',
                  { className: 'mst-card-head' },
                  h('h3', { className: 'mst-card-title' }, t('result.title')),
                  h('span', { className: 'mst-badge', 'data-status': detailStatus }, statusText(detailStatus)),
                  summary === null
                    ? null
                    : h('span', { className: 'mst-muted' }, t('result.passed', { passed: countText(summary.passed), total: countText(summary.total) })),
                  summary === null
                    ? null
                    : h('span', { className: 'mst-muted' }, t('result.sample', { n: countText(statBlock === null ? undefined : statBlock.n) })),
                ),
                environmentMismatch ? h('p', { className: 'mst-warn', style: { margin: 0 } }, t('result.mismatch')) : null,
                batchNotes.length === 0
                  ? null
                  : h(
                      'ul',
                      { className: 'mst-scroll', style: { margin: 0, paddingLeft: '18px' } },
                      batchNotes.map((note, index) => h('li', { key: 'note-' + index, className: 'mst-warn' }, note)),
                    ),
                medianIsMeaningless && statBlock !== null ? h('p', { className: 'mst-muted', style: { margin: 0 } }, t('result.insufficient')) : null,
                statBlock === null ? null : h('p', { className: 'mst-muted', style: { margin: 0 } }, t('result.statsHint')),
                roundsTable,
                failedRounds.length === 0
                  ? null
                  : h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                      h('p', { className: 'mst-k', style: { margin: 0 } }, t('result.failed')),
                      h(
                        'ul',
                        { className: 'mst-scroll', style: { margin: 0, paddingLeft: '18px' } },
                        failedRounds.map((round, index) =>
                          h(
                            'li',
                            { key: 'failed-' + index, className: 'mst-muted' },
                            h('span', null, t('result.round') + ' ' + (isNumber(round.index) ? round.index : index + 1) + ' · '),
                            h('span', null, statusText(round.status)),
                            typeof round.error === 'string' && round.error !== '' ? h('span', { className: 'mst-code' }, ' · ' + round.error) : null,
                          ),
                        ),
                      ),
                    ),
              ),
            )

            detailSections.push(
              h(
                'div',
                { className: 'mst-card', key: 'stats' },
                h('h3', { className: 'mst-card-title' }, t('result.stats.title')),
                h(
                  'div',
                  { className: 'mst-table-wrap' },
                  h(
                    'table',
                    { className: 'mst-table' },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', null, t('result.stat.metric')),
                        h('th', { className: 'mst-num' }, t('result.stat.n')),
                        h('th', { className: 'mst-num' }, t('result.stat.median')),
                        h('th', { className: 'mst-num' }, t('result.stat.min')),
                        h('th', { className: 'mst-num' }, t('result.stat.max')),
                        h('th', { className: 'mst-num' }, t('result.stat.mad')),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      buildStatsRows(rounds).map(row => {
                        const cell = value =>
                          h('td', { className: 'mst-num' }, row.digits === 0 ? countText(value) : statNumber(value, row.digits))
                        return h(
                          'tr',
                          { key: row.key },
                          h('td', null, t(row.key)),
                          cell(row.values.n),
                          cell(row.values.median),
                          cell(row.values.min),
                          cell(row.values.max),
                          cell(row.values.mad),
                        )
                      }),
                    ),
                  ),
                ),
              ),
            )

            if (batchDir !== '') {
              detailSections.push(
                h(
                  'div',
                  { className: 'mst-card', key: 'dir' },
                  h(
                    'div',
                    { className: 'mst-row' },
                    h('span', { className: 'mst-k' }, t('detail.batchDir')),
                    h('span', { className: 'mst-code', style: { flex: '1 1 220px', minWidth: 0 } }, batchDir),
                    h('button', { type: 'button', className: 'mst-btn mst-btn-small', onClick: () => void copyText('dir', batchDir) }, copied === 'dir' ? t('detail.copied') : t('detail.copy')),
                  ),
                ),
              )
            }
          }

          const missingCard = batchMissing
            ? h(
                'div',
                { className: 'mst-card' },
                h('p', { className: 'mst-warn', style: { margin: 0 } }, t('detail.missing')),
                h(
                  'div',
                  { className: 'mst-row' },
                  h('button', { type: 'button', className: 'mst-btn mst-btn-danger mst-btn-small', onClick: () => setConfirmDelete(true) }, t('detail.removeEntry')),
                  batchError === '' ? null : h('span', { className: 'mst-error' }, batchError),
                ),
              )
            : null

          const detailView = h(
            'div',
            { className: 'mst-root', key: 'detail-view' },
            h(
              'div',
              { className: 'mst-detail-head' },
              h('button', { type: 'button', className: 'mst-btn-link', onClick: backToList }, '← ' + t('detail.back')),
              h('span', { style: { flex: '1 1 auto' } }),
              h('span', { className: 'mst-code' }, selectedBatchId),
            ),
            noticeRow,
            errorRow,
            nameRow,
            h(
              'div',
              { className: 'mst-row' },
              h('span', { className: 'mst-badge', 'data-status': detailStatus }, statusText(detailStatus)),
              detailActive
                ? h('button', { type: 'button', className: 'mst-btn mst-btn-danger mst-btn-small', onClick: cancelActive, disabled: cancelling }, cancelling ? t('progress.cancelling') : t('progress.cancel'))
                : null,
              batchError === '' ? null : h('span', { className: 'mst-error' }, batchError),
            ),
            missingCard,
            batchDoc === null && batchMissing === false ? h('p', { className: 'mst-muted', style: { margin: 0 } }, t('loading')) : null,
            detailSections,
            batchDoc !== null && confirmDelete === false
              ? h('div', { className: 'mst-row' }, h('button', { type: 'button', className: 'mst-btn mst-btn-danger mst-btn-small', onClick: () => setConfirmDelete(true) }, t('detail.delete')))
              : null,
            confirmDelete
              ? h(
                  'div',
                  { className: 'mst-confirm' },
                  h('p', { className: 'mst-warn', style: { margin: 0 } }, t('detail.deleteConfirm')),
                  h(
                    'div',
                    { className: 'mst-row' },
                    h('button', { type: 'button', className: 'mst-btn mst-btn-danger mst-btn-small', onClick: () => void removeArchive(), disabled: deleting }, deleting ? t('loading') : t('detail.deleteYes')),
                    h('button', { type: 'button', className: 'mst-btn mst-btn-small', onClick: () => setConfirmDelete(false), disabled: deleting }, t('detail.deleteNo')),
                    deleteError === '' ? null : h('span', { className: 'mst-error' }, deleteError),
                  ),
                )
              : null,
          )

          const listView = h(
            'div',
            { className: 'mst-root', key: 'list-view' },
            noticeRow,
            errorRow,
            progressCard,
            startCard,
            archiveList,
          )

          return h(React.Fragment, null, h('style', { key: 'css' }, SECTION_CSS), view === 'detail' ? detailView : listView)
        }

        // Register the one visible surface: a section on this plugin's detail page.
        try {
          ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
            name: 'plugins.detail.section',
            id: 'model-speedtest-archives',
            order: 60,
            label: () => t('section.title'),
          }, SpeedtestSection))
        } catch (error) {
          console.error('[model-speedtest] slot registration failed', error)
        }
      },
    }
  },
})
