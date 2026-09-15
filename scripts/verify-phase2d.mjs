#!/usr/bin/env node
/**
 * Phase 2 第四段验证：task_close Tool（强制收尾停在中间态的任务）。
 *
 * 验证：
 *   - 契约：Tool 名、参数、返回体形状
 *   - 正常关闭 done / pass / changes_req
 *   - 幂等（同状态重复关闭）
 *   - 越权：被派发的员工不能关闭任务
 *   - 终态保护：done 不能再改
 *   - 参数校验：非法 forceTo / 任务不存在
 *   - 审计：task.close 带 forceTo/reason/fromStatus/toStatus/via
 *   - 与派发解耦：subagents 不可用时 task_close 仍可用
 *
 * 运行：node scripts/verify-phase2d.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAiEmployee } from '../lib/core/plugin.js'
import { createCloseToolDefinitions } from '../lib/orchestrator/dispatch-tools.js'

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
  return {
    async open(spec) {
      const t = {}
      for (const k of Object.keys(spec.tables)) t[k] = memTable()
      return { name: spec.name, table: (n) => t[n], async close() {} }
    },
  }
}
const fakeExec = async () => ({ ok: true })

/** 可控 subagents：用来制造"被派发的员工 session"。 */
function mockSubagents() {
  let n = 0
  return {
    async start() {
      n += 1
      return {
        id: `child-${n}`,
        result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
      }
    },
  }
}

let pass = 0, fail = 0
function check(name, ok, detail = '') {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}
/** 断言 execute 抛错（同步/异步都吃）。 */
async function throws(fn) {
  try {
    await fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

// ---------- 搭环境 ----------
const tmpRoot = mkdtempSync(join(tmpdir(), 'p2d-'))
const api = await createAiEmployee({
  storageDomain: mockStorageDomain(),
  execCommand: fakeExec,
  getSubagents: () => mockSubagents(),
})

const ws = await api.workspaces.createWorkspace({ name: '收尾测试', rootPath: tmpRoot, ownerUserId: 'user-1' })
const bot = await api.bots.createBot({ workspaceId: ws.id, templateId: 'programmer', name: '程序员', role: '程序员', actor: { kind: 'user', userId: 'user-1' } })

const tools = createCloseToolDefinitions({
  tasks: api.tasks,
  audit: api.audit,
  isDispatchedEmployee: (id) => api.sessions?.isDispatchedEmployee(id) ?? false,
  userId: 'user-1',
})
const closeTool = tools.find((t) => t.name === 'task_close')
const MAIN_EXEC = { agent: { id: 'main-session-1' } }

const mkTask = async (title, initialStatus) =>
  await api.tasks.createTask({
    workspaceId: ws.id, title, ownerBotId: bot.id, createdBy: 'user',
    ...(initialStatus !== undefined ? { initialStatus } : {}),
  })

// ---------- 1) 契约 ----------
console.log('=== task_close Tool 契约 ===\n')

check('T1 注册了 task_close（共 1 个）', tools.length === 1 && closeTool !== undefined)
check('T2 Tool 名用下划线（无点号）', closeTool.name === 'task_close' && !closeTool.name.includes('.'))
const schema = closeTool.parameters ?? {}
const props = schema.properties ?? {}
const required = schema.required ?? []
check('T3 参数含 taskId/forceTo/reason',
  'taskId' in props && 'forceTo' in props && 'reason' in props)
check('T4 taskId 与 forceTo 必填、reason 可选',
  required.includes('taskId') && required.includes('forceTo') && !required.includes('reason'))
check('T5 forceTo 枚举三值',
  Array.isArray(props.forceTo?.enum) &&
  ['done', 'pass', 'changes_req'].every((v) => props.forceTo.enum.includes(v)))
check('T5b 返回体声明 ok + task 字段',
  (closeTool.output?.schema?.properties?.ok !== undefined) &&
  (closeTool.output?.schema?.properties?.task !== undefined))

// ---------- 2) 正常关闭 ----------
console.log('\n=== 强制关闭 / 推进 ===\n')

const tA = await mkTask('悬着的任务A', 'planned')
let out = await closeTool.execute({ taskId: tA.id, forceTo: 'done', reason: '任务已废弃' }, MAIN_EXEC)
check('T6 planned → done 成功（绕过迁移图）', out.ok === true && out.task.status === 'done')
check('T7 返回契约字段 id/title/status/statusZh/updatedAt',
  out.task.id === tA.id && out.task.title === '悬着的任务A' &&
  out.task.statusZh === '完成' && typeof out.task.updatedAt === 'string')
const storedA = api.tasks.getTask(tA.id)
check('T8 真的落库 + 补 completedAt', storedA.status === 'done' && typeof storedA.completedAt === 'string')

const tB = await mkTask('待裁决的任务B', 'wait_owner')
out = await closeTool.execute({ taskId: tB.id, forceTo: 'pass', reason: '审核通过' }, MAIN_EXEC)
check('T9 wait_owner → pass 成功', out.task.status === 'pass' && out.task.statusZh === '审核通过')

const tC = await mkTask('被打回的任务C', 'dev_done')
out = await closeTool.execute({ taskId: tC.id, forceTo: 'changes_req', reason: '需返工' }, MAIN_EXEC)
check('T10 dev_done → changes_req 成功', out.task.status === 'changes_req' && out.task.statusZh === '需修改')

// ---------- 3) 幂等 ----------
console.log('\n=== 幂等与终态保护 ===\n')

out = await closeTool.execute({ taskId: tA.id, forceTo: 'done' }, MAIN_EXEC)
check('T11 done → done 幂等（不报错）', out.ok === true && out.task.status === 'done')

out = await closeTool.execute({ taskId: tB.id, forceTo: 'pass' }, MAIN_EXEC)
check('T12 pass → pass 幂等', out.ok === true && out.task.status === 'pass')

let msg = await throws(() => closeTool.execute({ taskId: tA.id, forceTo: 'changes_req' }, MAIN_EXEC))
check('T13 done 是终态，不能再改状态', msg !== null && /已完成/.test(msg), `msg=${msg}`)

// ---------- 4) 参数校验 ----------
console.log('\n=== 参数校验 ===\n')

msg = await throws(() => closeTool.execute({ taskId: tA.id, forceTo: 'reviewing' }, MAIN_EXEC))
check('T14 非法 forceTo 被拒（schema/service 层）', msg !== null)

msg = await throws(() => closeTool.execute({ taskId: 'task_ghost', forceTo: 'done' }, MAIN_EXEC))
check('T15 任务不存在报错可读', msg !== null && /任务不存在/.test(msg), `msg=${msg}`)

// ---------- 5) 越权检查 ----------
console.log('\n=== 越权检查（被派发的员工不能收尾任务）===\n')

// 真的派一次活，让 session-service 记住一个"员工 session"
await api.dispatch.dispatchOne({
  taskId: (await mkTask('给员工的活', 'ready')).id,
  parent: MAIN_EXEC,
  signal: undefined,
})
const employeeRunId = api.sessions.listRuns(1)[0]?.runId
check('T16 已记录一个员工 session', typeof employeeRunId === 'string' && employeeRunId.startsWith('child-'))

const tD = await mkTask('不该被员工关的任务', 'dev_done')
msg = await throws(() =>
  closeTool.execute({ taskId: tD.id, forceTo: 'done' }, { agent: { id: employeeRunId } }))
check('T17 员工 session 关闭任务被拒（越权）', msg !== null && /越权/.test(msg), `msg=${msg}`)
check('T18 越权被拒后任务状态未变', api.tasks.getTask(tD.id).status === 'dev_done')

// ---------- 6) 审计 ----------
console.log('\n=== 审计 ===\n')

const events = await api.audit.listEvents({ workspaceId: ws.id, action: 'task.close', limit: 100 })
// tA 被关闭两次（T6 正常关闭 + T11 幂等），这里按 reason 精确定位，不依赖两条审计的相对顺序
const evA = events.find((e) => e.resourceId === tA.id && e.metadata.reason === '任务已废弃')
check('T19 记了 task.close 审计', evA !== undefined)
check('T20 审计含 forceTo/reason/fromStatus/toStatus/via',
  evA !== undefined && evA.metadata.forceTo === 'done' && evA.metadata.reason === '任务已废弃' &&
  evA.metadata.fromStatus === 'planned' && evA.metadata.toStatus === 'done' && evA.metadata.via === 'tool')
check('T21 审计 actorType=user / actorId=user-1',
  evA !== undefined && evA.actorType === 'user' && evA.actorId === 'user-1')
check('T22 幂等那一次也写了审计（5 条）', events.length === 5, `实际 ${events.length}`)

// ---------- 7) 与派发解耦 ----------
console.log('\n=== 与派发解耦（无 subagents 时仍可用）===\n')

{
  const api2 = await createAiEmployee({
    storageDomain: mockStorageDomain(),
    execCommand: fakeExec,
    // 不给 getSubagents → dispatch 不装配（headless 组合）
  })
  check('T23 headless 下 dispatch 未装配', api2.dispatch === undefined)
  const ws2 = await api2.workspaces.createWorkspace({ name: 'headless', rootPath: tmpRoot, ownerUserId: 'user-1' })
  const bot2 = await api2.bots.createBot({ workspaceId: ws2.id, templateId: 'programmer', name: '程序员', role: '程序员', actor: { kind: 'user', userId: 'user-1' } })
  const t2 = await api2.tasks.createTask({
    workspaceId: ws2.id, title: 'headless 任务', ownerBotId: bot2.id, createdBy: 'user',
    initialStatus: 'dev_done',
  })
  const tools2 = createCloseToolDefinitions({ tasks: api2.tasks, audit: api2.audit })
  const out2 = await tools2[0].execute({ taskId: t2.id, forceTo: 'done' }, MAIN_EXEC)
  check('T24 无 subagents 时 task_close 仍能收尾', out2.ok === true && api2.tasks.getTask(t2.id).status === 'done')
  await api2.dispose()
}

await api.dispose()
rmSync(tmpRoot, { recursive: true, force: true })

console.log(`\n=== 结果：通过 ${pass} / 共 ${pass + fail} ===`)
process.exit(fail === 0 ? 0 : 1)
