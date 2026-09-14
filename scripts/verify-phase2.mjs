#!/usr/bin/env node
/**
 * Phase 2 第一段验证：Workflow + Task + Memory。
 *
 *   P2.1 数据结构 + 状态机：workflow / task CRUD + 合法/非法迁移
 *   P2.7 三个 memory Tool 底层 service：write/read/list（真实 shell mkdir + 文件操作）
 *
 * 运行：node scripts/verify-phase2.mjs
 */

import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createWorkspaceService } from '../lib/workspace/workspace-service.js'
import { createBotService } from '../lib/bots/bot-service.js'
import { createWorkflowService } from '../lib/workflows/workflow-service.js'
import { createTaskService } from '../lib/tasks/task-service.js'
import { createMemoryService, MemoryError } from '../lib/memory/memory-service.js'
import { createAiEmployee } from '../lib/core/plugin.js'
import { canTransition, isTerminal, nextStates } from '../lib/core/status-machine.js'
import { TASK_STATUS_LABELS } from '../lib/storage/schemas.js'

// ---------- 通用 mock 与断言 ----------
function memTable() {
  const m = new Map()
  return {
    get(k) { return m.get(k) },
    put(k, v) { m.set(k, v); return Promise.resolve() },
    update(k, fn) { const n = fn(m.get(k)); m.set(k, n); return Promise.resolve(n) },
    delete(k) { return Promise.resolve(m.delete(k)) },
    entries() { return m.entries() },
  }
}
function memStore() {
  return {
    workspace: memTable(), bot: memTable(), bot_template: memTable(),
    workflow: memTable(), task: memTable(),
    close() { return Promise.resolve() },
  }
}
function mockStorageDomain() {
  return { async open(spec) {
    const tables = {}
    for (const t of Object.keys(spec.tables)) tables[t] = memTable()
    return { name: spec.name, table: (n) => tables[n], async close() {} }
  } }
}

// 真实 shell（用 spawnSync 跑命令）；用于 memory 真实写文件测试
function realExec(command) {
  // 用 bash -lc 跑命令；保留 cwd
  const r = spawnSync('bash', ['-lc', command], { encoding: 'utf8' })
  const ok = r.status === 0
  return {
    ok,
    stdout: r.stdout ?? '',
    ...(r.stderr && !ok ? { error: r.stderr } : {}),
  }
}

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ---------- 测试 P2.1 状态机（纯函数） ----------
console.log('=== P2.1 任务状态机 ===\n')

check('S1 状态机: planned → ready 合法', canTransition('planned', 'ready'))
check('S2 状态机: developing → dev_done 合法', canTransition('developing', 'dev_done'))
check('S3 状态机: reviewing → pass 合法', canTransition('reviewing', 'pass'))
check('S4 状态机: reviewing → changes_req 合法', canTransition('reviewing', 'changes_req'))
check('S5 状态机: changes_req → developing 合法', canTransition('changes_req', 'developing'))
check('S6 状态机: pass → done 合法', canTransition('pass', 'done'))
check('S7 状态机: done 是终态', isTerminal('done'))
check('S8 状态机: done 不能转出', nextStates('done').length === 1 && nextStates('done')[0] === 'done')
check('S9 状态机: 任意状态都能进 blocked', nextStates('planned').includes('blocked') && nextStates('developing').includes('blocked'))
check('S10 11 个状态都有中文标签',
  Object.keys(TASK_STATUS_LABELS).length === 11 && TASK_STATUS_LABELS.developing === '开发中')

// ---------- 测试 P2.1 workflow + task 服务 ----------
console.log('\n=== P2.1 workflow + task 服务 ===\n')

const fakeExec = async () => ({ ok: true })
const api = await createAiEmployee({ storageDomain: mockStorageDomain(), execCommand: fakeExec })
const { workflows, tasks, workspaces, bots } = api

// 先建一个项目和样板 Bot，task / workflow 都需要
const ws = await workspaces.createWorkspace({ name: 'P2', rootPath: '/tmp/p2-fake', ownerUserId: 'user-1' })
const advisor = await bots.createBot({
  workspaceId: ws.id, templateId: 'advisor', name: '总顾问', role: '总顾问',
  actor: { kind: 'user', userId: 'user-1' },
})
const programmer = await bots.createBot({
  workspaceId: ws.id, templateId: 'programmer', name: '程序员', role: '程序员',
  actor: { kind: 'user', userId: 'user-1' },
})
const reviewer = await bots.createBot({
  workspaceId: ws.id, templateId: 'reviewer', name: '审核员', role: '审核员',
  actor: { kind: 'user', userId: 'user-1' },
})

// 11) workflow: create + validate
let wf = await workflows.createWorkflow({
  workspaceId: ws.id,
  name: '开发 → 审核 → 汇报',
  steps: [
    { id: 's1', order: 1, workerBotId: programmer.id, nextStepId: 's2', description: '实现功能' },
    { id: 's2', order: 2, workerBotId: reviewer.id, nextStepId: 's3', description: '审核代码' },
    { id: 's3', order: 3, workerBotId: advisor.id, description: '总顾问汇报' },
  ],
})
check('W1 workflow 创建成功', wf.steps.length === 3 && wf.name === '开发 → 审核 → 汇报')
check('W2 workflow 落 storage', workflows.getWorkflow(wf.id) !== undefined)
check('W3 listByWorkspace 含新建 workflow', workflows.listByWorkspace(ws.id).length === 1)

// 12) workflow 步骤 id 重复 → 报错
let dupThrew = false
try {
  await workflows.createWorkflow({
    workspaceId: ws.id, name: 'dup',
    steps: [
      { id: 'a', order: 1 },
      { id: 'a', order: 2 },
    ],
  })
} catch (e) { dupThrew = true }
check('W4 步骤 id 重复拒绝', dupThrew)

// 13) workflow nextStepId 指向不存在步骤 → 报错
let badNextThrew = false
try {
  await workflows.createWorkflow({
    workspaceId: ws.id, name: 'bad-next',
    steps: [{ id: 'a', order: 1, nextStepId: 'ghost' }],
  })
} catch (e) { badNextThrew = true }
check('W5 nextStepId 越界拒绝', badNextThrew)

// 14) getNextStep: s1 → s2
const nextOfS1 = workflows.getNextStep(wf.id, 's1')
check('W6 getNextStep(s1) = s2', nextOfS1?.id === 's2')
// 15) getNextStep: s3 → undefined（末步）
const nextOfS3 = workflows.getNextStep(wf.id, 's3')
check('W7 getNextStep(s3) = undefined（末步）', nextOfS3 === undefined)

// 16) listSteps 按 order 排序
const ordered = workflows.listSteps(wf.id).map((s) => s.id)
check('W8 listSteps 按 order 排序', ordered.join(',') === 's1,s2,s3')

// 17) updateWorkflow
const updated = await workflows.updateWorkflow({ id: wf.id, name: '改名后的工作流' })
check('W9 updateWorkflow 改 name', updated.name === '改名后的工作流')

// 18) deleteWorkflow
await workflows.deleteWorkflow(wf.id)
check('W10 deleteWorkflow 后查不到', workflows.getWorkflow(wf.id) === undefined)

// ---------- Task 服务 ----------
console.log('\n=== P2.1 task 服务 ===\n')

// T1) createTask
const t1 = await tasks.createTask({
  workspaceId: ws.id,
  title: '实现登录功能',
  ownerBotId: programmer.id,
  createdBy: 'user',
  initialStatus: 'ready',
})
check('T1 createTask 成功', t1.title === '实现登录功能' && t1.status === 'ready')
check('T1 task 落 storage', tasks.getTask(t1.id)?.id === t1.id)

// T2) 缺字段拒绝
let tEmptyThrew = false
try {
  await tasks.createTask({ workspaceId: ws.id, title: '', ownerBotId: 'x', createdBy: 'user' })
} catch (e) { tEmptyThrew = true }
check('T2 createTask 空 title 拒绝', tEmptyThrew)

// T3) listByOwnerBot
const t2 = await tasks.createTask({
  workspaceId: ws.id, title: '审核登录', ownerBotId: reviewer.id, createdBy: 'bot',
})
const progTasks = tasks.listByOwnerBot(ws.id, programmer.id)
check('T3 listByOwnerBot 按 owner 过滤', progTasks.length === 1 && progTasks[0].id === t1.id)

// T4) 合法迁移: ready → developing
const moved = await tasks.transitionStatus(t1.id, 'developing')
check('T4 transitionStatus(ready→developing)', moved.status === 'developing')

// T5) 非法迁移: developing → pass（应跳过 review_done）
let illegalThrew = false
try {
  await tasks.transitionStatus(t1.id, 'pass')
} catch (e) {
  illegalThrew = /非法状态迁移/.test(String(e?.message))
}
check('T5 非法迁移 developing→pass 被拒', illegalThrew)

// T6) 合法迁移: developing → dev_done → reviewing → pass → done
await tasks.transitionStatus(t1.id, 'dev_done')
await tasks.transitionStatus(t1.id, 'reviewing')
const passed = await tasks.transitionStatus(t1.id, 'pass')
check('T6 多步迁移到 pass', passed.status === 'pass')
const done = await tasks.transitionStatus(t1.id, 'done')
check('T7 done 自动填 completedAt', done.status === 'done' && typeof done.completedAt === 'string')

// T8) 已 done 不可改字段
let doneEditThrew = false
try {
  await tasks.updateTask({ id: t1.id, title: '改名' })
} catch (e) { doneEditThrew = true }
check('T8 done 任务不可改', doneEditThrew)

// T9) 幂等：相同状态再转不报错
const sameState = await tasks.transitionStatus(t2.id, 'planned') // 初始就是 planned
check('T9 transitionStatus 相同状态幂等', sameState.status === 'planned')

// T10) deleteTask
await tasks.deleteTask(t2.id)
check('T10 deleteTask 后查不到', tasks.getTask(t2.id) === undefined)

// T11) listByWorkflowStep（占位）
const t3 = await tasks.createTask({
  workspaceId: ws.id, title: '被绑定的', ownerBotId: programmer.id, createdBy: 'user',
  workflowId: 'wf_x', workflowStepId: 's1',
})
const bound = tasks.listByWorkflowStep('wf_x', 's1')
check('T11 listByWorkflowStep 找到绑定 task', bound.length === 1 && bound[0].id === t3.id)

// ---------- P2.7 memory 服务 ----------
console.log('\n=== P2.7 memory 服务（真实 shell 写文件）===\n')

// 用真实 workspace service 查 memoryPath；audit 接 api.audit 走持久化
const memSvc = createMemoryService({
  getMemoryPath: (workspaceId) => workspaces.getWorkspace(workspaceId)?.memoryPath,
  execCommand: realExec,
  workspaceExists: (workspaceId) => workspaces.getWorkspace(workspaceId) !== undefined,
  audit: api.audit,
})

// 临时目录用于"跨 workspace 隔离"测试的第二个项目（确保写到自己的 docs/）
const otherRoot = mkdtempSync(join(tmpdir(), 'p2-other-'))
const otherWs = await workspaces.createWorkspace({
  name: '另一个项目', rootPath: otherRoot, ownerUserId: 'user-1',
})

// M1) write
const w = await memSvc.writeMemory({
  workspaceId: ws.id, fileName: 'product.md', content: '# 产品\n\n这是产品设计', actor: 'bot',
})
check('M1 writeMemory 成功', w.fileName === 'product.md' && w.bytes > 0)
check('M1 文件真落到磁盘',
  existsSync(w.path) && readFileSync(w.path, 'utf8') === '# 产品\n\n这是产品设计')

// M2) write 子目录（自动建）
const w2 = await memSvc.writeMemory({
  workspaceId: ws.id, fileName: 'design/api.md', content: '# API', actor: 'bot',
})
check('M2 子目录自动建', existsSync(w2.path))

// M3) read
const r = await memSvc.readMemory({ workspaceId: ws.id, fileName: 'product.md', actor: 'bot' })
check('M3 readMemory 读到内容', r.content.includes('这是产品设计'))

// M4) list
const list = await memSvc.listMemory({ workspaceId: ws.id, actor: 'bot' })
check('M4 listMemory 列到 2 个文件', list.files.length === 2)
check('M4 含子目录文件', list.files.some((f) => f.fileName === 'design/api.md'))

// M5) 拒绝 .. 越界
let pathTravThrew = false
try {
  await memSvc.writeMemory({ workspaceId: ws.id, fileName: '../escape.md', content: 'x', actor: 'bot' })
} catch (e) {
  pathTravThrew = e instanceof MemoryError && e.code === 'PATH_TRAVERSAL'
}
check('M5 .. 越界拒绝', pathTravThrew)

// M6) 拒绝绝对路径
let absThrew = false
try {
  await memSvc.writeMemory({ workspaceId: ws.id, fileName: '/etc/passwd', content: 'x', actor: 'bot' })
} catch (e) {
  absThrew = e instanceof MemoryError && e.code === 'ABSOLUTE_PATH'
}
check('M6 绝对路径拒绝', absThrew)

// M7) 拒绝非 .md 后缀
let notMdThrew = false
try {
  await memSvc.writeMemory({ workspaceId: ws.id, fileName: 'hack.exe', content: 'x', actor: 'bot' })
} catch (e) {
  notMdThrew = e instanceof MemoryError && e.code === 'NOT_MARKDOWN'
}
check('M7 非 Markdown 后缀拒绝', notMdThrew)

// ---------- P2.7.b audit 持久化 ----------
console.log('\n=== P2.7 audit 持久化（V0.2 §22）===\n')

// A1) write 触发审计；按时间倒序查 product.md 那条
let events = await api.audit.listEvents({ workspaceId: ws.id })
const productWrite = events.find((e) => e.action === 'memory.write' && e.resourceId === 'product.md')
check('A1 write 触发审计', productWrite !== undefined)
check('A1 audit actorType=bot / actorId=user（占位）',
  productWrite !== undefined && productWrite.actorType === 'bot' && productWrite.actorId === 'user')
check('A1 audit resourceType=memory_file',
  productWrite !== undefined && productWrite.resourceType === 'memory_file')
check('A1 audit metadata 含 bytes',
  productWrite !== undefined && typeof productWrite.metadata.bytes === 'number' && productWrite.metadata.bytes > 0)
check('A1 audit metadata 含 absolutePath',
  productWrite !== undefined && typeof productWrite.metadata.absolutePath === 'string' && productWrite.metadata.absolutePath.endsWith('product.md'))

// A2) memory.write 累计 2 条（product.md + design/api.md）
events = await api.audit.listEvents({ workspaceId: ws.id, action: 'memory.write' })
check('A2 该项目 memory.write 累计 2 条', events.length === 2)
const fileNames = events.map((e) => e.resourceId).sort()
check('A2 含 product.md 和 design/api.md',
  fileNames.join(',') === 'design/api.md,product.md')

// A3) read 也审计（M3 已读过 1 次，A3 又读 1 次 → 累计 2 条 read）
await memSvc.readMemory({ workspaceId: ws.id, fileName: 'product.md', actor: 'bot' })
events = await api.audit.listEvents({ workspaceId: ws.id })
const readEvents = events.filter((e) => e.action === 'memory.read')
check('A3 read 触发审计（累计 2 条）', readEvents.length === 2)
check('A3 read audit resourceId=product.md', readEvents[0].resourceId === 'product.md')

// A4) list 也审计（M4 已列 1 次，A4 又列 1 次 → 累计 2 条 list）
await memSvc.listMemory({ workspaceId: ws.id, actor: 'bot' })
events = await api.audit.listEvents({ workspaceId: ws.id })
const listEvts = events.filter((e) => e.action === 'memory.list')
check('A4 list 触发审计（累计 2 条）', listEvts.length === 2)
check('A4 list audit metadata.fileCount=2',
  listEvts[0].metadata.fileCount === 2)

// A5) 时间倒序（最新在前）
events = await api.audit.listEvents({ workspaceId: ws.id })
const tsOrder = events.every((e, i) => i === 0 || events[i - 1].timestamp >= e.timestamp)
check('A5 列表按时间倒序', tsOrder)

// A6) 跨 workspace 隔离：在 otherWs 上没有任何事件
const otherEvents = await api.audit.listEvents({ workspaceId: otherWs.id })
check('A6 跨 workspace 隔离（其他项目无事件）', otherEvents.length === 0)

// A7) 跨 workspace 显式拒绝：必须传 workspaceId
let noWsThrew = false
try {
  await api.audit.listEvents({})
} catch (e) {
  noWsThrew = /必须传 workspaceId/.test(String(e?.message))
}
check('A7 listEvents 不传 workspaceId 拒绝', noWsThrew)

// A8) listEvents 支持 since 过滤
const beforeAll = Date.now() - 1 // 1ms 之前
const eventsSince = await api.audit.listEvents({ workspaceId: ws.id, since: new Date(beforeAll).toISOString() })
check('A8 since 过滤（今天之前的也查得到）', eventsSince.length > 0)

const futureSince = await api.audit.listEvents({ workspaceId: ws.id, since: new Date(Date.now() + 60000).toISOString() })
check('A8 since 未来时间过滤（应为空）', futureSince.length === 0)

// A9) limit 默认 50 / 上限 1000
const limited = await api.audit.listEvents({ workspaceId: ws.id, limit: 2 })
check('A9 limit 生效', limited.length === 2)
const huge = await api.audit.listEvents({ workspaceId: ws.id, limit: 999999 })
check('A9 limit 上限 1000', huge.length <= 1000)

// A10) AuditEvent 落 storage（持久化）
events = await api.audit.listEvents({ workspaceId: ws.id })
const auditRow = api.store.audit_event.get(events[0].id)
check('A10 AuditEvent 真的存到 audit_event 表', auditRow !== undefined && auditRow.action === events[0].action)

// 清理临时目录
rmSync(otherRoot, { recursive: true, force: true })

await api.dispose()

console.log(`\n=== 结果：通过 ${pass} / 共 ${pass + fail} ===`)
process.exit(fail === 0 ? 0 : 1)