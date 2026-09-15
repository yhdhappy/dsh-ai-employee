#!/usr/bin/env node
/**
 * Phase 1 第二段验证：HTTP 路由 handler（/ai-employee/api）。
 *
 * 用 mock storageDomain 驱动真装配 + 真路由 handler，构造伪 IncomingMessage
 * 和 ServerResponse 发出 POST 请求，验证三种动作（state / createWorkspace
 * / createBot）和错误处理。
 *
 * 运行：node scripts/verify-route.mjs
 */

import { Readable } from 'node:stream'
import { createWorkspaceService } from '../lib/workspace/workspace-service.js'
import { createBotService } from '../lib/bots/bot-service.js'
import { createAiEmployee } from '../lib/core/plugin.js'
import { makeAiEmployeeHandler } from '../lib/api/route.js'

// ---------- 通用 mock ----------
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
  return { workspace: memTable(), bot: memTable(), bot_template: memTable(), close() { return Promise.resolve() } }
}
function mockStorageDomain() {
  return {
    async open(spec) {
      const tables = {}
      for (const t of Object.keys(spec.tables)) tables[t] = memTable()
      return { name: spec.name, table: (n) => tables[n], async close() {} }
    },
  }
}
const fakeExec = async () => ({ ok: true })

// ---------- 伪 req / res ----------
function mockReq(method, body) {
  const payload = body == null ? '' : JSON.stringify(body)
  const stream = Readable.from([Buffer.from(payload, 'utf8')])
  stream.method = method
  return stream
}
function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v },
    end(payload) {
      if (payload != null) this.body = payload
      return this
    },
  }
  return res
}

async function callHandler(handler, method, body) {
  const req = mockReq(method, body)
  const res = mockRes()
  await handler(req, res)
  const parsed = res.body ? JSON.parse(res.body) : null
  return { status: res.statusCode, body: parsed }
}

// ---------- 断言 ----------
let pass = 0, fail = 0
function check(name, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ---------- 跑起来 ----------
const api = await createAiEmployee({ storageDomain: mockStorageDomain(), execCommand: fakeExec })
const handler = makeAiEmployeeHandler({ api, userId: 'user-1' })

// 1) GET 不接受
let r = await callHandler(handler, 'GET', null)
check('R1 GET 返回 405', r.status === 405 && r.body && r.body.ok === false)

// 2) 缺 action
r = await callHandler(handler, 'POST', {})
check('R2 缺 action 返回 400', r.status === 400 && r.body && r.body.error && r.body.error.includes('action'))

// 3) 未知 action
r = await callHandler(handler, 'POST', { action: 'nope' })
check('R3 未知 action 返回 400', r.status === 400 && r.body && r.body.error && r.body.error.includes('nope'))

// 4) state - 初始无项目
r = await callHandler(handler, 'POST', { action: 'state' })
check('R4 state 初始 hasWorkspace=false', r.status === 200 && r.body && r.body.ok === true && r.body.state && r.body.state.hasWorkspace === false)
check('R4 state 初始 bots=[]', r.body && r.body.state && Array.isArray(r.body.state.bots) && r.body.state.bots.length === 0)

// 5) createWorkspace - 缺字段
r = await callHandler(handler, 'POST', { action: 'createWorkspace' })
check('R5 createWorkspace 缺字段返回 400', r.status === 400 && r.body && r.body.error)

// 6) createWorkspace - 成功
r = await callHandler(handler, 'POST', { action: 'createWorkspace', name: '路由测试', rootPath: '/tmp/route' })
check('R6 createWorkspace 成功', r.status === 200 && r.body && r.body.ok === true && r.body.workspace && r.body.workspace.name === '路由测试')
check('R6 workspace 落 storage', api.workspaces.getWorkspace(r.body.workspace.id) != null)

// 7) state - 有项目无员工
r = await callHandler(handler, 'POST', { action: 'state' })
check('R7 state 已有项目', r.status === 200 && r.body && r.body.state.hasWorkspace === true)
check('R7 state 员工为空', r.body && r.body.state.bots.length === 0)

// 8) createBot - 不传 name（v1 新行为：用样板默认名）
const wsId = (await callHandler(handler, 'POST', { action: 'state' })).body.state.workspace.id
r = await callHandler(handler, 'POST', { action: 'createBot', workspaceId: wsId, templateId: 'advisor' })
check('R8 createBot 不传 name 时用样板默认', r.status === 200 && r.body && r.body.bot && r.body.bot.name === '总顾问' && r.body.bot.role === '总顾问')
check('R8 继承样板 systemPrompt', r.body && r.body.bot && r.body.bot.templateId === 'advisor' && r.body.bot.systemPrompt.length > 0)

// 9) state - 有员工
r = await callHandler(handler, 'POST', { action: 'state' })
check('R9 state 含 1 个员工', r.status === 200 && r.body && r.body.state.bots.length === 1 && r.body.state.bots[0].name === '总顾问')

// 10) createBot - 缺 workspaceId
r = await callHandler(handler, 'POST', { action: 'createBot' })
check('R10 createBot 缺 workspaceId 返回 400', r.status === 400 && r.body && r.body.error && r.body.error.includes('workspaceId'))

// 11) createBot - 不传 name 且样板 id 无效 → 400
r = await callHandler(handler, 'POST', { action: 'createBot', workspaceId: wsId, templateId: 'nonexistent-template' })
check('R11 createBot 样板无效返回 400', r.status === 400 && r.body && r.body.error)

// 12) createBot - 兼容旧前端：传了 name 仍能用
r = await callHandler(handler, 'POST', { action: 'createBot', workspaceId: wsId, templateId: 'reviewer', name: '自定义名', role: '审核员' })
check('R12 createBot 传 name 时按传的来', r.status === 200 && r.body && r.body.bot && r.body.bot.name === '自定义名')

// 13) 错误体格式
r = await callHandler(handler, 'POST', { action: 'createWorkspace', name: '', rootPath: '' })
check('R13 错误体含 ok:false 与 error', r.status === 400 && r.body && r.body.ok === false && typeof r.body.error === 'string')

// ---------- Phase 2 第三段：工作流 + 列表 + UI 审计 ----------
console.log('\n=== R14+ 工作流路由 / 列表 / UI 审计 ===\n')

// 拿两个 bot 供工作流用
const programmer = (await callHandler(handler, 'POST', { action: 'createBot', workspaceId: wsId, templateId: 'programmer' })).body.bot
const reviewer = (await callHandler(handler, 'POST', { action: 'createBot', workspaceId: wsId, templateId: 'reviewer' })).body.bot

// R14 listBots（此前 R8/R12 已各建 1 个，本段再建 2 个 → 共 4）
r = await callHandler(handler, 'POST', { action: 'listBots', workspaceId: wsId })
check('R14 listBots 返回全部员工', r.status === 200 && r.body.ok === true && r.body.bots.length === 4, `实际 ${r.body.bots.length}`)
r = await callHandler(handler, 'POST', { action: 'listBots' })
check('R14 listBots 缺 workspaceId 返回 400', r.status === 400 && r.body.error.includes('workspaceId'))

// R15 createWorkflow - 成功（线性链 s1→s2）
r = await callHandler(handler, 'POST', {
  action: 'createWorkflow', workspaceId: wsId, name: '开发→审核',
  steps: [
    { workerBotId: programmer.id },
    { workerBotId: reviewer.id },
  ],
})
check('R15 createWorkflow 成功', r.status === 200 && r.body.ok === true && r.body.workflow.steps.length === 2)
check('R15 自动补 id/order', r.body.workflow.steps[0].id === 's1' && r.body.workflow.steps[0].order === 1)
check('R15 DTO 字段可用', r.body.workflow.name === '开发→审核' && r.body.workflow.steps[0].workerBotId === programmer.id)
const wfId = r.body.workflow.id

// R16 createWorkflow 校验
r = await callHandler(handler, 'POST', { action: 'createWorkflow', workspaceId: wsId, steps: [{ workerBotId: programmer.id }] })
check('R16 缺 name 返回 400', r.status === 400 && r.body.error.includes('工作流名'))
r = await callHandler(handler, 'POST', { action: 'createWorkflow', workspaceId: wsId, name: 'x', steps: [] })
check('R16 空 steps 返回 400', r.status === 400 && r.body.error.includes('至少要有一个步骤'))
r = await callHandler(handler, 'POST', { action: 'createWorkflow', workspaceId: wsId, name: 'x' })
check('R16 缺 steps 返回 400', r.status === 400 && r.body.error.includes('至少要有一个步骤'))

// R17 nextStepId 越界由 service 层拒绝
r = await callHandler(handler, 'POST', {
  action: 'createWorkflow', workspaceId: wsId, name: 'bad',
  steps: [{ id: 'a', order: 1, workerBotId: programmer.id, nextStepId: 'ghost' }],
})
check('R17 nextStepId 越界被 service 层拒绝（500 + 可读错误）',
  r.status === 500 && r.body.ok === false && /nextStepId/.test(r.body.error))

// R18 等用户决策步骤（无 workerBotId）
r = await callHandler(handler, 'POST', {
  action: 'createWorkflow', workspaceId: wsId, name: '带等待',
  steps: [{ id: 'a', order: 1, workerBotId: programmer.id, nextStepId: 'b' },
          { id: 'b', order: 2, description: '等用户拍板' }],
})
check('R18 无 workerBotId 的步骤允许', r.status === 200 && r.body.workflow.steps[1].workerBotId === null)

// R19 listWorkflows（R15 与 R18 各成功 1 条 → 共 2）
r = await callHandler(handler, 'POST', { action: 'listWorkflows', workspaceId: wsId })
check('R19 listWorkflows 返回 2 条', r.status === 200 && r.body.workflows.length === 2, `实际 ${r.body.workflows.length}`)
r = await callHandler(handler, 'POST', { action: 'listWorkflows' })
check('R19 listWorkflows 缺 workspaceId 返回 400', r.status === 400)

// R20 state 现在带 workflows
r = await callHandler(handler, 'POST', { action: 'state' })
check('R20 state 含 workflows 数组', r.status === 200 && Array.isArray(r.body.state.workflows) && r.body.state.workflows.length === 2)

// R21 UI 操作写审计（via='ui'）
r = await callHandler(handler, 'POST', { action: 'listAuditEvents', workspaceId: wsId, limit: 100 })
const evts = r.body.events
const uiWf = evts.filter((e) => e.action === 'workflow.create' && e.metadata.via === 'ui')
const uiBot = evts.filter((e) => e.action === 'bot.create' && e.metadata.via === 'ui')
const uiWs = evts.filter((e) => e.action === 'workspace.create' && e.metadata.via === 'ui')
check('R21 UI 建工作流记了审计（2 条）', uiWf.length === 2, `实际 ${uiWf.length}`)
check('R21 UI 建员工记了审计（4 条）', uiBot.length === 4, `实际 ${uiBot.length}`)
check('R21 UI 建项目记了审计（1 条）', uiWs.length === 1)
check('R21 审计 actorType=user', uiWf[0].actorType === 'user' && uiWf[0].actorId === 'user-1')
check('R21 工作流审计带 stepIds', Array.isArray(uiWf[0].metadata.stepIds) && uiWf[0].metadata.stepIds.length === 2)

// ---------- task_close：强制收尾停在中间态的任务 ----------
console.log('\n=== R22+ task_close 路由 ===\n')

const mkTask = async (title, initialStatus) =>
  await api.tasks.createTask({
    workspaceId: wsId, title, ownerBotId: programmer.id, createdBy: 'user',
    ...(initialStatus !== undefined ? { initialStatus } : {}),
  })

// R22 强制收尾：planned 不在 done 的合法迁移图里，forceTo 应当绕过
const tA = await mkTask('悬着的任务A', 'planned')
r = await callHandler(handler, 'POST', { action: 'task_close', taskId: tA.id, forceTo: 'done', reason: '任务已废弃' })
check('R22 task_close 成功', r.status === 200 && r.body.ok === true, `status=${r.status} ${r.body.error ?? ''}`)
check('R22 返回 task 契约字段', r.body.task && r.body.task.id === tA.id && r.body.task.status === 'done' && r.body.task.statusZh === '完成' && typeof r.body.task.updatedAt === 'string')
check('R22 绕过迁移图真的落库（planned → done）', api.tasks.getTask(tA.id).status === 'done')
check('R22 done 补了 completedAt', typeof api.tasks.getTask(tA.id).completedAt === 'string')

// R23 幂等：同状态再关一次不报错
r = await callHandler(handler, 'POST', { action: 'task_close', taskId: tA.id, forceTo: 'done' })
check('R23 重复关闭幂等（200 + done）', r.status === 200 && r.body.task.status === 'done')

// R24 参数校验
r = await callHandler(handler, 'POST', { action: 'task_close', forceTo: 'done' })
check('R24 缺 taskId 返回 400', r.status === 400 && r.body.error.includes('taskId'))
r = await callHandler(handler, 'POST', { action: 'task_close', taskId: tA.id, forceTo: 'reviewing' })
check('R24 forceTo 白名单外返回 400', r.status === 400 && r.body.error.includes('forceTo'))
r = await callHandler(handler, 'POST', { action: 'task_close', taskId: 'task_ghost', forceTo: 'done' })
check('R24 任务不存在返回 404', r.status === 404 && r.body.error.includes('不存在'))

// R25 pass / changes_req 也能强制设
const tB = await mkTask('待裁决的任务B', 'wait_owner')
r = await callHandler(handler, 'POST', { action: 'task_close', taskId: tB.id, forceTo: 'pass', reason: '审核通过' })
check('R25 wait_owner → pass 成功', r.status === 200 && r.body.task.status === 'pass' && r.body.task.statusZh === '审核通过')
const tC = await mkTask('被打回的任务C', 'dev_done')
r = await callHandler(handler, 'POST', { action: 'task_close', taskId: tC.id, forceTo: 'changes_req', reason: '需返工' })
check('R25 dev_done → changes_req 成功', r.status === 200 && r.body.task.status === 'changes_req')

// R26 审计：task.close 带 forceTo / reason / fromStatus / toStatus / via
r = await callHandler(handler, 'POST', { action: 'listAuditEvents', workspaceId: wsId, actionFilter: 'task.close', limit: 100 })
const closes = r.body.events
check('R26 记了 task.close 审计（4 条）', closes.length === 4, `实际 ${closes.length}`)
const closeA = closes.find((e) => e.resourceId === tA.id)
check('R26 审计字段完整', closeA !== undefined
  && closeA.metadata.forceTo === 'done'
  && closeA.metadata.reason === '任务已废弃'
  && closeA.metadata.fromStatus === 'planned'
  && closeA.metadata.toStatus === 'done'
  && closeA.metadata.via === 'route')
check('R26 审计 actorType=user', closeA !== undefined && closeA.actorType === 'user' && closeA.actorId === 'user-1')

await api.dispose()

console.log(`\n=== 结果：通过 ${pass} / 共 ${pass + fail} ===`)
process.exit(fail === 0 ? 0 : 1)