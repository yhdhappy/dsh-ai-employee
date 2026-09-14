/**
 * AI 员工（Bot）服务。
 *
 * Phase 1 后端核心之一：增 / 改 / 查 + 删除权限墙。
 *
 * 权限墙（对齐 V0.2 §18 与产品 §7）：删除员工只有用户能做，任何 Bot 都能被拒绝。
 * 这里用调用方角色（Actor）来强制：deleteBot 只接受 'user'，'bot' 一律拒绝。
 */

import type { Bot, BotStatus, BotTemplate } from '../storage/schemas.js'
import type { AiEmployeeStore } from '../storage/domain.js'
import { allTemplates } from '../core/template-service.js'

/** 调用方角色：用户 / Bot。 */
export type Actor = { kind: 'user'; userId: string } | { kind: 'bot'; botId: string }

export interface CreateBotInput {
  workspaceId: string
  /** 样板 id，可为空（从零自建）。 */
  templateId?: string
  /** 员工名。 */
  name: string
  /** 职位 / 角色。 */
  role: string
  /** 简介（可改）。 */
  description?: string
  /** 系统提示词（可改）。 */
  systemPrompt?: string
  /** 工作规则（可改）。 */
  workingRules?: string[]
  /** 调用方角色，决定是否能创建。 */
  actor: Actor
}

export interface UpdateBotInput {
  id: string
  templateId?: string
  updater: {
    name?: string
    role?: string
    description?: string
    systemPrompt?: string
    workingRules?: string[]
    providerId?: string
    modelId?: string
    status?: BotStatus
  }
  actor: Actor
}

export interface BotService {
  /** 列出某个项目的全部员工。 */
  listBotsByWorkspace(workspaceId: string): Bot[]
  getBot(id: string): Bot | undefined
  /** 增：可从样板建，或从零自建。返回新建的 Bot。 */
  createBot(input: CreateBotInput): Promise<Bot>
  /** 改：修改员工任意字段。 */
  updateBot(input: UpdateBotInput): Promise<Bot>
  /**
   * 删：权限墙——只有 user 能删；bot 调用一律拒绝。
   * 对照 V0.3 §7：任何 Bot 都无权删除员工，包括总顾问。
   */
  deleteBot(id: string, actor: Actor): Promise<void>
}

/** 员工当前默认执行 Provider（Phase 0-5 统一委托 Harness 引擎，命名用 'pi'）。 */
const DEFAULT_PROVIDER_ID = 'pi'
/** 员工默认模型（读不到就占位，Phase 2 起关联真实模型选择）。 */
const DEFAULT_MODEL_ID = ''

export function createBotService(store: AiEmployeeStore): BotService {
  const table = store.bot

  function listBotsByWorkspace(workspaceId: string): Bot[] {
    const out: Bot[] = []
    for (const [, b] of table.entries()) {
      if (b.workspaceId === workspaceId) out.push(b)
    }
    return out
  }

  function getBot(id: string): Bot | undefined {
    return table.get(id)
  }

  async function createBot(input: CreateBotInput): Promise<Bot> {
    const name = input.name.trim()
    if (!name) throw new Error('员工名不能为空')
    if (!input.workspaceId) throw new Error('必须指定所属项目')

    // 从样板继承配置（如果有样板）
    const template: BotTemplate | undefined =
      input.templateId !== undefined
        ? (allTemplates().find((t) => t.id === input.templateId) ?? undefined)
        : undefined
    const role = input.role.trim() || (template ? template.role : '员工')
    const description =
      input.description?.trim() ??
      template?.description ??
      `${role}（AI 员工）`
    const systemPrompt = input.systemPrompt?.trim() || template?.systemPrompt || ''
    const workingRules = input.workingRules ?? template?.workingRules ?? []

    const now = new Date().toISOString()
    const bot: Bot = {
      id: `bot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId: input.workspaceId,
      name,
      role,
      description,
      providerId: DEFAULT_PROVIDER_ID,
      modelId: DEFAULT_MODEL_ID,
      runtimeId: 'local',
      systemPrompt,
      workingRules,
      status: 'active',
      templateId: template ? template.id : undefined,
      createdBy: input.actor.kind,
      createdAt: now,
      updatedAt: now,
    }
    await table.put(bot.id, bot)
    return bot
  }

  async function updateBot(input: UpdateBotInput): Promise<Bot> {
    const cur = table.get(input.id)
    if (!cur) throw new Error(`员工不存在：${input.id}`)
    const u = input.updater
    const next: Bot = {
      ...cur,
      ...(u.name !== undefined ? { name: u.name } : {}),
      ...(u.role !== undefined ? { role: u.role } : {}),
      ...(u.description !== undefined ? { description: u.description } : {}),
      ...(u.systemPrompt !== undefined ? { systemPrompt: u.systemPrompt } : {}),
      ...(u.workingRules !== undefined ? { workingRules: u.workingRules } : {}),
      ...(u.providerId !== undefined ? { providerId: u.providerId } : {}),
      ...(u.modelId !== undefined ? { modelId: u.modelId } : {}),
      ...(u.status !== undefined ? { status: u.status } : {}),
      updatedAt: new Date().toISOString(),
    }
    await table.put(next.id, next)
    return next
  }

  async function deleteBot(id: string, actor: Actor): Promise<void> {
    // 权限墙：只有 user 能删员工（对照 V0.3 §7.4，任何 Bot 都无权删除，包括总顾问）
    if (actor.kind === 'bot') {
      throw Object.assign(new Error(`删除员工仅用户可执行（Bot「${actor.botId}」无权删除）。`), {
        code: 'PERMISSION_DENIED',
        permission: 'canDeleteBot',
      })
    }
    const existed = await table.delete(id)
    if (!existed) throw new Error(`员工不存在：${id}`)
  }

  return { listBotsByWorkspace, getBot, createBot, updateBot, deleteBot }
}