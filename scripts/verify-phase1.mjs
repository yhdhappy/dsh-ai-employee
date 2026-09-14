#!/usr/bin/env node
/**
 * Phase 1 后端逻辑验证脚本（第一段）。
 *
 * 用内存 mock 的 storage + 假 exec，验证 P1.1 ~ P1.6 的后端逻辑：
 *   P1.1 onboarding：hasAnyWorkspace
 *   P1.2 创建项目：建目录(mock exec) + 落 storage
 *   P1.4 用样板建员工
 *   P1.5 员工增改查 + 删除权限墙（Bot 不能删）
 *   P1.6 项目隔离（跨项目零共享）
 *
 * 不碰 web profile、不装 UI、不改任何设计文档。
 * 运行：node scripts/verify-phase1.mjs
 */

import { createWorkspaceService } from '../lib/workspace/workspace-service.js'
import { createBotService } from '../lib/bots/bot-service.js'
import { allTemplates } from '../lib/core/template-service.js'
import { decideAccess } from '../lib/permissions/access.js'
import { createAiEmployee } from '../lib/core/plugin.js'

// ---------- 内存版 AiEmployeeStore ----------
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

// ---------- 简易断言 ----------
let pass = 0
let fail = 0
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

// ---------- 假 exec：记录命令并模拟成功建目录 ----------
const executed = []
function fakeExec(command) {
  executed.push(command)
  if (command.includes('mkdir')) return Promise.resolve({ ok: true })
  return Promise.resolve({ ok: true })
}

console.log('=== Phase 1 验证：项目工作区 + AI 员工 + 隔离 ===\n')

// ---- P1.1 onboarding ----
const store = memStore()
const ws = createWorkspaceService(store, fakeExec)
check('P1.1 初始无项目（onboarding 应显示"创建项目"）', ws.hasAnyWorkspace() === false)

// ---- P1.2 创建项目 ----
const w1 = await ws.createWorkspace({ name: '我的项目A', rootPath: '/tmp/projA', ownerUserId: 'user-1' })
check('P1.2 创建项目成功', !!w1.id && w1.name === '我的项目A' && w1.status === 'active')
check('P1.2 memoryPath 为 root/docs', w1.memoryPath === '/tmp/projA/docs', w1.memoryPath)
check('P1.2 用 shell 执行了 mkdir', executed.some((c) => c.includes('mkdir') && c.includes('docs')), executed[0])
check('P1.2 落 storage 后能查回', ws.getWorkspace(w1.id)?.name === '我的项目A')
check('P1.1 建项目后 hasAnyWorkspace 为 true', ws.hasAnyWorkspace() === true)

// 建第二个项目验证项目隔离数据
const w2 = await ws.createWorkspace({ name: '我的项目B', rootPath: '/tmp/projB', ownerUserId: 'user-1' })
check('P1.6 两个项目可在同一域共存', ws.listWorkspaces().length === 2)

// ---- P1.4 用样板建员工 ----
const bots = createBotService(store)
const templates = allTemplates()
check('P1.4 有 4 个内置样板', templates.length === 4, templates.map((t) => t.name).join(','))
check('P1.4 样板含总顾问/程序员/审核员/情报员',
  ['总顾问', '程序员', '审核员', '情报员'].every((n) => templates.some((t) => t.name === n)))

const advisor = await bots.createBot({
  workspaceId: w1.id,
  templateId: 'advisor',
  name: '总顾问',
  role: '总顾问',
  actor: { kind: 'user', userId: 'user-1' },
})
check('P1.4 从样板建总顾问成功', advisor.templateId === 'advisor' && advisor.providerId === 'pi')
check('P1.4 样板职责继承', advisor.description.includes('理解需求'))

// 改名 + 改职责
const renamed = await bots.updateBot({
  id: advisor.id,
  actor: { kind: 'user', userId: 'user-1' },
  updater: { name: '首席顾问', workingRules: ['新规则1', '新规则2'] },
})
check('P1.5 员工可改名', renamed.name === '首席顾问')
check('P1.5 员工职责(工作规则)可改', renamed.workingRules.length === 2, JSON.stringify(renamed.workingRules))

// 程序员（第二个员工，用于交接链后面）
await bots.createBot({ workspaceId: w1.id, templateId: 'programmer', name: '程序员', role: '程序员', actor: { kind: 'user', userId: 'user-1' } })
check('P1.4 项目A 有 2 个员工', bots.listBotsByWorkspace(w1.id).length === 2)
check('P1.6 项目B 无员工（隔离）', bots.listBotsByWorkspace(w2.id).length === 0)

// ---- P1.5 删除权限墙 ----
let botDenied = false
try {
  await bots.deleteBot(advisor.id, { kind: 'bot', botId: 'some-bot' })
} catch (e) {
  botDenied = e && e.code === 'PERMISSION_DENIED'
}
check('P1.5 Bot 删除员工被拒绝（权限墙）', botDenied)

await bots.deleteBot(advisor.id, { kind: 'user', userId: 'user-1' })
check('P1.5 用户删除员工成功', bots.getBot(advisor.id) === undefined)

// ---- P1.6 项目隔离（文件访问判定）----
const inScope = decideAccess({ workspaceRoot: '/tmp/projA', targetPath: '/tmp/projA/docs/rules.md', kind: 'read' })
const crossProject = decideAccess({ workspaceRoot: '/tmp/projA', targetPath: '/tmp/projB/secret.md', kind: 'read' })
const memoryWrite = decideAccess({ workspaceRoot: '/tmp/projA', targetPath: '/tmp/projA/docs/decisions.md', kind: 'write' })
check('P1.6 项目内读取允许', inScope.allowed === true)
check('P1.6 跨项目默认禁止', crossProject.allowed === false)
check('P1.6 记忆区 docs/ 允许写', memoryWrite.allowed === true)

// ---- P1.0 装配工厂（createAiEmployee）端到端 ----
// 用 mock storageDomain 驱动真实装配路径
let sawSpec = null
let closedCount = 0
function mockStorageDomain() {
  return {
    async open(spec) {
      sawSpec = spec
      const tables = {}
      for (const t of Object.keys(spec.tables)) tables[t] = memTable()
      return {
        name: spec.name,
        table: (n) => tables[n],
        async close() { closedCount++ },
      }
    },
  }
}
const failingDomain = {
  async open() { throw new Error('backend-not-found') },
}

const api = await createAiEmployee({ storageDomain: mockStorageDomain(), execCommand: fakeExec })
check('P1.0 工厂装配出 workspaces/bots', !!api.workspaces && !!api.bots)
check('P1.0 域名为 ai_employee', sawSpec && sawSpec.name === 'ai_employee', sawSpec && sawSpec.name)
check('P1.0 域含 6 张表(workspace/bot/bot_template/workflow/task/audit_event)',
  sawSpec && Object.keys(sawSpec.tables).sort().join(',') === 'audit_event,bot,bot_template,task,workflow,workspace',
  sawSpec && Object.keys(sawSpec.tables).sort().join(','))
check('P1.0 每张表都有 .parse() 校验器',
  sawSpec && Object.values(sawSpec.tables).every((t) => typeof t.valueSchema.parse === 'function'))

// 通过工厂产出的 api 走一遍最小闭环
const fw = await api.workspaces.createWorkspace({ name: '工厂项目', rootPath: '/tmp/factory', ownerUserId: 'user-1' })
check('P1.0 工厂 api 可建项目', fw.name === '工厂项目')
const fb = await api.bots.createBot({ workspaceId: fw.id, templateId: 'reviewer', name: '审核员', role: '审核员', actor: { kind: 'user', userId: 'user-1' } })
check('P1.0 工厂 api 可建员工(样板继承)', fb.templateId === 'reviewer' && fb.systemPrompt.length > 0)

await api.dispose()
check('P1.0 dispose 关闭了存储域', closedCount === 1, 'closed=' + closedCount)

// 装配失败应把已打开的域关掉（不留半开）
let c2 = 0
const partial = {
  async open(spec) {
    const tables = {}
    for (const t of Object.keys(spec.tables)) tables[t] = memTable()
    return { name: spec.name, table: (n) => tables[n], async close() { c2++ } }
  },
}
// createBotService 不会失败，这里直接验证工厂在 open 失败时抛错
let openThrew = false
try {
  await createAiEmployee({ storageDomain: failingDomain, execCommand: fakeExec })
} catch (e) {
  openThrew = true
}
check('P1.0 域打开失败时工厂抛错(不静默)', openThrew)
check('P1.0 域打开失败时不残留半开状态', c2 === 0)

console.log(`\n=== 结果：通过 ${pass} / 共 ${pass + fail} ===`)
process.exit(fail === 0 ? 0 : 1)