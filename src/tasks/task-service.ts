/**
 * 任务（Task）服务。
 *
 * Phase 2 第一段：CRUD + 状态机安全迁移。
 *
 * 文档原文（V0.3 §15/§18）：
 *   - Task 是工作单（独立可执行、可审核、可验收）
 *   - 状态机 11 个（V0.3 §18 完整列出）
 *
 * 段 1 的选择（写在报告里）：
 *   - 状态名 schema 校验（合法值才能存）
 *   - 状态迁移走 canTransition(from, to) 校验，不合法直接抛错
 *   - 完成时（status=done）自动填 completedAt
 *   - status 反查用 now/currentStatus（避免 race）
 */

import type { Task, TaskStatus } from '../storage/schemas.js'
import { TASK_STATUS_LABELS } from '../storage/schemas.js'
import type { AiEmployeeStore } from '../storage/domain.js'
import { canTransition } from '../core/status-machine.js'

function nowIso(): string {
  return new Date().toISOString()
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export interface CreateTaskInput {
  workspaceId: string
  title: string
  ownerBotId: string
  createdBy: 'user' | 'bot'
  /** 可选字段。 */
  moduleId?: string
  workflowId?: string
  workflowStepId?: string
  description?: string
  /** 初始状态，默认 'planned'。 */
  initialStatus?: TaskStatus
}

export interface UpdateTaskInput {
  id: string
  title?: string
  description?: string
  ownerBotId?: string
}

export interface TaskService {
  listByWorkspace(workspaceId: string): Task[]
  /** 按 owner 过滤。 */
  listByOwnerBot(workspaceId: string, ownerBotId: string): Task[]
  getTask(id: string): Task | undefined
  /** 列出某工作流步骤下所有的 Task。 */
  listByWorkflowStep(workflowId: string, workflowStepId: string): Task[]
  createTask(input: CreateTaskInput): Promise<Task>
  updateTask(input: UpdateTaskInput): Promise<Task>
  /** 状态迁移：必须满足 canTransition(currentStatus, to)。 */
  transitionStatus(id: string, to: TaskStatus): Promise<Task>
  /**
   * 强制设状态（管理员逃生口，**不校验 canTransition**）。
   *
   * 用途：收尾停在中间态（dev_done / wait_owner / changes_req…）的任务。
   * 与 transitionStatus 的差异：
   *   - 不做迁移图校验（例如 wait_owner → pass、planned → changes_req
   *     这些正常通道禁止的跳转，这里直接放行）
   *   - done 是终态：不允许从 done 改出去（done → done 幂等放行）
   * 目标状态仍走 schema 白名单；to='done' 时补 completedAt。
   */
  setStatus(id: string, to: TaskStatus): Promise<Task>
  deleteTask(id: string): Promise<void>
}

export function createTaskService(store: AiEmployeeStore): TaskService {
  const table = store.task

  function listByWorkspace(workspaceId: string): Task[] {
    const out: Task[] = []
    for (const [, t] of table.entries()) {
      if (t.workspaceId === workspaceId) out.push(t)
    }
    return out
  }

  function listByOwnerBot(workspaceId: string, ownerBotId: string): Task[] {
    const out: Task[] = []
    for (const [, t] of table.entries()) {
      if (t.workspaceId === workspaceId && t.ownerBotId === ownerBotId) out.push(t)
    }
    return out
  }

  function getTask(id: string): Task | undefined {
    return table.get(id)
  }

  function listByWorkflowStep(workflowId: string, workflowStepId: string): Task[] {
    const out: Task[] = []
    for (const [, t] of table.entries()) {
      if (t.workflowId === workflowId && t.workflowStepId === workflowStepId) out.push(t)
    }
    return out
  }

  async function createTask(input: CreateTaskInput): Promise<Task> {
    if (!input.workspaceId) throw new Error('workspaceId 不能为空')
    const title = input.title.trim()
    if (!title) throw new Error('title 不能为空')
    if (!input.ownerBotId) throw new Error('ownerBotId 不能为空')
    const initialStatus: TaskStatus = input.initialStatus ?? 'planned'
    // 检查初始状态是否合法（schema 会拒，但 explicit error 更友好）
    if (!(initialStatus in TASK_STATUS_LABELS)) {
      throw new Error(`非法状态：${initialStatus}`)
    }

    const now = nowIso()
    const task: Task = {
      id: genId('task'),
      workspaceId: input.workspaceId,
      ...(input.moduleId !== undefined ? { moduleId: input.moduleId } : {}),
      ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
      ...(input.workflowStepId !== undefined ? { workflowStepId: input.workflowStepId } : {}),
      title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ownerBotId: input.ownerBotId,
      status: initialStatus,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    }
    await table.put(task.id, task)
    return task
  }

  async function updateTask(input: UpdateTaskInput): Promise<Task> {
    const cur = table.get(input.id)
    if (!cur) throw new Error(`任务不存在：${input.id}`)
    // 已完成的任务不允许改字段（终态只读）
    if (cur.status === 'done') throw new Error('已完成的任务不可再修改')
    const next: Task = {
      ...cur,
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.ownerBotId !== undefined ? { ownerBotId: input.ownerBotId } : {}),
      updatedAt: nowIso(),
    }
    await table.put(next.id, next)
    return next
  }

  async function transitionStatus(id: string, to: TaskStatus): Promise<Task> {
    if (!(to in TASK_STATUS_LABELS)) throw new Error(`非法目标状态：${to}`)
    const cur = table.get(id)
    if (!cur) throw new Error(`任务不存在：${id}`)
    if (cur.status === to) return cur // 幂等：相同状态不报错
    if (!canTransition(cur.status, to)) {
      throw new Error(
        `非法状态迁移：${cur.status} (${TASK_STATUS_LABELS[cur.status]}) → ${to} (${TASK_STATUS_LABELS[to]})`,
      )
    }
    const now = nowIso()
    const next: Task = {
      ...cur,
      status: to,
      updatedAt: now,
      ...(to === 'done' ? { completedAt: now } : {}),
    }
    await table.put(next.id, next)
    return next
  }

  async function setStatus(id: string, to: TaskStatus): Promise<Task> {
    if (!(to in TASK_STATUS_LABELS)) throw new Error(`非法目标状态：${to}`)
    const cur = table.get(id)
    if (!cur) throw new Error(`任务不存在：${id}`)
    if (cur.status === to) return cur // 幂等：相同状态不报错
    // done 是终态，不允许改出去；done → done 已在上面幂等返回
    if (cur.status === 'done') {
      throw new Error(`已完成的任务不可再改状态（${TASK_STATUS_LABELS.done}）：${id}`)
    }
    const now = nowIso()
    const next: Task = {
      ...cur,
      status: to,
      updatedAt: now,
      ...(to === 'done' ? { completedAt: now } : {}),
    }
    await table.put(next.id, next)
    return next
  }

  async function deleteTask(id: string): Promise<void> {
    const existed = await table.delete(id)
    if (!existed) throw new Error(`任务不存在：${id}`)
  }

  return {
    listByWorkspace,
    listByOwnerBot,
    getTask,
    listByWorkflowStep,
    createTask,
    updateTask,
    transitionStatus,
    setStatus,
    deleteTask,
  }
}
