/**
 * 回归测试：TaskService.setStatus（强制设状态）。
 *
 * 背景：工作流跑完后任务会停在 dev_done / wait_owner 等中间态，
 * 而 transitionStatus 受迁移图限制（dev_done → done 不合法），
 * 所以需要 setStatus 这个管理员逃生口来收尾。
 *
 * 与 transitionStatus 的关键差异要在测试里锁住：
 *   - 不校验迁移图
 *   - done 是终态（不能再改出去），但 done → done 幂等
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createTaskService } from '../lib/tasks/task-service.js'

/** 内存 table 版 store（只需 task 表）。 */
function memStore() {
  const m = new Map()
  const table = {
    get: (k) => m.get(k),
    put: (k, v) => { m.set(k, v); return Promise.resolve() },
    update: (k, fn) => { const n = fn(m.get(k)); m.set(k, n); return Promise.resolve(n) },
    delete: (k) => Promise.resolve(m.delete(k)),
    entries: () => m.entries(),
  }
  return { task: table }
}

async function seed(tasks, status = 'dev_done') {
  return await tasks.createTask({
    workspaceId: 'ws_1',
    title: '任务',
    ownerBotId: 'bot_1',
    createdBy: 'user',
    initialStatus: status,
  })
}

test('setStatus 允许迁移图外的跳转（wait_owner → pass）', async () => {
  const tasks = createTaskService(memStore())
  // wait_owner 正是"等用户决策"卡住的状态，它的合法去向里没有 pass
  const t = await seed(tasks, 'wait_owner')
  // 先确认常规通道确实禁止这条迁移（否则这个测试就没意义了）
  await assert.rejects(() => tasks.transitionStatus(t.id, 'pass'), /非法状态迁移/)
  const after = await tasks.setStatus(t.id, 'pass')
  assert.equal(after.status, 'pass')
  assert.equal(tasks.getTask(t.id).status, 'pass')
})

test('setStatus 允许迁移图外的跳转（planned → changes_req）', async () => {
  const tasks = createTaskService(memStore())
  const t = await seed(tasks, 'planned')
  await assert.rejects(() => tasks.transitionStatus(t.id, 'changes_req'), /非法状态迁移/)
  assert.equal((await tasks.setStatus(t.id, 'changes_req')).status, 'changes_req')
})

test('setStatus 到 done 会补 completedAt', async () => {
  const tasks = createTaskService(memStore())
  const t = await seed(tasks, 'wait_owner')
  const after = await tasks.setStatus(t.id, 'done')
  assert.equal(typeof after.completedAt, 'string')
})

test('setStatus 同状态幂等（不报错、不重复写）', async () => {
  const tasks = createTaskService(memStore())
  const t = await seed(tasks, 'pass')
  const a = await tasks.setStatus(t.id, 'pass')
  const b = await tasks.setStatus(t.id, 'pass')
  assert.equal(a.status, 'pass')
  assert.equal(b.updatedAt, a.updatedAt)
})

test('done 是终态：不能改出去', async () => {
  const tasks = createTaskService(memStore())
  const t = await seed(tasks, 'dev_done')
  await tasks.setStatus(t.id, 'done')
  await assert.rejects(() => tasks.setStatus(t.id, 'changes_req'), /已完成/)
  assert.equal(tasks.getTask(t.id).status, 'done')
})

test('done → done 走幂等分支（不被终态保护拦住）', async () => {
  const tasks = createTaskService(memStore())
  const t = await seed(tasks, 'planned')
  await tasks.setStatus(t.id, 'done')
  const again = await tasks.setStatus(t.id, 'done')
  assert.equal(again.status, 'done')
})

test('非法目标状态被拒', async () => {
  const tasks = createTaskService(memStore())
  const t = await seed(tasks)
  await assert.rejects(() => tasks.setStatus(t.id, 'nonsense'), /非法目标状态/)
})

test('任务不存在时报错可读', async () => {
  const tasks = createTaskService(memStore())
  await assert.rejects(() => tasks.setStatus('task_ghost', 'done'), /任务不存在/)
})

test('pass / changes_req 也能强制设（覆盖 wait_owner 收尾场景）', async () => {
  const tasks = createTaskService(memStore())
  const a = await seed(tasks, 'wait_owner')
  assert.equal((await tasks.setStatus(a.id, 'pass')).status, 'pass')
  const b = await seed(tasks, 'dev_done')
  assert.equal((await tasks.setStatus(b.id, 'changes_req')).status, 'changes_req')
})
