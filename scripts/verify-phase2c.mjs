#!/usr/bin/env node
/**
 * Phase 2 第三段验证：装配 Tool（workspace_create / bot_create / workflow_create）。
 *
 * 直接调用 Tool 定义的 execute，验证：
 *   - 三个 Tool 都能真的把对象建出来（复用 service 层）
 *   - 默认值（员工名/职位从样板继承、step id/order 自动补齐）
 *   - 审计（workspace.create / bot.create / workflow.create）
 *   - 越权检查：被派发的员工 session 不能建项目/员工/工作流
 *
 * 运行：node scripts/verify-phase2c.mjs
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAiEmployee } from '../lib/core/plugin.js'
import { createSetupToolDefinitions } from '../lib/core/setup-tools.js'

// ---------- mock ----------
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
function mockStorageDomain() {
  return { async open(spec) {
    const t = {}
    for (const k of Object.keys(spec.tables)) t[k] = memTable()
    return { name: spec.name, table: (n) => t[n], async close() {} }
  } }
}
const fakeExec = async () => ({ ok: true })

/** 让 subagents 可控，便于制造"被派发的员工 session"。 */
function mockSubagents() {
  let n = 0
  return {
    async start() {
      n += 1
      return { id: `child-${n}`, result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }) }
    },
  }
}

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ---------- 搭环境 ----------
const tmpRoot = mkdtempSync(join(tmpdir(), 'p2c-'))
const api = await createAiEmployee({
  storageDomain: mockStorageDomain(),
  execCommand: fakeExec,
  getSubagents: () => mockSubagents(),
})

// 先正常建一个项目（Tool 需要 workspaceId 才能建 bot）
const seedWs = await api.workspaces.createWorkspace({ name: '种子项目', rootPath: tmpRoot, ownerUserId: 'user-1' })

const tools = createSetupToolDefinitions({
  workspaces: api.workspaces,
  bots: api.bots,
  workflows: api.workflows,
  audit: api.audit,
  isDispatchedEmployee: (id) => api.sessions?.isDispatchedEmployee(id) ?? false,
  userId: 'user-1',
})
const tool = (n) => tools.find((t) => t.name === n)
const MAIN_EXEC = { agent: { id: 'main-session-1' } }

console.log('=== 装配 Tool 定义 ===\n')
check('T0 三个 Tool 都定义了',
  tool('workspace_create') !== undefined &&
  tool('bot_create') !== undefined &&
  tool('workflow_create') !== undefined)
check('T0 工具名不含点号（模型 API 约束）',
  tools.every((t) => /^[a-zA-Z0-9_-]+$/.test(t.name)))

// ---------- workspace_create ----------
console.log('\n=== workspace_create ===\n')

const newRoot = join(tmpRoot, 'newproj')
const w1 = await tool('workspace_create').execute(
  { name: 'Tool 建的项目', rootPath: newRoot },
  MAIN_EXEC,
)
check('W1 返回 id/name/rootPath/memoryPath',
  typeof w1.id === 'string' && w1.name === 'Tool 建的项目' && w1.memoryPath === `${newRoot}/docs`)
check('W1 落 storage', api.workspaces.getWorkspace(w1.id) !== undefined)

let w1audit = await api.audit.listEvents({ workspaceId: w1.id, actionFilter: 'workspace.create' })
if (w1audit.length === 0) w1audit = (await api.audit.listEvents({ workspaceId: w1.id })).filter((e) => e.action === 'workspace.create')
check('W1 审计 workspace.create 一条',
  w1audit.length === 1 && w1audit[0].resourceType === 'workspace' && w1audit[0].actorType === 'user')

// 缺 name 应报错（service 层校验）
let w2 = false
try { await tool('workspace_create').execute({ name: '', rootPath: newRoot }, MAIN_EXEC) }
catch (e) { w2 = /不能为空/.test(String(e?.message)) }
check('W2 空项目名被 service 层拒绝', w2)

// ---------- bot_create ----------
console.log('\n=== bot_create ===\n')

const b1 = await tool('bot_create').execute(
  { workspaceId: w1.id, templateId: 'programmer' },
  MAIN_EXEC,
)
check('B1 不传 name 时用样板默认名', b1.name === '程序员' && b1.role === '程序员')
check('B1 返回 templateId', b1.templateId === 'programmer')
const b1Saved = api.bots.getBot(b1.id)
check('B1 继承样板 systemPrompt', b1Saved.systemPrompt.length > 0 && b1Saved.workingRules.length > 0)
check('B1 createdBy=user', b1Saved.createdBy === 'user')

const b2 = await tool('bot_create').execute(
  { workspaceId: w1.id, templateId: 'advisor', name: '首席顾问', role: '总顾问' },
  MAIN_EXEC,
)
check('B2 传 name/role 时按传的来', b2.name === '首席顾问' && b2.role === '总顾问')

let b3 = false
try { await tool('bot_create').execute({ workspaceId: w1.id, templateId: 'nope' }, MAIN_EXEC) }
catch (e) { b3 = /未知样板/.test(String(e?.message)) }
check('B3 未知样板 id 被拒绝', b3)

const bAudit = (await api.audit.listEvents({ workspaceId: w1.id })).filter((e) => e.action === 'bot.create')
check('B4 两次建员工各一条审计', bAudit.length === 2)

// ---------- workflow_create ----------
console.log('\n=== workflow_create ===\n')

const wf1 = await tool('workflow_create').execute({
  workspaceId: w1.id,
  name: '开发→审核',
  steps: [
    { workerBotId: b1.id, description: '实现功能', nextStepId: 'step_2' },
    { workerBotId: b2.id, description: '审核' },
  ],
}, MAIN_EXEC)
check('F1 建工作流成功 + 2 步', wf1.stepCount === 2)
const wfSaved = api.workflows.getWorkflow(wf1.id)
check('F1 自动补 step id', wfSaved.steps[0].id === 'step_1' && wfSaved.steps[1].id === 'step_2')
check('F1 自动补 order', wfSaved.steps[0].order === 1 && wfSaved.steps[1].order === 2)
check('F1 渲染包含链路', typeof wf1.steps === 'string' && wf1.steps.includes('step_1') && wf1.steps.includes('结束'))

// 显式 id 保留
const wf2 = await tool('workflow_create').execute({
  workspaceId: w1.id,
  name: '显式 id',
  steps: [{ id: 'dev', order: 5, workerBotId: b1.id, nextStepId: 'rev' },
          { id: 'rev', order: 9, workerBotId: b2.id }],
}, MAIN_EXEC)
const wf2Saved = api.workflows.getWorkflow(wf2.id)
check('F2 显式 id/order 被保留', wf2Saved.steps[0].id === 'dev' && wf2Saved.steps[0].order === 5)

// 空 steps 拒绝
let f3 = false
try { await tool('workflow_create').execute({ workspaceId: w1.id, name: 'x', steps: [] }, MAIN_EXEC) }
catch (e) { f3 = /至少要有一个步骤/.test(String(e?.message)) }
check('F3 空 steps 被拒绝', f3)

// nextStepId 越界拒绝（service 层一致性校验）
let f4 = false
try {
  await tool('workflow_create').execute({
    workspaceId: w1.id, name: 'bad',
    steps: [{ id: 'a', order: 1, workerBotId: b1.id, nextStepId: 'ghost' }],
  }, MAIN_EXEC)
} catch (e) { f4 = /nextStepId/.test(String(e?.message)) }
check('F4 nextStepId 越界被 service 层拒绝', f4)

const wfAudit = (await api.audit.listEvents({ workspaceId: w1.id })).filter((e) => e.action === 'workflow.create')
check('F5 两次建工作流各一条审计', wfAudit.length === 2)
check('F5 审计带 stepIds', Array.isArray(wfAudit[0].metadata.stepIds))

// "等用户决策"步骤（无 workerBotId）
const wf3 = await tool('workflow_create').execute({
  workspaceId: w1.id, name: '带等待',
  steps: [{ id: 's1', workerBotId: b1.id, nextStepId: 's2' }, { id: 's2', description: '等用户拍板' }],
}, MAIN_EXEC)
check('F6 无 workerBotId 的步骤被允许（等用户决策）',
  api.workflows.getWorkflow(wf3.id).steps[1].workerBotId === undefined)

// ---------- 越权检查 ----------
console.log('\n=== 越权检查（被派发的员工不能装配）===\n')

// 制造一个"被派发的员工 session"：派发一个 task，拿到 runId
const taskForPerm = await api.tasks.createTask({
  workspaceId: seedWs.id, title: '占位任务', ownerBotId: (await api.bots.createBot({
    workspaceId: seedWs.id, templateId: 'programmer', name: '程序员', role: '程序员',
    actor: { kind: 'user', userId: 'user-1' },
  })).id,
  createdBy: 'user', initialStatus: 'ready',
})
const dispatched = await api.dispatch.dispatchOne({
  taskId: taskForPerm.id, parent: { id: 'main-session-1' }, signal: new AbortController().signal,
})
const EMPLOYEE_EXEC = { agent: { id: dispatched.runId } }
check('P0 员工 session 被识别', api.sessions.isDispatchedEmployee(dispatched.runId) === true)
check('P0 主会话不被误判为员工', api.sessions.isDispatchedEmployee('main-session-1') === false)

let p1 = false
try { await tool('workspace_create').execute({ name: '越权项目', rootPath: join(tmpRoot, 'evil') }, EMPLOYEE_EXEC) }
catch (e) { p1 = /越权/.test(String(e?.message)) }
check('P1 员工不能建项目', p1)

let p2 = false
try { await tool('bot_create').execute({ workspaceId: w1.id, templateId: 'advisor' }, EMPLOYEE_EXEC) }
catch (e) { p2 = /越权/.test(String(e?.message)) }
check('P2 员工不能建员工', p2)

let p3 = false
try {
  await tool('workflow_create').execute({
    workspaceId: w1.id, name: '越权工作流',
    steps: [{ id: 'a', workerBotId: b1.id }],
  }, EMPLOYEE_EXEC)
} catch (e) { p3 = /越权/.test(String(e?.message)) }
check('P3 员工不能建工作流', p3)

// 被拒后不应该留下脏数据
check('P4 越权被拒后没有创建出对象',
  api.workspaces.listWorkspaces().length === 2 &&
  api.bots.listBotsByWorkspace(w1.id).length === 2 &&
  api.workflows.listByWorkspace(w1.id).length === 3)

// ---------- 清理 ----------
rmSync(tmpRoot, { recursive: true, force: true })
await api.dispose()

console.log(`\n=== 结果：通过 ${pass} / 共 ${pass + fail} ===`)
process.exit(fail === 0 ? 0 : 1)