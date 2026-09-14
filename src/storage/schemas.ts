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