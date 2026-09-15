#!/usr/bin/env node
/**
 * Phase 2 第二段验证：派发层（Session + Dispatch + Workflow 触发 + 审计）。
 *
 * 用 mock subagents 驱动真实 SessionService / DispatchService，
 * 验证：
 *   - P2.5 派任务 → 起子 session（persona = Bot 的 systemPrompt）
 *   - P2.6 工作流触发下一棒 + 终止条件（no-next-step / wait-owner / max-depth）
 *   - Session 状态管理
 *   - 项目记忆落盘（V0.2 B.9）
 *   - 审计（task.dispatch / workflow.trigger / session.dispatch）
 *   - 路由 listAuditEvents
 *
 * 运行：node scripts/verify-phase2b.mjs
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createAiEmployee } from '../lib/core/plugin.js'
import { makeAiEmployeeHandler } from '../lib/api/route.js'

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

/** 可控的 mock subagents：记录每次 start 的请求，返回可配置结果。 */
function mockSubagents(opts = {}) {
  const calls = []
  const api = {
    calls,
    failWith: opts.failWith ?? null,
    stopReason: opts.stopReason ?? 'completed',
    text: opts.text ?? '（mock 产出）',
    async start(name, request) {
      calls.push({ name, request })
      if (api.failWith !== null) throw new Error(api.failWith)
      const idx = calls.length
      return {
        id: `child-${idx}`,
        result: Promise.resolve({
          output: [{ type: 'text', text: `${api.text}#${idx}` }],
          stopReason: api.stopReason,
        }),
      }
    },
  }
  return api
}

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ---------- 搭环境 ----------
const tmpRoot = mkdtempSync(join(tmpdir(), 'p2b-'))
const subs = mockSubagents()
const api = await createAiEmployee({
  storageDomain: mockStorageDomain(),
  execCommand: fakeExec,
  getSubagents: () => subs,
})

check('E1 subagents 可用时装配出 sessions/dispatch',
  api.sessions !== undefined && api.dispatch !== undefined)

const ws = await api.workspaces.createWorkspace({ name: 'P2B', rootPath: tmpRoot, ownerUserId: 'user-1' })
const mkBot = async (templateId, name) => api.bots.createBot({
  workspaceId: ws.id, templateId, name, role: name,
  actor: { kind: 'user', userId: 'user-1' },
})
const advisor = await mkBot('advisor', '总顾问')
const programmer = await mkBot('programmer', '程序员')
const reviewer = await mkBot('reviewer', '审核员')
const fakeParent = { id: 'parent-session-1' }
const fakeSignal = new AbortController().signal

// ---------- P2.5 Session 服务 ----------
console.log('\n=== P2.5 Session 服务（派发子 session）===\n')

const r1 = await api.sessions.dispatchToBot({
  workspaceId: ws.id, botId: programmer.id, prompt: '写个函数', parent: fakeParent, signal: fakeSignal,
})
check('S1 dispatchToBot 返回 runId/botName/output', r1.runId === 'child-1' && r1.botName === '程序员' && r1.outputText.includes('mock 产出'))
check('S1 起的是 spawn provider', subs.calls[0].name === 'spawn')
check('S1 persona = Bot 的 systemPrompt',
  subs.calls[0].request.persona === programmer.systemPrompt && subs.calls[0].request.persona.length > 0)
check('S1 parent 原样透传', subs.calls[0].request.parent === fakeParent)
check('S1 signal 原样透传', subs.calls[0].request.signal === fakeSignal)
check('S1 prompt 是 ContentBlock[]',
  Array.isArray(subs.calls[0].request.prompt) && subs.calls[0].request.prompt[0].type === 'text')

// S2 Bot 不存在
let s2 = false
try { await api.sessions.dispatchToBot({ workspaceId: ws.id, botId: 'bot_nope', prompt: 'x', parent: fakeParent, signal: fakeSignal }) }
catch (e) { s2 = /Bot 不存在/.test(String(e?.message)) }
check('S2 Bot 不存在时报错', s2)

// S3 缺 parent
let s3 = false
try { await api.sessions.dispatchToBot({ workspaceId: ws.id, botId: programmer.id, prompt: 'x', parent: undefined, signal: fakeSignal }) }
catch (e) { s3 = /parent/.test(String(e?.message)) }
check('S3 缺 parent 时报错', s3)

// S4 Bot 停用
const paused = await mkBot('researcher', '情报员')
await api.bots.updateBot({ id: paused.id, actor: { kind: 'user', userId: 'u' }, updater: { status: 'paused' } })
let s4 = false
try { await api.sessions.dispatchToBot({ workspaceId: ws.id, botId: paused.id, prompt: 'x', parent: fakeParent, signal: fakeSignal }) }
catch (e) { s4 = /不可派活/.test(String(e?.message)) }
check('S4 Bot 停用后不可派活', s4)

// S5 运行记录（S2/S3/S4 都在记录前就抛错了，所以此刻只有 S1 一条）
const runs = api.sessions.listRuns()
check('S5 listRuns 记录运行（此刻仅 S1）', runs.length === 1 && runs[0].status === 'completed')
check('S5 run 记录了 botName/stopReason', runs[0].botName === '程序员' && runs[0].stopReason === 'completed')

// S6 subagents 抛错 → 记录 failed
subs.failWith = '模拟子 agent 崩溃'
let s6 = false
try { await api.sessions.dispatchToBot({ workspaceId: ws.id, botId: programmer.id, prompt: 'x', parent: fakeParent, signal: fakeSignal }) }
catch { s6 = true }
const lastRun = api.sessions.listRuns().at(-1)
check('S6 subagents 异常向上抛', s6)
check('S6 异常也记入运行状态', lastRun.status === 'failed' && String(lastRun.error).includes('模拟子 agent 崩溃'))
subs.failWith = null

// ---------- P2.6 Dispatch + 工作流触发 ----------
console.log('\n=== P2.6 Dispatch + 工作流触发 ===\n')

// D1 独立任务（无工作流）
const t1 = await api.tasks.createTask({
  workspaceId: ws.id, title: '独立任务', ownerBotId: programmer.id,
  createdBy: 'user', initialStatus: 'ready',
})
const d1 = await api.dispatch.dispatchTask({ taskId: t1.id, parent: fakeParent, signal: fakeSignal })
check('D1 独立任务：stoppedBy=no-workflow', d1.stoppedBy === 'no-workflow')
check('D1 跑完状态 = dev_done（开发完成）', d1.step.finalStatus === 'dev_done')
check('D1 任务记录已是 dev_done', api.tasks.getTask(t1.id).status === 'dev_done')
check('D1 chain 为空', d1.chain.length === 0)

// D2 项目记忆落盘（V0.2 B.9）
const memFile = join(tmpRoot, 'docs', 'tasks', `${t1.id}.md`)
check('D2 产出写入 docs/tasks/<taskId>.md', existsSync(memFile))
if (existsSync(memFile)) {
  const c = readFileSync(memFile, 'utf8')
  check('D2 记忆含执行员工与产出', c.includes('程序员') && c.includes('mock 产出'))
}

// D3 工作流链：程序员 → 审核员（跑 2 棒）
const wf = await api.workflows.createWorkflow({
  workspaceId: ws.id, name: '开发→审核',
  steps: [
    { id: 's1', order: 1, workerBotId: programmer.id, nextStepId: 's2', description: '实现功能' },
    { id: 's2', order: 2, workerBotId: reviewer.id, description: '审核代码' },
  ],
})
const t2 = await api.tasks.createTask({
  workspaceId: ws.id, title: '走工作流的任务', ownerBotId: programmer.id,
  createdBy: 'user', initialStatus: 'ready',
  workflowId: wf.id, workflowStepId: 's1',
})
const d3 = await api.dispatch.dispatchTask({ taskId: t2.id, parent: fakeParent, signal: fakeSignal })
check('D3 第一棒是程序员', d3.step.botName === '程序员')
check('D3 链上有 1 个后续棒（审核员）', d3.chain.length === 1 && d3.chain[0].botName === '审核员')
check('D3 链终止原因 = no-next-step', d3.stoppedBy === 'no-next-step')
check('D3 第一棒任务停在 dev_done（等下一棒裁决）', api.tasks.getTask(t2.id).status === 'dev_done')
const lastTaskD3 = api.tasks.listByWorkspace(ws.id).find((t) => t.workflowStepId === 's2')
check('D3 最后一棒任务收尾为 done（终态）', lastTaskD3 !== undefined && lastTaskD3.status === 'done')
check('D3 为下一棒建了新 task',
  lastTaskD3 !== undefined && lastTaskD3.ownerBotId === reviewer.id)

// D4 下一步无 workerBotId → wait-owner
const wfWait = await api.workflows.createWorkflow({
  workspaceId: ws.id, name: '开发→等用户',
  steps: [
    { id: 'a', order: 1, workerBotId: programmer.id, nextStepId: 'b', description: '实现' },
    { id: 'b', order: 2, description: '等用户拍板' },
  ],
})
const t4 = await api.tasks.createTask({
  workspaceId: ws.id, title: '需要用户拍板', ownerBotId: programmer.id,
  createdBy: 'user', initialStatus: 'ready', workflowId: wfWait.id, workflowStepId: 'a',
})
const d4 = await api.dispatch.dispatchTask({ taskId: t4.id, parent: fakeParent, signal: fakeSignal })
check('D4 stoppedBy=wait-owner', d4.stoppedBy === 'wait-owner')
check('D4 任务置 wait_owner', api.tasks.getTask(t4.id).status === 'wait_owner')
check('D4 带 waitingFor 描述', typeof d4.waitingFor === 'string' && d4.waitingFor.includes('等用户'))

// D5 maxChainDepth 守卫（成环工作流）
const wfLoop = await api.workflows.createWorkflow({
  workspaceId: ws.id, name: '环',
  steps: [
    { id: 'x', order: 1, workerBotId: programmer.id, nextStepId: 'y' },
    { id: 'y', order: 2, workerBotId: reviewer.id, nextStepId: 'x' },
  ],
})
const t5 = await api.tasks.createTask({
  workspaceId: ws.id, title: '成环', ownerBotId: programmer.id,
  createdBy: 'user', initialStatus: 'ready', workflowId: wfLoop.id, workflowStepId: 'x',
})
const d5 = await api.dispatch.dispatchTask({ taskId: t5.id, parent: fakeParent, signal: fakeSignal, maxChainDepth: 2 })
check('D5 环被 max-depth 拦住', d5.stoppedBy === 'max-depth' && d5.chain.length === 2)

// D6 已完成任务不能派发（用 D3 链尾那张已 done 的任务）
let d6 = false
try { await api.dispatch.dispatchTask({ taskId: lastTaskD3.id, parent: fakeParent, signal: fakeSignal }) }
catch (e) { d6 = /已完成/.test(String(e?.message)) }
check('D6 已完成（done）任务不可再派发', d6)

// D7 dispatchOne 不推进工作流
const s2Before = api.tasks.listByWorkspace(ws.id).filter((t) => t.workflowId === wf.id && t.workflowStepId === 's2').length
const t7 = await api.tasks.createTask({
  workspaceId: ws.id, title: '只跑一棒', ownerBotId: programmer.id,
  createdBy: 'user', initialStatus: 'ready', workflowId: wf.id, workflowStepId: 's1',
})
const d7 = await api.dispatch.dispatchOne({ taskId: t7.id, parent: fakeParent, signal: fakeSignal })
const s2After = api.tasks.listByWorkspace(ws.id).filter((t) => t.workflowId === wf.id && t.workflowStepId === 's2').length
check('D7 dispatchOne 只跑一棒', d7.finalStatus === 'dev_done')
check('D7 dispatchOne 不建下一棒 task', s2After === s2Before, `before=${s2Before} after=${s2After}`)

// ---------- 审计 ----------
console.log('\n=== 派发审计 ===\n')

const allEvents = await api.audit.listEvents({ workspaceId: ws.id, limit: 500 })
const dispatchEvents = allEvents.filter((e) => e.action === 'task.dispatch')
const triggerEvents = allEvents.filter((e) => e.action === 'workflow.trigger')
const sessionEvents = allEvents.filter((e) => e.action === 'session.dispatch')
check('A1 有 task.dispatch 审计', dispatchEvents.length >= 6)
check('A2 有 workflow.trigger 审计（含成环那次）', triggerEvents.length >= 3)
check('A3 有 session.dispatch 审计', sessionEvents.length >= 6)
check('A4 task.dispatch 的 resourceType=task', dispatchEvents[0].resourceType === 'task')
check('A5 workflow.trigger 的 actorType=system', triggerEvents[0].actorType === 'system' && triggerEvents[0].actorId === 'workflow')

// ---------- 路由 listAuditEvents ----------
console.log('\n=== 路由 listAuditEvents ===\n')

function mockReq(method, body) {
  const s = Readable.from([Buffer.from(body == null ? '' : JSON.stringify(body), 'utf8')])
  s.method = method
  return s
}
function mockRes() {
  return {
    statusCode: 0, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v },
    end(p) { if (p != null) this.body = p; return this },
  }
}
async function call(handler, body) {
  const res = mockRes()
  await handler(mockReq('POST', body), res)
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

const handler = makeAiEmployeeHandler({ api, userId: 'user-1' })

let r = await call(handler, { action: 'listAuditEvents', workspaceId: ws.id, limit: 10 })
check('R1 listAuditEvents 返回 200 + events', r.status === 200 && r.body.ok === true && Array.isArray(r.body.events))
check('R1 默认按时间倒序 + limit 生效', r.body.events.length === 10)

r = await call(handler, { action: 'listAuditEvents', workspaceId: ws.id, actionFilter: 'task.dispatch', limit: 3 })
check('R2 支持 actionFilter 过滤', r.status === 200 && r.body.events.length > 0 && r.body.events.every((e) => e.action === 'task.dispatch'))

r = await call(handler, { action: 'listAuditEvents' })
check('R3 缺 workspaceId 返回 400', r.status === 400 && r.body.error.includes('workspaceId'))

r = await call(handler, { action: 'listAuditEvents', workspaceId: 'ws_other_none' })
check('R4 其他项目查不到审计（隔离）', r.status === 200 && r.body.events.length === 0)

// 清理
rmSync(tmpRoot, { recursive: true, force: true })
await api.dispose()

console.log(`\n=== 结果：通过 ${pass} / 共 ${pass + fail} ===`)
process.exit(fail === 0 ? 0 : 1)