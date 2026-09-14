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

await api.dispose()

console.log(`\n=== 结果：通过 ${pass} / 共 ${pass + fail} ===`)
process.exit(fail === 0 ? 0 : 1)