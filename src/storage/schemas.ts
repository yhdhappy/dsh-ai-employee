/**
 * 实体数据模型与校验。
 *
 * 所有持久化记录在此定义结构。为了解决"插件是纯 JS 环境、不能 import 真 zod"
 * 的约束，这里用一个满足 zod `.parse()` 契约的最小校验器（`mkValidator`），
 * 并配合 Harness storageDomain 的 `valueSchema` 使用。
 */

/** 建一个符合 zod `.parse()` 契约的校验器：可成功返回 v，失败抛错。 */
export type RecordValidator<T> = {
  parse(raw: unknown): T
}

/** 校验函数：返回 true 表示通过，否则失败（普通 boolean 即可）。 */
type ShapeFn<T> = (raw: unknown) => boolean

/** 由校验函数构造一个带 `.parse()` 的"准 zod"校验器。 */
export function mkValidator<T>(shape: ShapeFn<T>, label: string): RecordValidator<T> {
  return {
    parse(raw: unknown): T {
      if (!shape(raw)) {
        throw new Error(`${label}: schema mismatch: ${JSON.stringify(raw)}`)
      }
      return raw as T
    },
  }
}

/** 基础对象判断。 */
function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString)
}

// ---------------------------------------------------------------
// 项目工作区（Workspace）
// ---------------------------------------------------------------

export type WorkspaceStatus = 'active' | 'archived' | 'deleted'

export interface Workspace {
  id: string
  /** 项目名（用户可改）。 */
  name: string
  /** 项目根目录绝对路径。 */
  rootPath: string
  /** 项目记忆路径，默认 `<rootPath>/docs`。 */
  memoryPath: string
  /** 三态：活跃 / 归档 / 删除。 */
  status: WorkspaceStatus
  /** 软删除时间。 */
  deletedAt?: string
  /** 软删除后真正清除的时间（30 天后）。 */
  deleteScheduledPurgeAt?: string
  /** 所属用户。 */
  ownerUserId: string
  /** 默认总顾问 Bot id（若已建）。 */
  defaultAdvisorBotId?: string
  createdAt: string
  updatedAt: string
}

const isWorkspaceStatus = (v: unknown): v is WorkspaceStatus =>
  v === 'active' || v === 'archived' || v === 'deleted'

export const workspaceValidator = mkValidator<Workspace>((raw) => {
  if (!isObject(raw)) return false
  return (
    isString(raw.id) &&
    isString(raw.name) &&
    isString(raw.rootPath) &&
    isString(raw.memoryPath) &&
    isWorkspaceStatus(raw.status) &&
    isString(raw.ownerUserId) &&
    isString(raw.createdAt) &&
    isString(raw.updatedAt)
  )
}, 'workspace')

// ---------------------------------------------------------------
// AI 员工（Bot）
// ---------------------------------------------------------------

export type BotStatus = 'active' | 'paused' | 'archived'

export interface Bot {
  id: string
  workspaceId: string
  /** 员工名（用户可改）。 */
  name: string
  /** 职位 / 角色标签，如"总顾问"。 */
  role: string
  /** 对员工的简介。 */
  description: string
  /** 关联的执行 Provider（Phase 0-5 统一用 Harness 引擎，名称如 'pi'）。 */
  providerId: string
  /** 模型 id。 */
  modelId: string
  /** 关联的执行 Runtime。 */
  runtimeId: string
  /** 系统提示词，默认从样板继承，用户可改。 */
  systemPrompt: string
  /** 工作规则，用户可增删改。 */
  workingRules: string[]
  /** 状态。 */
  status: BotStatus
  /** 基于哪个样板创建。 */
  templateId?: string
  /** 由谁创建：user 或 bot。 */
  createdBy: 'user' | 'bot'
  createdAt: string
  updatedAt: string
}

const isBotStatus = (v: unknown): v is BotStatus =>
  v === 'active' || v === 'paused' || v === 'archived'

export const botValidator = mkValidator<Bot>((raw) => {
  if (!isObject(raw)) return false
  return (
    isString(raw.id) &&
    isString(raw.workspaceId) &&
    isString(raw.name) &&
    isString(raw.role) &&
    isString(raw.description) &&
    isString(raw.providerId) &&
    isString(raw.modelId) &&
    isString(raw.runtimeId) &&
    isString(raw.systemPrompt) &&
    isStringArray(raw.workingRules) &&
    isBotStatus(raw.status) &&
    (raw.createdBy === 'user' || raw.createdBy === 'bot') &&
    isString(raw.createdAt) &&
    isString(raw.updatedAt)
  )
}, 'bot')

// ---------------------------------------------------------------
// Bot 样板（BotTemplate）
// ---------------------------------------------------------------

export interface BotTemplate {
  id: string
  /** 样板显示名，如"总顾问"。 */
  name: string
  /** 职位 / 角色。 */
  role: string
  /** 简介（"能干啥、不能干啥"）。 */
  description: string
  /** 默认系统提示词。 */
  systemPrompt: string
  /** 默认工作规则。 */
  workingRules: string[]
}

export const botTemplateValidator = mkValidator<BotTemplate>((raw) => {
  if (!isObject(raw)) return false
  return (
    isString(raw.id) &&
    isString(raw.name) &&
    isString(raw.role) &&
    isString(raw.description) &&
    isString(raw.systemPrompt) &&
    isStringArray(raw.workingRules)
  )
}, 'bot_template')

// ---------------------------------------------------------------
// 工作流（Workflow）+ 工作流步骤（WorkflowStep）
// 文档对齐：V0.3 §13 工作流用户自定义；V0.1 对齐说明 §18 已对齐项。
// ---------------------------------------------------------------

export interface WorkflowStep {
  /** 步骤 id（同一 workflow 内唯一）。 */
  id: string
  /** 显示/排序顺序（小 → 大）。segment 1 同时保留 order 和 nextStepId：
   *  order 用于排序展示，nextStepId 用于运行时显式跳转（可跳跃、可分支）。 */
  order: number
  /** 谁来做（哪个 Bot）。如果为空表示"等用户决策"。 */
  workerBotId?: string
  /** 下一步 id。如果为空表示流程结束。 */
  nextStepId?: string
  /** 这一步做什么（人话描述）。 */
  description?: string
}

export interface Workflow {
  id: string
  workspaceId: string
  /** 工作流名（用户起的，例如"开发→审核→汇报"）。 */
  name: string
  /** 步骤列表（不一定按 order 排序，由调用方决定展示顺序）。 */
  steps: WorkflowStep[]
  createdAt: string
  updatedAt: string
}

export const workflowStepValidator = mkValidator<WorkflowStep>((raw) => {
  if (!isObject(raw)) return false
  return (
    isString(raw.id) &&
    typeof raw.order === 'number' &&
    (raw.workerBotId === undefined || isString(raw.workerBotId)) &&
    (raw.nextStepId === undefined || isString(raw.nextStepId)) &&
    (raw.description === undefined || isString(raw.description))
  )
}, 'workflow_step')

export const workflowValidator = mkValidator<Workflow>((raw) => {
  if (!isObject(raw)) return false
  if (!Array.isArray(raw.steps)) return false
  // 每一步都过校验器
  for (const step of raw.steps) {
    if (!workflowStepValidator.parse(step as unknown)) return false
  }
  return (
    isString(raw.id) &&
    isString(raw.workspaceId) &&
    isString(raw.name) &&
    isString(raw.createdAt) &&
    isString(raw.updatedAt)
  )
}, 'workflow')

// ---------------------------------------------------------------
// 任务（Task）
// 文档对齐：V0.3 §15（Task 是工作单）、§16（Task ≠ Session）、§18（任务状态）。
// ---------------------------------------------------------------

export type TaskStatus =
  | 'planned'         // 已规划
  | 'ready'           // 可开始
  | 'developing'      // 开发中
  | 'dev_done'        // 开发完成
  | 'reviewing'       // 审核中
  | 'changes_req'     // 需修改
  | 're_reviewing'    // 再审核
  | 'pass'            // 审核通过
  | 'wait_owner'      // 等待用户决策
  | 'done'            // 完成
  | 'blocked'         // 阻塞

/** TaskStatus 的中文显示（V0.3 §18："界面显示中文即可"）。 */
export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  planned: '已规划',
  ready: '可开始',
  developing: '开发中',
  dev_done: '开发完成',
  reviewing: '审核中',
  changes_req: '需修改',
  re_reviewing: '再审核',
  pass: '审核通过',
  wait_owner: '等待用户决策',
  done: '完成',
  blocked: '阻塞',
}

export interface Task {
  id: string
  workspaceId: string
  /** 所属模块（V0.3 §14；segment 1 不引入 Module 实体，先占位字符串）。 */
  moduleId?: string
  /** 工作流绑定（可选）。 */
  workflowId?: string
  /** 工作流步骤绑定（可选）。 */
  workflowStepId?: string
  /** 任务标题（人话）。 */
  title: string
  /** 任务说明/规格。 */
  description?: string
  /** 谁负责执行（Bot id）。 */
  ownerBotId: string
  /** 任务状态。 */
  status: TaskStatus
  /** 由谁创建。 */
  createdBy: 'user' | 'bot'
  createdAt: string
  updatedAt: string
  /** 完成时间（status=done 时填）。 */
  completedAt?: string
}

const TASK_STATUS_VALUES: readonly TaskStatus[] = [
  'planned', 'ready', 'developing', 'dev_done', 'reviewing',
  'changes_req', 're_reviewing', 'pass', 'wait_owner', 'done', 'blocked',
]
const isTaskStatus = (v: unknown): v is TaskStatus =>
  typeof v === 'string' && (TASK_STATUS_VALUES as readonly string[]).includes(v)

export const taskValidator = mkValidator<Task>((raw) => {
  if (!isObject(raw)) return false
  return (
    isString(raw.id) &&
    isString(raw.workspaceId) &&
    (raw.moduleId === undefined || isString(raw.moduleId)) &&
    (raw.workflowId === undefined || isString(raw.workflowId)) &&
    (raw.workflowStepId === undefined || isString(raw.workflowStepId)) &&
    isString(raw.title) &&
    (raw.description === undefined || isString(raw.description)) &&
    isString(raw.ownerBotId) &&
    isTaskStatus(raw.status) &&
    (raw.createdBy === 'user' || raw.createdBy === 'bot') &&
    isString(raw.createdAt) &&
    isString(raw.updatedAt) &&
    (raw.completedAt === undefined || isString(raw.completedAt))
  )
}, 'task')

// ---------------------------------------------------------------
// 审计事件（AuditEvent）
// 文档对齐：V0.2 §22 AuditEvent。原文 metadata 是必填 Record<string, unknown>，
// 这里允许 undefined（自动归一为 {}）以减少调用方负担。
// ---------------------------------------------------------------

export type AuditActorType = 'user' | 'bot' | 'system'

export interface AuditEvent {
  id: string
  workspaceId: string
  actorType: AuditActorType
  actorId: string
  action: string
  resourceType: string
  resourceId: string
  metadata: Record<string, unknown>
  timestamp: string
}

const isActorType = (v: unknown): v is AuditActorType =>
  v === 'user' || v === 'bot' || v === 'system'

export const auditEventValidator = mkValidator<AuditEvent>((raw) => {
  if (!isObject(raw)) return false
  // metadata 允许 undefined 或 Record；运行时归一为 {}
  const meta = raw.metadata
  if (meta !== undefined && (typeof meta !== 'object' || meta === null || Array.isArray(meta))) {
    return false
  }
  return (
    isString(raw.id) &&
    isString(raw.workspaceId) &&
    isActorType(raw.actorType) &&
    isString(raw.actorId) &&
    isString(raw.action) &&
    isString(raw.resourceType) &&
    isString(raw.resourceId) &&
    isString(raw.timestamp)
  )
}, 'audit_event')