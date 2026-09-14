/**
 * 审计事件服务（AuditService）。
 *
 * 文档对齐：V0.2 §22 AuditEvent。
 * 字段、含义与文档保持一致：actorType / actorId / action / resourceType / resourceId / metadata / timestamp。
 *
 * 写入接口：`record(input)` —— 各业务服务调用，**失败不应该阻断主流程**（best-effort 写）。
 * 查询接口：`listEvents(query)` —— 默认按时间倒序，支持 since / action 过滤。
 *
 * 跨 workspace 隔离：默认只查传入的 workspaceId，外部无 workspaceId 时不允许查"全部"。
 */

import type { AuditEvent, AuditActorType } from '../storage/schemas.js'
import type { AiEmployeeStore } from '../storage/domain.js'

function nowIso(): string {
  return new Date().toISOString()
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export interface RecordAuditInput {
  workspaceId: string
  actorType: AuditActorType
  actorId: string
  action: string
  resourceType: string
  resourceId: string
  metadata?: Record<string, unknown>
}

export interface ListAuditQuery {
  workspaceId: string
  /** 起始时间（含）；ISO 字符串。 */
  since?: string
  /** 过滤 action（精确匹配）。 */
  action?: string
  /** 最多返回多少条；默认 50，上限 1000。 */
  limit?: number
}

export interface AuditService {
  /**
   * 记录一条审计事件。**容错**：写失败只 console.warn，不抛错（审计不应该阻断主流程）。
   */
  record(input: RecordAuditInput): Promise<void>
  /**
   * 列审计事件。按时间倒序（最新在前）。
   * 必须传 workspaceId；不传就抛错（防止误跨项目读取）。
   */
  listEvents(query: ListAuditQuery): Promise<AuditEvent[]>
}

export function createAuditService(store: AiEmployeeStore): AuditService {
  const table = store.audit_event

  async function record(input: RecordAuditInput): Promise<void> {
    const event: AuditEvent = {
      id: genId('aud'),
      workspaceId: input.workspaceId,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: input.metadata ?? {},
      timestamp: nowIso(),
    }
    try {
      await table.put(event.id, event)
    } catch (e) {
      // best-effort：审计失败不抛
      console.warn('[audit] 写审计事件失败：', e instanceof Error ? e.message : String(e))
    }
  }

  async function listEvents(query: ListAuditQuery): Promise<AuditEvent[]> {
    if (!query.workspaceId) {
      throw new Error('listEvents 必须传 workspaceId')
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 1000)
    const all: AuditEvent[] = []
    for (const [, e] of table.entries()) {
      if (e.workspaceId !== query.workspaceId) continue
      if (query.action !== undefined && e.action !== query.action) continue
      if (query.since !== undefined && e.timestamp < query.since) continue
      all.push(e)
    }
    // 时间倒序
    all.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
    return all.slice(0, limit)
  }

  return { record, listEvents }
}