/**
 * 工作流（Workflow）服务。
 *
 * Phase 2 第一段：CRUD + 步骤查询（用于 segment 2 的工作流触发）。
 * 业务规则：
 *   - workflow.steps 内每一步的 id 在同一 workflow 内唯一
 *   - nextStepId（如果有）必须指向同一 workflow 的某一步
 *   - 删除项目时不级联删 workflow（项目是边界，soft-delete 由项目层处理）
 */

import type { Workflow, WorkflowStep } from '../storage/schemas.js'
import type { AiEmployeeStore } from '../storage/domain.js'

function nowIso(): string {
  return new Date().toISOString()
}

export interface CreateWorkflowInput {
  workspaceId: string
  name: string
  steps: WorkflowStep[]
}

export interface UpdateWorkflowInput {
  id: string
  name?: string
  steps?: WorkflowStep[]
}

export interface WorkflowService {
  listByWorkspace(workspaceId: string): Workflow[]
  getWorkflow(id: string): Workflow | undefined
  /** 取某个工作流的全部步骤（按 order 升序）。 */
  listSteps(workflowId: string): WorkflowStep[]
  /** 按 id 取一个步骤。 */
  getStep(workflowId: string, stepId: string): WorkflowStep | undefined
  /** 取下一步步骤（按 nextStepId 跳转；末尾返回 undefined）。 */
  getNextStep(workflowId: string, currentStepId: string): WorkflowStep | undefined
  createWorkflow(input: CreateWorkflowInput): Promise<Workflow>
  updateWorkflow(input: UpdateWorkflowInput): Promise<Workflow>
  deleteWorkflow(id: string): Promise<void>
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 校验一个 workflow 的步骤内 id 唯一 + nextStepId 指向合法目标。 */
function validateSteps(steps: WorkflowStep[]): void {
  const ids = new Set<string>()
  for (const s of steps) {
    if (ids.has(s.id)) {
      throw new Error(`工作流步骤 id "${s.id}" 重复`)
    }
    ids.add(s.id)
  }
  for (const s of steps) {
    if (s.nextStepId !== undefined && !ids.has(s.nextStepId)) {
      throw new Error(
        `工作流步骤 "${s.id}" 的 nextStepId "${s.nextStepId}" 不在本工作流的步骤集合内`,
      )
    }
  }
}

export function createWorkflowService(store: AiEmployeeStore): WorkflowService {
  const table = store.workflow

  function listByWorkspace(workspaceId: string): Workflow[] {
    const out: Workflow[] = []
    for (const [, wf] of table.entries()) {
      if (wf.workspaceId === workspaceId) out.push(wf)
    }
    return out
  }

  function getWorkflow(id: string): Workflow | undefined {
    return table.get(id)
  }

  function listSteps(workflowId: string): WorkflowStep[] {
    const wf = table.get(workflowId)
    if (!wf) return []
    return [...wf.steps].sort((a, b) => a.order - b.order)
  }

  function getStep(workflowId: string, stepId: string): WorkflowStep | undefined {
    const wf = table.get(workflowId)
    if (!wf) return undefined
    return wf.steps.find((s) => s.id === stepId)
  }

  function getNextStep(workflowId: string, currentStepId: string): WorkflowStep | undefined {
    const cur = getStep(workflowId, currentStepId)
    if (!cur || cur.nextStepId === undefined) return undefined
    return getStep(workflowId, cur.nextStepId)
  }

  async function createWorkflow(input: CreateWorkflowInput): Promise<Workflow> {
    if (!input.workspaceId) throw new Error('workspaceId 不能为空')
    const name = input.name.trim()
    if (!name) throw new Error('name 不能为空')
    if (!Array.isArray(input.steps)) throw new Error('steps 必须是数组')
    if (input.steps.length === 0) throw new Error('工作流至少要有一个步骤')
    validateSteps(input.steps)

    const now = nowIso()
    const wf: Workflow = {
      id: genId('wf'),
      workspaceId: input.workspaceId,
      name,
      steps: input.steps,
      createdAt: now,
      updatedAt: now,
    }
    await table.put(wf.id, wf)
    return wf
  }

  async function updateWorkflow(input: UpdateWorkflowInput): Promise<Workflow> {
    const cur = table.get(input.id)
    if (!cur) throw new Error(`工作流不存在：${input.id}`)
    const next: Workflow = {
      ...cur,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.steps !== undefined ? { steps: input.steps } : {}),
      updatedAt: nowIso(),
    }
    if (input.steps !== undefined) {
      if (input.steps.length === 0) throw new Error('工作流至少要有一个步骤')
      validateSteps(next.steps)
    }
    await table.put(next.id, next)
    return next
  }

  async function deleteWorkflow(id: string): Promise<void> {
    const existed = await table.delete(id)
    if (!existed) throw new Error(`工作流不存在：${id}`)
  }

  return {
    listByWorkspace,
    getWorkflow,
    listSteps,
    getStep,
    getNextStep,
    createWorkflow,
    updateWorkflow,
    deleteWorkflow,
  }
}