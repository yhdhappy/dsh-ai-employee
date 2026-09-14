/**
 * 持久化域定义。
 *
 * 用 Harness 自带 storageDomain 实现。一个统一的域（`ai_employee`）承载
 * 所有持久化记录：
 *   Phase 1：workspace / bot / bot_template
 *   Phase 2：workflow / task / audit_event
 *
 * 遵循 Phase 0 验证的约束：
 * - 域名必须匹配 `^[a-z][a-z0-9_]*$`，否则 `invalid unit name`。
 * - 表 schema 必须是带 `.parse()` 契约的校验器（不能 import 真 zod）。
 * - 数据落到 `~/.dsh/storages/<name>.json`，重启不丢。
 * - 域版本号 version=1；加表不算破坏（向后兼容），只有改字段语义才升 version。
 */

import type {
  Workspace,
  Bot,
  BotTemplate,
  Workflow,
  Task,
  AuditEvent,
} from './schemas.js'
import {
  workspaceValidator,
  botValidator,
  botTemplateValidator,
  workflowValidator,
  taskValidator,
  auditEventValidator,
} from './schemas.js'

/** 统一存储域名（合法小写格式）。 */
export const DOMAIN_NAME = 'ai_employee'
export const TABLE_WORKSPACE = 'workspace'
export const TABLE_BOT = 'bot'
export const TABLE_TEMPLATE = 'bot_template'
export const TABLE_WORKFLOW = 'workflow'
export const TABLE_TASK = 'task'
export const TABLE_AUDIT = 'audit_event'

/** storageDomain 暴露的 table 操作接口（按 Inspect 结果裁剪需要的方法）。 */
type DomainTable<V> = {
  get(key: string): V | undefined
  put(key: string, value: V): Promise<void>
  update(key: string, fn: (cur: V) => V): Promise<V>
  delete(key: string): Promise<boolean>
  entries(): IterableIterator<[string, V]>
}

type DomainHandle = {
  table(name: string): DomainTable<unknown>
  close(): Promise<void>
}

export interface AiEmployeeStore {
  readonly workspace: DomainTable<Workspace>
  readonly bot: DomainTable<Bot>
  readonly bot_template: DomainTable<BotTemplate>
  readonly workflow: DomainTable<Workflow>
  readonly task: DomainTable<Task>
  readonly audit_event: DomainTable<AuditEvent>
  close(): Promise<void>
}

/**
 * 打开 AI 员工持久化域。
 * @param storageDomain  ctx.get('storageDomain') 拿到的服务实例
 */
export async function openAiEmployeeStore(
  storageDomain: { open(spec: unknown): Promise<unknown> },
): Promise<AiEmployeeStore> {
  const spec = {
    name: DOMAIN_NAME,
    version: 1,
    tables: {
      [TABLE_WORKSPACE]: { valueSchema: workspaceValidator },
      [TABLE_BOT]: { valueSchema: botValidator },
      [TABLE_TEMPLATE]: { valueSchema: botTemplateValidator },
      [TABLE_WORKFLOW]: { valueSchema: workflowValidator },
      [TABLE_TASK]: { valueSchema: taskValidator },
      [TABLE_AUDIT]: { valueSchema: auditEventValidator },
    },
  }

  const domain = (await storageDomain.open(spec)) as DomainHandle
  const wsTable = domain.table(TABLE_WORKSPACE) as unknown as DomainTable<Workspace>
  const botTable = domain.table(TABLE_BOT) as unknown as DomainTable<Bot>
  const tmplTable = domain.table(TABLE_TEMPLATE) as unknown as DomainTable<BotTemplate>
  const wfTable = domain.table(TABLE_WORKFLOW) as unknown as DomainTable<Workflow>
  const taskTable = domain.table(TABLE_TASK) as unknown as DomainTable<Task>
  const auditTable = domain.table(TABLE_AUDIT) as unknown as DomainTable<AuditEvent>

  return {
    workspace: wsTable,
    bot: botTable,
    bot_template: tmplTable,
    workflow: wfTable,
    task: taskTable,
    audit_event: auditTable,
    async close() {
      await domain.close()
    },
  }
}